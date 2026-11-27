using Avalonia;
using Avalonia.Media;

namespace MultiCodexStateGui.Services;

public static class ThemeManager
{
    public static string Apply(string themeId)
    {
        var (name, color) = themeId switch
        {
            "aurora" => ("Teal", "#8DC5BD"),
            "synth" => ("Rose", "#D5A6AF"),
            "matrix" => ("Sage", "#AFBF9C"),
            _ => ("Blue", "#80BDCF")
        };
        if (Application.Current is { } app)
            app.Resources["AccentBrush"] = new SolidColorBrush(Color.Parse(color));
        return name;
    }
}
