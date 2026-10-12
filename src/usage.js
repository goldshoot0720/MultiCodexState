/**
 * Live usage / quota for a Codex (ChatGPT) account.
 *
 * Endpoint (the authenticated backend the Codex CLI itself uses):
 *   GET https://chatgpt.com/backend-api/wham/usage
 *
 * Auth is the OAuth access token from auth.json, sent as a Bearer token,
 * plus the `ChatGPT-Account-Id` header. This is not a documented public API,
 * so the response shape may change; everything below degrades gracefully.
 *
 * The access token is short-lived, so on 401/403 we refresh once via
 * https://auth.openai.com/oauth/token and retry.
 *
 * Both URLs are overridable through environment variables — the same
 * CODEX_REFRESH_TOKEN_URL_OVERRIDE the CLI itself honours — so the test
 * harness can point them at a local mock without ever rewriting this file.
 */

const USAGE_URL =
  process.env.CODEX_USAGE_URL || 'https://chatgpt.com/backend-api/wham/usage';
const TOKEN_URL =
  process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || 'https://auth.openai.com/oauth/token';

/** Public OAuth client id the Codex CLI registers with OpenAI. */
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email';
const USER_AGENT = 'multi-codex-state/1.0';

const asFinite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Unwrap a bare number or an OpenAI `{ val: n }` money wrapper. */
export function money(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && typeof v.val === 'number') return v.val;
  return null;
}

/**
 * Parse a reset timestamp into epoch ms.
 *
 * OpenAI mixes representations: the usage endpoint emits `reset_at` as
 * **epoch seconds** (1794077437), while auth.json stores `last_refresh` as
 * an RFC 3339 string with nanosecond precision. Values below 1e11 are read
 * as seconds, above as milliseconds, which cleanly separates the two
 * (epoch seconds for 2026 is ~1.8e9; epoch ms is ~1.8e12).
 * Returns null on anything unparseable so NaN never reaches the UI.
 */
export function parseInstant(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n < 1e11 ? n * 1000 : n;
  }
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : t;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Render a reset timestamp the way the Codex CLI does:
 *   "October 18, 21:37"
 * Rendered in the machine's local timezone. Returns null when unparseable.
 */
export function formatResetTime(value, { withYear = false } = {}) {
  const t = parseInstant(value);
  if (t == null) return null;
  const d = new Date(t);
  const base = `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withYear ? `${base}, ${d.getFullYear()}` : base;
}

/**
 * Whole days until a timestamp, floored so it never overstates the wait and
 * never disagrees with the "6d 2h" countdown beside it. 0 once due.
 */
export function daysUntil(value) {
  const t = parseInstant(value);
  if (t == null) return null;
  const delta = t - Date.now();
  if (delta <= 0) return 0;
  return Math.floor(delta / 86_400_000);
}

/** Human countdown such as "in 6d 3h" / "in 4h 12m" / "in 8m". */
export function formatCountdown(value) {
  const t = parseInstant(value);
  if (t == null) return null;
  let ms = t - Date.now();
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / 86_400_000);
  ms -= d * 86_400_000;
  const h = Math.floor(ms / 3_600_000);
  ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const DAY = 86_400;

/**
 * Name a rate-limit window from its duration.
 *
 * Codex ships a 5-hour window and a 7-day window on paid plans, and a single
 * 30-day window on the free plan — so the label is derived from
 * `limit_window_seconds` rather than from the window's position in the
 * payload (primary/secondary), which is not stable across plans.
 */
export function windowLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'window';
  if (Math.abs(seconds - 7 * DAY) <= DAY) return 'weekly';
  if (Math.abs(seconds - 30 * DAY) <= 2 * DAY) return 'monthly';
  if (Math.abs(seconds - DAY) <= 3_600) return 'daily';
  if (seconds < DAY) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / DAY)}d`;
}

function normalizeWindow(w, key) {
  if (!w || typeof w !== 'object') return null;
  const used = asFinite(w.used_percent);
  const seconds = asFinite(w.limit_window_seconds) ?? 0;
  let resetAt = parseInstant(w.reset_at);
  if (resetAt == null) {
    const after = asFinite(w.reset_after_seconds);
    if (after != null) resetAt = Date.now() + after * 1000;
  }
  return {
    key,
    label: windowLabel(seconds),
    windowSeconds: seconds,
    usedPercent: used,
    remainingPercent: used != null ? 100 - used : null,
    resetAt,
  };
}

