using System.Text.Json.Serialization;

namespace MultiCodexStateGui.Models;

/// <summary>
/// JSON model for <c>MultiCodexState where --json</c> output.
/// </summary>
public class WhereInfo
{
    [JsonPropertyName("authJson")]
    public string? AuthJson { get; set; }

    [JsonPropertyName("accountsDir")]
    public string? AccountsDir { get; set; }

    [JsonPropertyName("codexBinary")]
    public string? CodexBinary { get; set; }
}
