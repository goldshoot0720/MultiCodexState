using System.Collections.ObjectModel;
using Avalonia.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using MultiCodexStateGui.Models;

namespace MultiCodexStateGui.ViewModels;

/// <summary>
/// Per-account display item that merges <see cref="AccountInfo"/> and
/// <see cref="UsageInfo"/> into observable, UI-friendly properties.
/// </summary>
public partial class AccountViewModel : ObservableObject
{
    // ── Raw identity ────────────────────────────────────────────────

    [ObservableProperty]
    private string? _name;

    [ObservableProperty]
    private string? _email;

    [ObservableProperty]
    private string? _displayName;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasPlan))]
    private string? _plan;

    // ── Token status ────────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(StatusColor))]
    private string? _status = "unknown";

    [ObservableProperty]
    private bool _isActive;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ExpiryText))]
    [NotifyPropertyChangedFor(nameof(HasExpiry))]
    private long? _expiresAt;

    // ── Rate-limit windows ──────────────────────────────────────────

    /// <summary>
    /// One row per window the payload reported. Empty on the free plan when
    /// the payload reports nothing, and two rows on plus/pro — the card does
    /// not care which, it just renders the collection.
    /// </summary>
    public ObservableCollection<WindowViewModel> Windows { get; } = new();

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasWindows))]
    private int _windowCount;

    // ── Plan-level state ────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(UsageNote))]
    [NotifyPropertyChangedFor(nameof(HasUsageNote))]
    private bool _noCapReported;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasLimitReached))]
    private bool? _limitReached;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CreditsText))]
    [NotifyPropertyChangedFor(nameof(HasCredits))]
    private CreditsInfo? _credits;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CreditsText))]
    private double? _resetCredits;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    private string? _error;

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    private bool _hasUsage;

    // ── Cached brushes (avoid allocating on every property access) ──

    private static readonly IBrush BrushGreen = new SolidColorBrush(Color.FromRgb(0x22, 0xC5, 0x5E));
    private static readonly IBrush BrushYellow = new SolidColorBrush(Color.FromRgb(0xEA, 0xB3, 0x08));
    private static readonly IBrush BrushRed = new SolidColorBrush(Color.FromRgb(0xEF, 0x44, 0x44));
    private static readonly IBrush BrushGray = new SolidColorBrush(Color.FromRgb(0x9C, 0xA3, 0xAF));

    // ── Derived display properties ─────────────────────────────────

    public IBrush StatusColor => Status switch
    {
        "valid" => BrushGreen,
        "expiring" => BrushYellow,
        "expired" => BrushRed,
        "invalid" => BrushRed,
        _ => BrushGray,
    };

    public bool HasPlan => !string.IsNullOrWhiteSpace(Plan);

    public bool HasExpiry => ExpiresAt != null;

    /// <summary>
    /// "in 5h 41m" / "expired 3m ago" — worded exactly like
    /// <c>humanExpiry()</c> in src/accounts.js so the CLI and the GUI agree.
    /// </summary>
    public string ExpiryText
    {
        get
        {
            if (ExpiresAt == null) return string.Empty;
            var secs = (long)Math.Round((ExpiresAt.Value - DateTimeOffset.Now.ToUnixTimeMilliseconds()) / 1000.0);
            if (secs < 0)
            {
                var m = (int)Math.Round(-secs / 60.0);
                return m < 60 ? $"expired {m}m ago" : $"expired {m / 60}h ago";
            }
            var h = secs / 3600;
            var mm = (secs % 3600) / 60;
            if (h >= 24) return $"in {h / 24}d {h % 24}h";
            if (h > 0) return $"in {h}h {mm}m";
            return $"in {mm}m";
        }
    }

    public bool HasWindows => WindowCount > 0;

    public bool HasLimitReached => LimitReached == true;

    public bool HasError => !string.IsNullOrWhiteSpace(Error);

    /// <summary>
    /// "unlimited credits · balance 12 · 2 reset credit(s)" — mirrors
    /// <c>creditsText()</c> in src/cli.js.
    /// </summary>
    public string CreditsText
    {
        get
        {
            var bits = new List<string>();
            if (Credits?.Unlimited == true) bits.Add("unlimited credits");
            else if (Credits?.HasCredits == true) bits.Add("credits available");
            if (Credits?.Balance != null) bits.Add($"balance {Credits.Balance.Value:0.##}");
            if (ResetCredits != null) bits.Add($"{ResetCredits.Value:0.##} reset credit(s)");
            return string.Join(" \u00B7 ", bits);
        }
    }

    public bool HasCredits => CreditsText.Length > 0;

    public string UsageNote =>
        NoCapReported ? "plan reports no usage for this window (bar shown at 0%)" : string.Empty;

    public bool HasUsageNote => NoCapReported;

    // ── Update from CLI JSON models ─────────────────────────────────

    public void ApplyAccount(AccountInfo info)
    {
        Name = info.Name;
        Email = info.Email;
        DisplayName = info.DisplayName;
        Plan = info.Plan;
        Status = info.Status ?? "unknown";
        IsActive = info.IsActive;
        ExpiresAt = info.ExpiresAt;

        // list --json reports a broken archive as error + status "invalid";
        // surface it so the row explains itself instead of just going red.
        if (!string.IsNullOrWhiteSpace(info.Error)) Error = info.Error;
    }

    public void ApplyUsage(UsageInfo info)
    {
        if (!info.Ok)
        {
            Error = info.Error ?? "unknown error";
            HasUsage = false;
            Windows.Clear();
            WindowCount = 0;
            return;
        }

        Error = null;
        HasUsage = true;
        Plan = info.PlanType ?? Plan;
        LimitReached = info.LimitReached;
        NoCapReported = info.NoCapReported;
        Credits = info.Credits;
        ResetCredits = info.ResetCredits;

        Windows.Clear();
        foreach (var w in info.Windows ?? new List<UsageWindowInfo>())
            Windows.Add(new WindowViewModel(w, info.NoCapReported));
        WindowCount = Windows.Count;
    }
}