/**
 * Normalise the `/wham/usage` payload into a flat, display-ready shape.
 * Throws only when the body is not an object at all.
 */
export function parseUsage(body) {
  if (!body || typeof body !== 'object') throw new Error('Missing usage payload');

  const rl = body.rate_limit && typeof body.rate_limit === 'object' ? body.rate_limit : {};
  const windows = [];
  const primary = normalizeWindow(rl.primary_window, 'primary');
  if (primary) windows.push(primary);
  const secondary = normalizeWindow(rl.secondary_window, 'secondary');
  if (secondary) windows.push(secondary);

  const credits = body.credits && typeof body.credits === 'object' ? body.credits : {};

  return {
    ok: true,
    planType: body.plan_type || null,
    email: body.email || null,
    accountId: body.account_id || null,
    allowed: typeof rl.allowed === 'boolean' ? rl.allowed : null,
    limitReached: typeof rl.limit_reached === 'boolean' ? rl.limit_reached : null,
    windows,
    hasUsageData: windows.some((w) => w.usedPercent != null),
    // A payload with no windows at all means the plan reports nothing —
    // distinct from a genuine 0%. The UI renders this as 0% with a note.
    noCapReported: windows.length === 0,
    credits: {
      hasCredits: typeof credits.has_credits === 'boolean' ? credits.has_credits : null,
      unlimited: typeof credits.unlimited === 'boolean' ? credits.unlimited : null,
      balance: money(credits.balance),
      approxLocalMessages: asFinite(credits.approx_local_messages),
    },
    resetCredits: asFinite(body.rate_limit_reset_credits?.available_count),
    modelUsage: body.model_usage && typeof body.model_usage === 'object' ? body.model_usage : {},
  };
}

/**
 * Exchange a refresh_token for fresh tokens.
 *
 * OpenAI's endpoint takes a JSON body; some deployments only accept form
 * encoding, so a 400/415 on the JSON attempt is retried once as
 * application/x-www-form-urlencoded.
 *
 * @returns {Promise<object|null>} a `tokens`-shaped object, or null.
 */
export async function refreshTokens(auth) {
  const tokens = auth?.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
  const refreshToken = tokens.refresh_token;
  if (!refreshToken) return null;

  const payload = {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPE,
  };

  const post = (body, contentType) =>
    fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': contentType,
        'User-Agent': USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });

  let res;
  try {
    res = await post(JSON.stringify(payload), 'application/json');
    if (res.status === 400 || res.status === 415) {
      res = await post(new URLSearchParams(payload).toString(), 'application/x-www-form-urlencoded');
    }
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const json = await res.json().catch(() => null);
  if (!json?.access_token) return null;

  const updated = { ...tokens, access_token: json.access_token };
  if (json.refresh_token) updated.refresh_token = json.refresh_token;
  if (json.id_token) updated.id_token = json.id_token;
  return updated;
}

async function callUsage(token, accountId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;

  const res = await fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Fetch usage for one auth payload.
 *
 * @param {object} auth  the parsed auth.json object
 * @param {{onTokenRefreshed?: (tokens: object) => void}} [opts]
 * @returns {Promise<object>} normalised usage; `ok:false` on failure.
 */
export async function fetchUsage(auth, { onTokenRefreshed } = {}) {
  const tokens = auth?.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
  if (!tokens.access_token) return { ok: false, error: 'no access token stored' };

  const accountId = tokens.account_id || null;

  let usage;
  try {
    usage = parseUsage(await callUsage(tokens.access_token, accountId));
  } catch (err) {
    // Stale token — refresh once, persist, retry.
    if (err.status !== 401 && err.status !== 403) return { ok: false, error: err.message };
    const refreshed = await refreshTokens(auth).catch(() => null);
    if (!refreshed) return { ok: false, error: err.message };
    try {
      usage = parseUsage(await callUsage(refreshed.access_token, refreshed.account_id || accountId));
    } catch (retryErr) {
      return { ok: false, error: retryErr.message };
    }
    onTokenRefreshed?.(refreshed);
  }

  return { ...usage, ok: true, account: usage.email || null };
}

/** Render a chalk-agnostic progress bar (no colour codes, just glyphs). */
export function bar(percent, width = 20) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((width * pct) / 100);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

/** Format a money wrapper or raw number for display. */
export function moneyText(v) {
  if (v == null) return null;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export { USAGE_URL, TOKEN_URL };
