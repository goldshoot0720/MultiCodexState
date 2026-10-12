import fs from 'node:fs';
import path from 'node:path';

import { authJsonPath, accountsDir, accountFilePath, accountNameFromFile } from './paths.js';

/**
 * Codex's auth.json is a single flat object (unlike Grok's scope-keyed map):
 *
 *   {
 *     "auth_mode": "chatgpt",
 *     "OPENAI_API_KEY": null,
 *     "tokens": {
 *       "id_token": "<JWT>",
 *       "access_token": "<JWT>",
 *       "refresh_token": "rt.1....",
 *       "account_id": "72925193-..."
 *     },
 *     "last_refresh": "2026-10-10T07:18:16.564788900Z"
 *   }
 *
 * There is exactly one identity per file, so an archive is a byte-for-byte
 * copy of this object and `switch` is a plain overwrite.
 */

export function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

/** Atomic + owner-only write, mirroring how the Codex CLI persists tokens. */
export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort — chmod is a no-op on some Windows setups */
  }
}

/** The `tokens` block of an auth object, or an empty object. */
export function tokensOf(auth) {
  const t = auth && typeof auth === 'object' ? auth.tokens : null;
  return t && typeof t === 'object' ? t : {};
}

/** True when the payload carries something we could authenticate with. */
export function hasCredential(auth) {
  const t = tokensOf(auth);
  return Boolean(t.access_token || t.refresh_token || (auth && auth.OPENAI_API_KEY));
}

/** Decode a JWT payload without verifying the signature (we only read claims). */
export function jwtClaims(token) {
  if (!token || typeof token !== 'string') return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

/** OpenAI nests account metadata under this claim key in both JWTs. */
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile';

/** Best available claims object for an auth payload (id_token preferred). */
export function claimsOf(auth) {
  const t = tokensOf(auth);
  const id = jwtClaims(t.id_token);
  if (Object.keys(id).length) return id;
  return jwtClaims(t.access_token);
}

export function emailOf(auth) {
  const claims = claimsOf(auth);
  return claims.email || claims[OPENAI_PROFILE_CLAIM]?.email || null;
}

/** "free" / "plus" / "pro" / "business" / "team" — from the id_token claim. */
export function planTypeOf(auth) {
  const claims = claimsOf(auth);
  return claims[OPENAI_AUTH_CLAIM]?.chatgpt_plan_type || null;
}

export function accountIdOf(auth) {
  const t = tokensOf(auth);
  return t.account_id || claimsOf(auth)[OPENAI_AUTH_CLAIM]?.chatgpt_account_id || null;
}

/** Stable identity used to decide whether two archives are the same account. */
export function identityOf(auth) {
  return accountIdOf(auth) || emailOf(auth) || 'unknown';
}

/** Best-effort human name (Google profile name, else the email local part). */
export function displayName(auth) {
  const claims = claimsOf(auth);
  const name = (claims.name || claims[OPENAI_PROFILE_CLAIM]?.name || '').trim();
  return name || emailOf(auth) || identityOf(auth);
}

/** Expiry instant (epoch ms) for the credential, or null if unknown. */
export function expiresAt(auth) {
  const t = tokensOf(auth);
  const claims = jwtClaims(t.access_token);
  if (claims.exp) return claims.exp * 1000;
  const idClaims = jwtClaims(t.id_token);
  if (idClaims.exp) return idClaims.exp * 1000;
  return null;
}

export function tokenStatus(auth, skewSeconds = 120) {
  const exp = expiresAt(auth);
  if (exp == null) return { state: 'unknown', expiresAt: null };
  if (Date.now() >= exp - skewSeconds * 1000) {
    return { state: exp < Date.now() ? 'expired' : 'expiring', expiresAt: exp };
  }
  return { state: 'valid', expiresAt: exp };
}

export function humanExpiry(exp) {
  if (!exp) return 'unknown';
  const secs = Math.round((exp - Date.now()) / 1000);
  if (secs < 0) {
    const m = Math.round(-secs / 60);
    return m < 60 ? `expired ${m}m ago` : `expired ${Math.round(m / 60)}h ago`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

/* ------------------------------------------------------------------ */
/* Account archive                                                     */
/* ------------------------------------------------------------------ */

export function readLiveAuth() {
  const file = authJsonPath();
  if (!fs.existsSync(file)) return null;
  return readJsonFile(file);
}

/** All archived accounts, sorted by name. */
export function listAccounts() {
  const dir = accountsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('_auth.json'))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      const name = accountNameFromFile(file);
      try {
        const auth = readJsonFile(file);
        const st = tokenStatus(auth);
        return {
          name,
          file,
          auth,
          email: emailOf(auth),
          plan: planTypeOf(auth),
          displayName: displayName(auth),
          status: hasCredential(auth) ? st.state : 'invalid',
          expiresAt: st.expiresAt,
        };
      } catch (err) {
        return {
          name,
          file,
          auth: null,
          email: null,
          plan: null,
          displayName: name,
          status: 'invalid',
          expiresAt: null,
          error: err.message,
        };
      }
    });
}

export function readAccount(name) {
  const file = accountFilePath(name);
  if (!fs.existsSync(file)) return null;
  return { name, file, auth: readJsonFile(file) };
}

export function writeAccount(name, auth) {
  const file = accountFilePath(name);
  writeJsonFile(file, auth);
  return file;
}

/**
 * Replace the `tokens` block inside an archived account, preserving every
 * other field. Used when a token is refreshed.
 */
export function updateAccountTokens(name, tokens) {
  const acc = readAccount(name);
  if (!acc) return null;
  const auth = { ...acc.auth, tokens: { ...tokensOf(acc.auth), ...tokens } };
  writeJsonFile(acc.file, auth);
  return acc.file;
}

export function deleteAccount(name) {
  const file = accountFilePath(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** True when the live auth.json holds the same identity as the named archive. */
export function isActive(name) {
  const live = readLiveAuth();
  const acc = readAccount(name);
  if (!live || !acc) return false;
  return identityOf(live) === identityOf(acc.auth);
}

export { authJsonPath, accountsDir, accountFilePath };
