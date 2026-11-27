using System.Text.Json;
using System.Text.Json.Serialization;

namespace MultiCodexStateGui.Models;

/// <summary>
/// JSON model for <c>MultiCodexState usage --json</c> output.
///
/// Note the shape differs from the Grok sibling project on purpose: Grok
/// reported a fixed weekly/monthly pair, while Codex reports a *variable*
/// number of rate-limit windows (a 5h + 7d pair on paid plans, a single
/// 30-day window on free). Hence <see cref="Windows"/> is a list rather than
/// two named fields, and nothing here assumes a specific window count.
/// </summary>
public class UsageInfo
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("email")]
    public string? Email { get; set; }

    [JsonPropertyName("planType")]
    public string? PlanType { get; set; }

    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    /// <summary>True when the plan says the rate limit is currently hit.</summary>
    [JsonPropertyName("limitReached")]
    public bool? LimitReached { get; set; }

    /// <summary>
    /// True when the plan reports no windows at all. Distinct from a genuine
    /// 0%: the bar is drawn at 0% but the UI says so explicitly.
    /// </summary>
    [JsonPropertyName("noCapReported")]
    public bool NoCapReported { get; set; }

    [JsonPropertyName("windows")]
    public List<UsageWindowInfo>? Windows { get; set; }

    [JsonPropertyName("credits")]
    public CreditsInfo? Credits { get; set; }

    [JsonPropertyName("resetCredits")]
    public double? ResetCredits { get; set; }

    /// <summary>
    /// Numeric per-model percents only. A nested object (the current Codex
    /// shape) must not fail the whole document, or the rate-limit windows
    /// disappear with it.
    /// </summary>
    [JsonPropertyName("modelUsage")]
    [JsonConverter(typeof(NumericMapConverter))]
    public Dictionary<string, double>? ModelUsage { get; set; }
}

/// <summary>Reads a JSON object, keeping number values and skipping the rest.</summary>
public sealed class NumericMapConverter : JsonConverter<Dictionary<string, double>>
{
    public override Dictionary<string, double> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var result = new Dictionary<string, double>();
        if (reader.TokenType != JsonTokenType.StartObject)
        {
            reader.Skip();
            return result;
        }

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            var key = reader.GetString() ?? "";
            if (!reader.Read()) break;
            if (reader.TokenType == JsonTokenType.Number && reader.TryGetDouble(out var number))
                result[key] = number;
            else
                reader.Skip();
        }

        return result;
    }

    public override void Write(Utf8JsonWriter writer, Dictionary<string, double> value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        foreach (var (key, number) in value)
            writer.WriteNumber(key, number);
        writer.WriteEndObject();
    }
}

/// <summary>One rate-limit window: a 5h, a weekly, a monthly, or a raw hour count.</summary>
public class UsageWindowInfo
{
    /// <summary>"primary" / "secondary" — the payload slot it came from.</summary>
    [JsonPropertyName("key")]
    public string? Key { get; set; }

    /// <summary>Display label derived from the duration, e.g. "5h" / "weekly" / "monthly".</summary>
    [JsonPropertyName("label")]
    public string? Label { get; set; }

    [JsonPropertyName("windowSeconds")]
    public double? WindowSeconds { get; set; }

    [JsonPropertyName("usedPercent")]
    public double? UsedPercent { get; set; }

    [JsonPropertyName("remainingPercent")]
    public double? RemainingPercent { get; set; }

    /// <summary>Epoch milliseconds, already normalised by the CLI.</summary>
    [JsonPropertyName("resetAt")]
    public long? ResetAt { get; set; }
}

/// <summary>The <c>credits</c> block of the usage payload.</summary>
public class CreditsInfo
{
    [JsonPropertyName("hasCredits")]
    public bool? HasCredits { get; set; }

    [JsonPropertyName("unlimited")]
    public bool? Unlimited { get; set; }

    [JsonPropertyName("balance")]
    public double? Balance { get; set; }

    [JsonPropertyName("approxLocalMessages")]
    public double? ApproxLocalMessages { get; set; }
}
