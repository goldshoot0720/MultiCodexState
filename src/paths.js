import os from 'node:os';
import path from 'node:path';

/** Codex CLI home — override with CODEX_HOME (same env var the CLI itself honours). */
export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** File the Codex CLI actually reads for its live session. */
export function authJsonPath() {
  return path.join(codexHome(), 'auth.json');
}

/**
 * Where archived accounts live.
 * <codexHome>/accounts/<name>_auth.json
 * Keeping it inside ~/.codex means `codex` and this tool share one root.
 */
export function accountsDir() {
  return process.env.CODEX_STATE_HOME
    ? path.join(process.env.CODEX_STATE_HOME, 'accounts')
    : path.join(codexHome(), 'accounts');
}

/** Validate a user-supplied account name so it can't escape the accounts dir. */
export function accountFilePath(name) {
  const clean = sanitizeName(name);
  if (!clean) throw new Error('Account name must contain letters, digits, "-" or "_"');
  return path.join(accountsDir(), `${clean}_auth.json`);
}

export function sanitizeName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '');
}

export function accountNameFromFile(file) {
  return path.basename(file).replace(/_auth\.json$/i, '');
}
