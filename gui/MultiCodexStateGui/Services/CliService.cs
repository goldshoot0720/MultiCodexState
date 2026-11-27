using System.Diagnostics;
using System.Text.Json;
using MultiCodexStateGui.Models;

namespace MultiCodexStateGui.Services;

/// <summary>
/// Shells out to the <c>MultiCodexState</c> CLI and parses JSON output.
///
/// The GUI deliberately does not read <c>auth.json</c> or talk to the usage
/// endpoint itself: the CLI is the single source of truth for auth, quota and
/// token refresh, so there is exactly one implementation to keep correct.
/// </summary>
public class CliService
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    // Event raised when an interactive command finishes so the VM can refresh.
    public event EventHandler? InteractiveCommandCompleted;

    /// <summary>
    /// Run a CLI command with stdout/stderr captured (non-interactive use).
    /// Returns stdout text. Throws on non-zero exit.
    /// </summary>
    public async Task<string> RunCapturedAsync(string arguments)
    {
        var (cmd, args) = ResolveCommand(arguments);
        var psi = new ProcessStartInfo
        {
            FileName = cmd,
            Arguments = args,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            // The CLI emits UTF-8. Without this, .NET decodes redirected output
            // with the machine's ANSI code page (e.g. CP950), which mangles CJK
            // names badly enough to swallow JSON quotes and break parsing.
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        psi.EnvironmentVariables["CODEX_NO_UPDATE_CHECK"] = "1";

        using var proc = new Process { StartInfo = psi };
        try
        {
            proc.Start();
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // A Finder-launched app has no shell PATH, so a bare command name
            // fails with "no such file or directory" long before the CLI can
            // say anything useful. Name the fix instead of the symptom.
            throw new Exception(
                $"MultiCodexState CLI not found ('{cmd}'). Install it, or point MULTICODEXSTATE_CLI at bin/multicodexstate.js. ({ex.Message})");
        }

        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();
        await proc.WaitForExitAsync();

        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        if (proc.ExitCode != 0)
        {
            var msg = string.IsNullOrWhiteSpace(stderr)
                ? $"MultiCodexState {arguments} exited with code {proc.ExitCode}"
                : stderr.Trim();
            throw new Exception(msg);
        }

        return stdout;
    }

    /// <summary>
    /// Run an interactive command in a visible terminal window (login, etc.).
    /// Fires <see cref="InteractiveCommandCompleted"/> when the window closes.
    /// </summary>
    public void RunInteractive(string arguments)
    {
        var (cmd, args) = ResolveCommandInteractive(arguments);
        var psi = new ProcessStartInfo
        {
            FileName = cmd,
            Arguments = args,
            UseShellExecute = true,
            CreateNoWindow = false,
            WindowStyle = ProcessWindowStyle.Normal,
        };

        var proc = Process.Start(psi);
        if (proc == null) return;

        proc.EnableRaisingEvents = true;
        proc.Exited += (_, _) =>
            InteractiveCommandCompleted?.Invoke(this, EventArgs.Empty);
    }

    public async Task<List<AccountInfo>> GetAccountsAsync()
    {
        var json = await RunCapturedAsync("list --json");
        return JsonSerializer.Deserialize<List<AccountInfo>>(json, JsonOpts) ?? new();
    }

    public async Task<List<UsageInfo>> GetUsageAsync()
    {
        var json = await RunCapturedAsync("usage --json");
        return JsonSerializer.Deserialize<List<UsageInfo>>(json, JsonOpts) ?? new();
    }

    public async Task SwitchAsync(string name)
    {
        await RunCapturedAsync($"switch \"{name}\"");
    }

    public void Login(string? name)
    {
        var arg = string.IsNullOrWhiteSpace(name) ? "login" : $"login {name}";
        RunInteractive(arg);
    }

    public void Logout(string? name, bool force)
    {
        var parts = new List<string> { "logout" };
        if (!string.IsNullOrWhiteSpace(name)) parts.Add(name);
        if (force) parts.Add("-f");
        RunInteractive(string.Join(' ', parts));
    }

    public async Task<(bool ok, string message)> UpdateAsync(bool checkOnly)
    {
        try
        {
            var arg = checkOnly ? "update --check" : "update";
            var output = await RunCapturedAsync(arg);
            return (true, output.Trim());
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    // ── Command resolution ──────────────────────────────────────────

    /// <summary>
    /// Locate the CLI entry point that lives inside this repository, so the GUI
    /// always talks to the source tree it was built from rather than a stale
    /// globally-installed copy.
    /// </summary>
    /// <summary>
    /// Finder-launched apps do not inherit a shell PATH, so <c>node</c> on
    /// Homebrew is invisible unless we look it up ourselves.
    /// </summary>
    private static string FindNode()
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir, "node");
            if (File.Exists(candidate)) return candidate;
        }

        foreach (var candidate in new[] { "/opt/homebrew/bin/node", "/usr/local/bin/node" })
        {
            if (File.Exists(candidate)) return candidate;
        }

        return "node";
    }

    private static string? FindRepoCli()
    {
        // Current name first, then the pre-rename name so a GUI binary still
        // works against an older checkout. (This project's entry point was
        // renamed from cs.js to multicodexstate.js; see README.)
        var names = new[] { "multicodexstate.js", "cs.js" };
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
        {
            foreach (var name in names)
            {
                var candidate = Path.Combine(dir.FullName, "bin", name);
                if (File.Exists(candidate)) return candidate;
            }
        }
        return null;
    }

    /// <summary>
    /// Locate a *globally installed* CLI by absolute path.
    ///
    /// A Finder-launched .app does not inherit a shell PATH — only the bare
    /// <c>/usr/bin:/bin:/usr/sbin:/sbin</c> that launchd hands out — so the
    /// command name the installers register resolves to nothing and every call
    /// dies with "no such file or directory". The installers put the code in
    /// <c>~/.multicodexstate</c> and the command in <c>~/.local/bin</c> (or the
    /// npm prefix), so look in those places directly instead of trusting PATH.
    ///
    /// Returns the executable to run plus an argument prefix (the quoted script
    /// path when the executable is node).
    /// </summary>
    private static (string fileName, string argsPrefix)? FindInstalledCli()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrEmpty(home)) return null;

        // 1. The default install directory used by all three installers.
        var entry = Path.Combine(home, ".multicodexstate", "bin", "multicodexstate.js");
        if (File.Exists(entry)) return (FindNode(), $"\"{entry}\"");

        // 2. The registered command, in every place the installers put it.
        var name = OperatingSystem.IsWindows() ? "MultiCodexState.cmd" : "MultiCodexState";
        var dirs = OperatingSystem.IsWindows()
            ? new[]
            {
                Path.Combine(home, ".local", "bin"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm"),
            }
            : new[]
            {
                Path.Combine(home, ".local", "bin"),
                "/opt/homebrew/bin",
                "/usr/local/bin",
            };

        foreach (var dir in dirs)
        {
            var candidate = Path.Combine(dir, name);
            if (File.Exists(candidate)) return (candidate, string.Empty);
        }

        return null;
    }

    /// <summary>Compose the final argument string from an optional prefix.</summary>
    private static string WithPrefix(string argsPrefix, string cliArgs) =>
        string.IsNullOrEmpty(argsPrefix) ? cliArgs : $"{argsPrefix} {cliArgs}";

    /// <summary>
    /// Resolve the executable + argument string for captured (headless) runs.
    ///
    /// Order: MULTICODEXSTATE_CLI override → repo-local CLI → globally installed
    /// CLI (absolute path) → the bare command name. The repo-local CLI wins
    /// because it is guaranteed to match the source that added the
    /// <c>--json</c> output this app depends on; the absolute install path is
    /// what makes a copy of the .app work from the Desktop or /Applications,
    /// where the repo is nowhere above the bundle.
    /// </summary>
    private (string fileName, string arguments) ResolveCommand(string cliArgs)
    {
        var over = Environment.GetEnvironmentVariable("MULTICODEXSTATE_CLI");
        if (!string.IsNullOrWhiteSpace(over))
            return (over, cliArgs);

        var repo = FindRepoCli();
        if (repo != null)
            return (FindNode(), $"\"{repo}\" {cliArgs}");

        var installed = FindInstalledCli();
        if (installed != null)
            return (installed.Value.fileName, WithPrefix(installed.Value.argsPrefix, cliArgs));

        if (OperatingSystem.IsWindows())
            return ("cmd.exe", $"/c MultiCodexState {cliArgs}");
        return ("MultiCodexState", cliArgs);
    }

    /// <summary>
    /// Resolve the command for interactive (visible terminal) runs.
    /// Appends <c>&amp; pause</c> on Windows so the window stays open long
    /// enough for the user to read the OAuth progress and any errors.
    /// </summary>
    private (string fileName, string arguments) ResolveCommandInteractive(string cliArgs)
    {
        var over = Environment.GetEnvironmentVariable("MULTICODEXSTATE_CLI");
        if (!string.IsNullOrWhiteSpace(over))
            return (over, cliArgs);

        var repo = FindRepoCli();
        if (repo != null)
        {
            if (OperatingSystem.IsWindows())
                return ("cmd.exe", $"/c node \"{repo}\" {cliArgs} & pause");
            return (FindNode(), $"\"{repo}\" {cliArgs}");
        }

        var installed = FindInstalledCli();
        if (installed != null)
        {
            var (fileName, prefix) = installed.Value;
            var args = WithPrefix(prefix, cliArgs);
            // Keep the window open on Windows so OAuth output stays readable.
            if (OperatingSystem.IsWindows()) return ("cmd.exe", $"/c {fileName} {args} & pause");
            return (fileName, args);
        }

        if (OperatingSystem.IsWindows())
            return ("cmd.exe", $"/c MultiCodexState {cliArgs} & pause");
        return ("MultiCodexState", cliArgs);
    }
}
