using Avalonia;
using Avalonia.Media;

namespace MultiCodexStateGui.Services;

public static class ThemeManager
{
    public static string Apply(string themeId)
    {
        var name = themeId switch
        {
            "aurora" => "Teal",
            "synth" => "Rose",
            "matrix" => "Sage",
            _ => "Blue"
        };
        if (Application.Current is { } app && app.Resources[$"{name}AccentColor"] is Color color)
            app.Resources["AccentBrush"] = new SolidColorBrush(color);
        return name;
    }
}
