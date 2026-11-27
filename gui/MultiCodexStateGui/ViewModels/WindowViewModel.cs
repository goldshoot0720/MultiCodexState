using System.Globalization;
using Avalonia.Media;
using MultiCodexStateGui.Models;

namespace MultiCodexStateGui.ViewModels;

/// <summary>
/// One rate-limit window cell (a "5h", a "weekly", a "monthly", …).
///
/// Immutable after construction: the list is rebuilt wholesale on every
/// refresh, so there is no point carrying change notification here.
///
/// This is the piece that makes the GUI plan-agnostic. Codex ships a 5h + 7d
/// pair on paid plans but a single 30-day window on free, so the card renders
/// however many cells the payload actually produced — side by side on one row,
/// never two hard-coded bars.
/// </summary>
public class WindowViewModel
{
    private static readonly IBrush BrushGray = new SolidColorBrush(Color.Parse("#A4AFB7"));
    private static readonly IBrush BrushYellow = new SolidColorBrush(Color.Parse("#D8B678"));
    private static readonly IBrush BrushRed = new SolidColorBrush(Color.Parse("#E29A96"));

    public WindowViewModel(UsageWindowInfo info, bool noCapReported)
    {
        Label = string.IsNullOrWhiteSpace(info.Label) ? "window" : info.Label!;
        UsedPercent = info.UsedPercent;
        RemainingPercent = info.RemainingPercent;
        ResetAt = info.ResetAt;
        NoCap = noCapReported;
    }

    public string Label { get; }

    public double? UsedPercent { get; }

    public double? RemainingPercent { get; }

    /// <summary>Epoch milliseconds, or null when the payload gave no reset time.</summary>
    public long? ResetAt { get; }

    private bool NoCap { get; }

    /// <summary>
    /// A plan with no reported allowance renders "0.0%" (like the Codex CLI),
    /// never a blank dash, so the bar never looks broken. A genuinely missing
    /// reading on a plan that *does* report windows stays "—".
    /// </summary>
    public string PercentText
    {
        get
        {
            if (UsedPercent.HasValue) return $"{UsedPercent.Value:F1}%";
            return NoCap ? "0.0%" : "\u2014";
        }
    }

    public double PercentValue => UsedPercent ?? 0;

    public bool IsElevated => UsedPercent is >= 70 and < 90;

    public bool IsCritical => UsedPercent >= 90;

    public string RemainingText =>
        RemainingPercent.HasValue ? $"{RemainingPercent.Value:F1}% remaining" : string.Empty;

    public bool HasRemaining => RemainingPercent.HasValue;

    /// <summary>
    /// "Resets: October 18, 21:37, 2026 (in 6d 3h)" — the same string the CLI
    /// prints, built from epoch milliseconds (what the CLI normalises every
    /// representation into). The year is always included: a weekly window can
    /// roll over into next month, and "Nov 30" alone is ambiguous once it does.
    /// </summary>
    public string ResetText
    {
        get
        {
            if (ResetAt == null) return string.Empty;

            var local = DateTimeOffset.FromUnixTimeMilliseconds(ResetAt.Value).ToLocalTime();
            // InvariantCulture: the month must read "October" on every machine,
            // matching MONTH_NAMES in src/usage.js, not the OS locale.
            var when = $"{local.ToString("MMMM d, HH:mm", CultureInfo.InvariantCulture)}, {local.Year}";

            var remaining = local - DateTimeOffset.Now;
            if (remaining <= TimeSpan.Zero) return $"Resets: {when} (imminent)";

            // Same shape as formatCountdown() in src/usage.js: the largest unit
            // plus the next one down, floored so the two never disagree.
            var days = (int)remaining.TotalDays;
            var countdown = days > 0
                ? $"{days}d {remaining.Hours}h"
                : remaining.Hours > 0
                    ? $"{remaining.Hours}h {remaining.Minutes}m"
                    : $"{remaining.Minutes}m";

            return $"Resets: {when} (in {countdown})";
        }
    }

    public bool HasReset => ResetAt != null;

    /// <summary>Mirrors the CLI: yellow inside a day, red once due.</summary>
    public IBrush ResetColor
    {
        get
        {
            if (ResetAt == null) return BrushGray;
            var delta = ResetAt.Value - DateTimeOffset.Now.ToUnixTimeMilliseconds();
            if (delta <= 0) return BrushRed;
            if (delta <= 86_400_000) return BrushYellow;
            return BrushGray;
        }
    }
}
