using Avalonia;
using System;

namespace MultiCodexStateGui;

sealed class Program
{
    // Initialization code. Don't use any Avalonia, third-party APIs or any
    // SynchronizationContext-reliant code before AppMain is called: things aren't initialized
    // yet and stuff might break.
    [STAThread]
    public static int Main(string[] args)
    {
        // The standalone GUI and CLI share a filename. A CLI subcommand must
        // never open a window, because each window starts another quota refresh.
        if (args.Length > 0 && !args[0].StartsWith('-'))
        {
            Console.Error.WriteLine("The desktop app received a CLI command. Install the MultiCodexState CLI or set MULTICODEXSTATE_CLI to its executable.");
            return 2;
        }

        return BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    // Avalonia configuration, don't remove; also used by visual designer.
    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
#if DEBUG
            .WithDeveloperTools()
#endif
            .WithInterFont()
            .LogToTrace();
}
