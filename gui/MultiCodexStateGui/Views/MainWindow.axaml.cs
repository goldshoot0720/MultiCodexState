using System;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.VisualTree;
using MultiCodexStateGui.ViewModels;

namespace MultiCodexStateGui.Views;

public partial class MainWindow : Window
{
    private MainViewModel? _subscribedVm;

    public MainWindow()
    {
        InitializeComponent();

        if (OperatingSystem.IsMacOS())
        {
            ExtendClientAreaToDecorationsHint = true;
            MacTrafficLightSpacer.Width = 74;
        }

        DataContextChanged += OnDataContextChanged;
    }

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        if (_subscribedVm != null)
            _subscribedVm.CopyRequested -= OnCopyRequested;

        _subscribedVm = DataContext as MainViewModel;
        if (_subscribedVm != null)
            _subscribedVm.CopyRequested += OnCopyRequested;
    }

    private async void OnCopyRequested(object? sender, string text)
    {
        var clipboard = GetTopLevel(this)?.Clipboard;
        if (clipboard != null)
            await clipboard.SetTextAsync(text);
    }

    private void OnHeaderPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (e.Handled || !e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
            return;

        if (e.Source is Control c && c.FindAncestorOfType<Button>(includeSelf: true) != null)
            return;

        BeginMoveDrag(e);
    }
}
