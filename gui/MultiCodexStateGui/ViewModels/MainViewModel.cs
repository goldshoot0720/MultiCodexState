using System.Collections.ObjectModel;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MultiCodexStateGui.Services;

namespace MultiCodexStateGui.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    private readonly CliService _cli;

    public ObservableCollection<AccountViewModel> Accounts { get; } = new();

    [ObservableProperty]
    private bool _isBusy;

    [ObservableProperty]
    private string _statusText = "Initializing...";

    [ObservableProperty]
    private bool _isEmpty = true;

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

    private async void OnInteractiveCommandCompleted(object? sender, EventArgs e)
    {
        await Dispatcher.UIThread.InvokeAsync(async () =>
        {
            StatusText = "Command finished - refreshing...";
            await RefreshAsync();
        });
    }

    // ── Commands ────────────────────────────────────────────────────

    [RelayCommand]
    private async Task RefreshAsync()
    {
        if (IsBusy) return;
        IsBusy = true;
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

            if (IsEmpty)
            {
                StatusText = "No accounts yet - click Login to add one.";
                return;
            }

            StatusText = $"Loaded {Accounts.Count} accounts - fetching usage...";

            // One CLI call for all accounts; awaits without blocking the UI thread.
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
            catch
            {
                // Accounts loaded fine; usage fetch failed - keep the partial result.
                foreach (var vm in Accounts)
                    vm.IsLoading = false;
            }

            var active = Accounts.FirstOrDefault(a => a.IsActive);
            StatusText = active != null
                ? $"Ready - {Accounts.Count} accounts - Active: {active.Name}"
                : $"Ready - {Accounts.Count} accounts";
        }
        catch (Exception ex)
        {
            StatusText = $"Error: {ex.Message}";
            IsEmpty = true;
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
        }
        catch (Exception ex)
        {
            StatusText = $"Login failed: {ex.Message}";
        }
    }

    [RelayCommand]
    private void Logout()
    {
        try
        {
            _cli.Logout(null, false);
            StatusText = "Logout window opened - close it when done.";
        }
        catch (Exception ex)
        {
            StatusText = $"Logout failed: {ex.Message}";
        }
    }

    [RelayCommand]
    private async Task SwitchAsync(AccountViewModel? account)
    {
        if (account?.Name == null || account.IsActive) return;

        IsBusy = true;
        StatusText = $"Switching to {account.Name}...";
        try
        {
            await _cli.SwitchAsync(account.Name);
            StatusText = $"Switched to {account.Name}.";
        }
        catch (Exception ex)
        {
            StatusText = $"Switch failed: {ex.Message}";
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
        StatusText = "Updating...";
        try
        {
            var (ok, msg) = await _cli.UpdateAsync(checkOnly: false);
            StatusText = ok ? "Update completed." : $"Update failed: {msg}";
        }
        catch (Exception ex)
        {
            StatusText = $"Update error: {ex.Message}";
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
        var (ok, msg) = await _cli.UpdateAsync(checkOnly: true);
        StatusText = ok ? msg : $"Check failed: {msg}";
    }
}
