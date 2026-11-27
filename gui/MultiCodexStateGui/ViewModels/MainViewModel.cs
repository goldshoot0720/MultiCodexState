using System.Collections.ObjectModel;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MultiCodexStateGui.Models;
using MultiCodexStateGui.Services;

namespace MultiCodexStateGui.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    private readonly CliService _cli;
    private CancellationTokenSource? _toastCts;

    public ObservableCollection<AccountViewModel> Accounts { get; } = new();
    public ObservableCollection<AccountViewModel> FilteredAccounts { get; } = new();

    public event EventHandler<string>? CopyRequested;

    [ObservableProperty]
    private bool _isBusy;

    [ObservableProperty]
    private string _statusText = "Initializing...";

    [ObservableProperty]
    private bool _hasStatusError;

    [ObservableProperty]
    private bool _isEmpty = true;

    [ObservableProperty]
    private bool _isFilterEmpty;

    // ── Search, Filter & Sort ────────────────────────────────────────

    [ObservableProperty]
    private string _searchQuery = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsFilterAll))]
    [NotifyPropertyChangedFor(nameof(IsFilterActive))]
    [NotifyPropertyChangedFor(nameof(IsFilterHealthy))]
    [NotifyPropertyChangedFor(nameof(IsFilterAlerts))]
    private string _filterMode = "all";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsSortDefault))]
    [NotifyPropertyChangedFor(nameof(IsSortRemaining))]
    [NotifyPropertyChangedFor(nameof(IsSortName))]
    private string _sortMode = "default";

    public bool IsFilterAll => FilterMode == "all";
    public bool IsFilterActive => FilterMode == "active";
    public bool IsFilterHealthy => FilterMode == "healthy";
    public bool IsFilterAlerts => FilterMode == "alerts";

    public bool IsSortDefault => SortMode == "default";
    public bool IsSortRemaining => SortMode == "remaining";
    public bool IsSortName => SortMode == "name";

    [ObservableProperty]
    private int _totalCount;

    [ObservableProperty]
    private int _healthyCount;

    [ObservableProperty]
    private int _alertCount;

    [ObservableProperty]
    private AccountViewModel? _activeAccount;

    [ObservableProperty]
    private string _activePrimaryPercentText = "\u2014";

    [ObservableProperty]
    private string _activePrimaryLabel = "Current";

    [ObservableProperty]
    private string _activePrimaryRemainingText = "No active window";

    [ObservableProperty]
    private string _totalResetCreditsText = "\u2014";

    [ObservableProperty]
    private string _lastRefreshedText = "Awaiting sync";

    // ── Floating Toast & Paths HUD ───────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasToast))]
    private string? _toastMessage;

    public bool HasToast => !string.IsNullOrWhiteSpace(ToastMessage);

    [ObservableProperty]
    private bool _isHudOpen;

    [ObservableProperty]
    private bool _isWhereLoading;

    [ObservableProperty]
    private string _authJsonPath = "\u2014";

    [ObservableProperty]
    private string _accountsDirPath = "\u2014";

    [ObservableProperty]
    private string _codexBinaryPath = "\u2014";

    // Design-time constructor
    public MainViewModel() : this(new CliService()) { }

    public MainViewModel(CliService cli)
    {
        _cli = cli;
        _cli.InteractiveCommandCompleted += OnInteractiveCommandCompleted;

        // Auto-load once the window has rendered.
        Dispatcher.UIThread.Post(async () =>
        {
            await Task.Delay(50);
            await RefreshAsync();
        }, DispatcherPriority.Background);
    }

    partial void OnSearchQueryChanged(string value) => ApplyFilterAndSort();
    partial void OnFilterModeChanged(string value) => ApplyFilterAndSort();
    partial void OnSortModeChanged(string value) => ApplyFilterAndSort();

    private async void OnInteractiveCommandCompleted(object? sender, EventArgs e)
    {
        await Dispatcher.UIThread.InvokeAsync(async () =>
        {
            StatusText = "Command finished - refreshing...";
            HasStatusError = false;
            await RefreshAsync();
        });
    }

    // ── Theme & Visual Commands ──────────────────────────────────────

    [RelayCommand]
    private void SelectTheme(string? themeId)
    {
        if (string.IsNullOrWhiteSpace(themeId)) return;
        var name = ThemeManager.Apply(themeId);
        ShowToast($"Accent color: {name}");
    }

    // ── Filter & Sort Commands ───────────────────────────────────────

    [RelayCommand]
    private void SetFilter(string? mode)
    {
        FilterMode = string.IsNullOrWhiteSpace(mode) ? "all" : mode;
    }

    [RelayCommand]
    private void SetSort(string? mode)
    {
        SortMode = string.IsNullOrWhiteSpace(mode) ? "default" : mode;
    }

    [RelayCommand]
    private void ClearFilters()
    {
        SearchQuery = string.Empty;
        FilterMode = "all";
        SortMode = "default";
    }

    // ── Clipboard & HUD Commands ─────────────────────────────────────

    [RelayCommand]
    private void CopyEmail(AccountViewModel? account)
    {
        if (account == null || string.IsNullOrWhiteSpace(account.Email)) return;
        CopyRequested?.Invoke(this, account.Email);
        ShowToast($"Copied {account.Email}");

    }

    [RelayCommand]
    private void CopyText(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value == "\u2014") return;
        CopyRequested?.Invoke(this, value);
        ShowToast($"Copied {value}");
    }

    [RelayCommand]
    private async Task ToggleHudAsync()
    {
        IsHudOpen = !IsHudOpen;
        if (!IsHudOpen) return;

        IsWhereLoading = true;
        try
        {
            var info = await _cli.GetWhereAsync();
            if (info != null)
            {
                AuthJsonPath = info.AuthJson ?? "\u2014";
                AccountsDirPath = info.AccountsDir ?? "\u2014";
                CodexBinaryPath = info.CodexBinary ?? "\u2014";
            }
        }
        catch (Exception ex)
        {
            ShowToast($"Path lookup failed: {ex.Message}");
        }
        finally
        {
            IsWhereLoading = false;
        }
    }

    // ── Core CLI Commands ────────────────────────────────────────────

    [RelayCommand]
    private async Task RefreshAsync()
    {
        if (IsBusy) return;
        IsBusy = true;
        HasStatusError = false;
        StatusText = "Loading accounts...";

        try
        {
            var accounts = await _cli.GetAccountsAsync();

            Accounts.Clear();
            foreach (var info in accounts)
            {
                var vm = new AccountViewModel();
                vm.ApplyAccount(info);
                vm.IsLoading = true;
                Accounts.Add(vm);
            }

            IsEmpty = Accounts.Count == 0;
            UpdateTelemetry();
            ApplyFilterAndSort();

            if (IsEmpty)
            {
                StatusText = "No accounts yet - click Login to add one.";
                LastRefreshedText = $"Synced {DateTime.Now:HH:mm:ss}";
                return;
            }

            StatusText = $"Loaded {Accounts.Count} accounts - fetching live quota...";

            // One CLI call for all accounts; awaits without blocking the UI thread.
            string? usageError = null;
            try
            {
                var usages = await _cli.GetUsageAsync();
                var byName = usages
                    .Where(u => u.Name != null)
                    .GroupBy(u => u.Name!)
                    .ToDictionary(g => g.Key, g => g.First());

                foreach (var vm in Accounts)
                {
                    vm.IsLoading = false;
                    if (vm.Name != null && byName.TryGetValue(vm.Name, out var u))
                        vm.ApplyUsage(u);
                }
            }
            catch (Exception ex)
            {
                // Accounts loaded fine; usage fetch failed - keep the partial result
                // and say so. Swallowing this used to leave a Ready status with no bars.
                foreach (var vm in Accounts)
                    vm.IsLoading = false;
                usageError = ex.Message.Split('\n', 2)[0].Trim();
            }

            UpdateTelemetry();
            if (FilterMode == "alerts" || SortMode == "remaining")
                ApplyFilterAndSort();

            LastRefreshedText = $"Synced {DateTime.Now:HH:mm:ss}";

            var active = Accounts.FirstOrDefault(a => a.IsActive);
            var ready = active != null
                ? $"Ready - {Accounts.Count} accounts - Active: {active.Name}"
                : $"Ready - {Accounts.Count} accounts";

            if (usageError != null)
            {
                StatusText = $"{ready} - usage unavailable: {usageError}";
                HasStatusError = true;
            }
            else
            {
                StatusText = ready;
                HasStatusError = false;
            }
        }
        catch (Exception ex)
        {
            StatusText = $"Error: {ex.Message}";
            HasStatusError = true;
            IsEmpty = Accounts.Count == 0;
            UpdateTelemetry();
            ApplyFilterAndSort();
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private void Login()
    {
        try
        {
            _cli.Login(null);
            StatusText = "Login window opened - complete the browser flow, then close the window.";
            HasStatusError = false;
            ShowToast("Codex login terminal launched");
        }
        catch (Exception ex)
        {
            StatusText = $"Login failed: {ex.Message}";
            HasStatusError = true;
        }
    }

    [RelayCommand]
    private void Logout()
    {
        try
        {
            _cli.Logout(null, false);
            StatusText = "Logout window opened - close it when done.";
            HasStatusError = false;
            ShowToast("Codex logout terminal launched");
        }
        catch (Exception ex)
        {
            StatusText = $"Logout failed: {ex.Message}";
            HasStatusError = true;
        }
    }

    [RelayCommand]
    private async Task SwitchAsync(AccountViewModel? account)
    {
        if (account?.Name == null || account.IsActive) return;

        IsBusy = true;
        HasStatusError = false;
        StatusText = $"Switching to {account.Name}...";
        try
        {
            await _cli.SwitchAsync(account.Name);
            StatusText = $"Switched to {account.Name}.";
            ShowToast($"Active node switched to {account.Name}");
        }
        catch (Exception ex)
        {
            StatusText = $"Switch failed: {ex.Message}";
            HasStatusError = true;
            IsBusy = false;
            return;
        }

        IsBusy = false;
        await RefreshAsync();
    }

    [RelayCommand]
    private async Task UpdateAsync()
    {
        IsBusy = true;
        HasStatusError = false;
        StatusText = "Updating...";
        try
        {
            var (ok, msg) = await _cli.UpdateAsync(checkOnly: false);
            StatusText = ok ? "Update completed." : $"Update failed: {msg}";
            HasStatusError = !ok;
            ShowToast(ok ? "MultiCodexState updated!" : "Update failed");
        }
        catch (Exception ex)
        {
            StatusText = $"Update error: {ex.Message}";
            HasStatusError = true;
        }
        finally
        {
            IsBusy = false;
        }

        await RefreshAsync();
    }

    [RelayCommand]
    private async Task CheckUpdateAsync()
    {
        StatusText = "Checking for updates...";
        HasStatusError = false;
        var (ok, msg) = await _cli.UpdateAsync(checkOnly: true);
        StatusText = ok ? msg : $"Check failed: {msg}";
        HasStatusError = !ok;
        ShowToast(ok ? "Update check complete" : "Update check failed");
    }

    // ── Internal Helpers ─────────────────────────────────────────────

    private void UpdateTelemetry()
    {
        TotalCount = Accounts.Count;
        HealthyCount = Accounts.Count(a => a.IsHealthy);
        AlertCount = Accounts.Count(a => a.IsWarningOrExpired);

        var active = Accounts.FirstOrDefault(a => a.IsActive);
        ActiveAccount = active;

        var primaryWindow = active?.Windows.FirstOrDefault();
        if (primaryWindow != null)
        {
            ActivePrimaryPercentText = primaryWindow.PercentText;
            ActivePrimaryLabel = primaryWindow.Label;
            ActivePrimaryRemainingText = primaryWindow.HasRemaining
                ? primaryWindow.RemainingText
                : "Remaining quota unavailable";
        }
        else if (active != null && active.IsLoading)
        {
            ActivePrimaryPercentText = "...";
            ActivePrimaryLabel = "Current";
            ActivePrimaryRemainingText = "Fetching live quota";
        }
        else
        {
            ActivePrimaryPercentText = "\u2014";
            ActivePrimaryLabel = "Current";
            ActivePrimaryRemainingText = active == null ? "No active session" : "No window data";
        }

        var creditAccounts = Accounts.Where(a => a.ResetCredits.HasValue).ToList();
        if (creditAccounts.Count > 0)
        {
            var sum = creditAccounts.Sum(a => a.ResetCredits!.Value);
            TotalResetCreditsText = $"{sum:0.##}";
        }
        else
        {
            TotalResetCreditsText = "\u2014";
        }
    }

    private void ApplyFilterAndSort()
    {
        IEnumerable<AccountViewModel> query = Accounts;

        if (!string.IsNullOrWhiteSpace(SearchQuery))
        {
            var q = SearchQuery.Trim();
            query = query.Where(a =>
                (a.Name?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
                (a.Email?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
                (a.DisplayName?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
                (a.Plan?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false));
        }

        query = FilterMode switch
        {
            "active" => query.Where(a => a.IsActive),
            "healthy" => query.Where(a => a.IsHealthy),
            "alerts" => query.Where(a => a.IsWarningOrExpired),
            _ => query,
        };

        query = SortMode switch
        {
            "remaining" => query
                .OrderByDescending(a => a.IsActive)
                .ThenByDescending(a => a.BestRemainingPercent)
                .ThenBy(a => a.Name, StringComparer.OrdinalIgnoreCase),
            "name" => query
                .OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase),
            _ => query,
        };

        FilteredAccounts.Clear();
        foreach (var item in query)
            FilteredAccounts.Add(item);

        IsFilterEmpty = Accounts.Count > 0 && FilteredAccounts.Count == 0;
    }

    private async void ShowToast(string message)
    {
        _toastCts?.Cancel();
        _toastCts?.Dispose();
        _toastCts = new CancellationTokenSource();
        var token = _toastCts.Token;

        ToastMessage = message;
        try
        {
            await Task.Delay(2400, token);
            if (!token.IsCancellationRequested)
                ToastMessage = null;
        }
        catch (TaskCanceledException)
        {
        }
    }
}
