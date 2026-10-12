using System.Text;
using Avalonia.Media;
using MultiCodexStateGui.Models;

namespace MultiCodexStateGui.ViewModels;

/// <summary>
/// One rate-limit window row (a "5h", a "weekly", a "monthly", …).
///
/// Immutable after construction: the list is rebuilt wholesale on every
/// refresh, so there is no point carrying change notification here.
///
/// This is the piece that makes the GUI plan-agnostic. Codex ships a 5h + 7d
/// pair on paid plans but a single 30-day window on free, so the card renders
/// however many rows the payload actually produced rather than two fixed bars.
/// </summary>
public class WindowViewModel
{
    private static readonly IBrush BrushGreen = new SolidColorBrush(Color.FromRgb(0x22, 0xC5, 0x5E));
    private static readonly IBrush BrushYellow = new SolidColorBrush(Color.FromRgb(0xEA, 0xB3, 0x08));
    private static readonly IBrush BrushRed = new SolidColorBrush(Color.FromRgb(0xEF, 0x44, 0x44));
    private static readonly IBrush BrushGray = new SolidColorBrush(Color.FromRgb(0x9C, 0xA3, 0xAF));

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

    public IBrush BarColor => UsedPercent switch
    {
        >= 90 => BrushRed,
        >= 70 => BrushYellow,
        _ => BrushGreen,
    };

    public string RemainingText =>
        RemainingPercent.HasValue ? $"{RemainingPercent.Value:F1}% remaining" : string.Empty;

    public bool HasRemaining => RemainingPercent.HasValue;

    /// <summary>
    /// "Resets: Oct 18, 21:37 (in 6d 3h)" — built from epoch milliseconds,
    /// which is what the CLI normalises every representation into.
    /// </summary>
    public string ResetText
    {
        get
        {
            if (ResetAt == null) return string.Empty;
            var local = DateTimeOffset.FromUnixTimeMilliseconds(ResetAt.Value).ToLocalTime();
            var remaining = local - DateTimeOffset.Now;
            if (remaining <= TimeSpan.Zero) return "Resets now";

            var sb = new StringBuilder("Resets: ");
            sb.Append(local.ToString("MMM d, HH:mm"));

            if (remaining.TotalDays >= 1)
                sb.Append($" (in {(int)remaining.TotalDays}d {remaining.Hours}h)");
            else if (remaining.TotalHours >= 1)
                sb.Append($" (in {remaining.Hours}h {remaining.Minutes}m)");
            else
                sb.Append($" (in {remaining.Minutes}m)");

            return sb.ToString();
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
