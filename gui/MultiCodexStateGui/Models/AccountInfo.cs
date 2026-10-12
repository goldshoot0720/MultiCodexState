using System.Text.Json.Serialization;

namespace MultiCodexStateGui.Models;

/// <summary>
/// JSON model for <c>MultiCodexState list --json</c> output.
/// </summary>
public class AccountInfo
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("email")]
    public string? Email { get; set; }

    [JsonPropertyName("displayName")]
    public string? DisplayName { get; set; }

    /// <summary>"free" / "plus" / "pro" / "business" / "team", or null.</summary>
    [JsonPropertyName("plan")]
    public string? Plan { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    /// <summary>Epoch milliseconds, or null when the token carries no <c>exp</c>.</summary>
    [JsonPropertyName("expiresAt")]
    public long? ExpiresAt { get; set; }

    [JsonPropertyName("isActive")]
    public bool IsActive { get; set; }

    /// <summary>Set only when the archive itself could not be parsed.</summary>
    [JsonPropertyName("error")]
    public string? Error { get; set; }
}
