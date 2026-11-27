using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using MultiCodexStateGui.Models;

namespace MultiCodexStateGui.ViewModels;

public sealed record ModelUsageChip(string Model, string PercentText);

/// <summary>
/// Per-account display item that merges <see cref="AccountInfo"/> and
/// <see cref="UsageInfo"/> into observable, UI-friendly properties.
/// </summary>
public partial class AccountViewModel : ObservableObject
{
    // ── Raw identity ────────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasDisplayName))]
    private string? _name;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasEmail))]
    private string? _email;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasDisplayName))]
    private string? _displayName;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasPlan))]
    [NotifyPropertyChangedFor(nameof(PlanDisplay))]
    private string? _plan;

    // ── Token status ────────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(StatusDisplay))]
    [NotifyPropertyChangedFor(nameof(IsWarningOrExpired))]
    [NotifyPropertyChangedFor(nameof(IsHealthy))]
    [NotifyPropertyChangedFor(nameof(IsTokenWarning))]
    private string? _status = "unknown";

    [ObservableProperty]
    private bool _isActive;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ExpiryText))]
    [NotifyPropertyChangedFor(nameof(HasExpiry))]
    private long? _expiresAt;

    // ── Rate-limit windows ──────────────────────────────────────────

    /// <summary>
    /// One entry per window the payload reported, laid out side by side on a
    /// single row. Empty on the free plan when the payload reports nothing,
    /// two on plus/pro — the card does not care which, it just renders the
    /// collection and lets the panel derive the column count.
    /// </summary>
    public ObservableCollection<WindowViewModel> Windows { get; } = new();

    public ObservableCollection<ModelUsageChip> ModelUsageItems { get; } = new();

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasWindows))]
    private int _windowCount;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasModelUsage))]
    private int _modelUsageCount;

    // ── Plan-level state ────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(UsageNote))]
    [NotifyPropertyChangedFor(nameof(HasUsageNote))]
    private bool _noCapReported;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasLimitReached))]
    [NotifyPropertyChangedFor(nameof(IsWarningOrExpired))]
    private bool? _limitReached;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CreditsText))]
    [NotifyPropertyChangedFor(nameof(HasCredits))]
    [NotifyPropertyChangedFor(nameof(ApproxMessagesText))]
    [NotifyPropertyChangedFor(nameof(HasApproxMessages))]
    private CreditsInfo? _credits;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CreditsText))]
    [NotifyPropertyChangedFor(nameof(HasCredits))]
    private double? _resetCredits;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    [NotifyPropertyChangedFor(nameof(IsWarningOrExpired))]
    private string? _error;

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    private bool _hasUsage;

    public string StatusDisplay => Status ?? "unknown";

    public bool IsHealthy => string.Equals(Status, "valid", StringComparison.OrdinalIgnoreCase);

    public bool IsWarningOrExpired => HasError || HasLimitReached || IsTokenWarning;

    public bool IsTokenWarning =>
        string.Equals(Status, "expiring", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(Status, "expired", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(Status, "invalid", StringComparison.OrdinalIgnoreCase);

    public bool HasEmail => !string.IsNullOrWhiteSpace(Email);

    public bool HasDisplayName =>
        !string.IsNullOrWhiteSpace(DisplayName) &&
        !string.Equals(DisplayName.Trim(), Name?.Trim(), StringComparison.OrdinalIgnoreCase);

    public bool HasPlan => !string.IsNullOrWhiteSpace(Plan);

    public string PlanDisplay => string.IsNullOrWhiteSpace(Plan) ? string.Empty : Plan.Trim().ToUpperInvariant();

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

    public bool HasModelUsage => ModelUsageCount > 0;

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

    public string ApproxMessagesText =>
        Credits?.ApproxLocalMessages != null
            ? $"~{Credits.ApproxLocalMessages.Value:0} local msgs"
            : string.Empty;

    public bool HasApproxMessages => Credits?.ApproxLocalMessages != null;

    public string UsageNote =>
        NoCapReported ? "No usage cap reported" : string.Empty;

    public bool HasUsageNote => NoCapReported;

    /// <summary>
    /// Lowest remaining percentage across reported windows, used when sorting by remaining capacity.
    /// </summary>
    public double BestRemainingPercent
    {
        get
        {
            var values = Windows
                .Where(w => w.RemainingPercent.HasValue)
                .Select(w => w.RemainingPercent!.Value)
                .ToList();
            return values.Count > 0 ? values.Min() : -1;
        }
    }

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
            ModelUsageItems.Clear();
            ModelUsageCount = 0;
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

        ModelUsageItems.Clear();
        if (info.ModelUsage != null)
        {
            foreach (var (model, pct) in info.ModelUsage)
            {
                ModelUsageItems.Add(new ModelUsageChip(model, $"{pct:0.#}%"));
            }
        }
        ModelUsageCount = ModelUsageItems.Count;
    }
}
