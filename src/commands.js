import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  readLiveAuth,
  identityOf,
  emailOf,
  displayName,
  accountIdOf,
  writeAccount,
  listAccounts,
  hasCredential,
  isActive,
  authJsonPath,
} from './accounts.js';
import { codexHome, accountFilePath, sanitizeName } from './paths.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Locate the Codex CLI binary. */
export function findCodexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const home = codexHome();
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(home, 'bin', 'codex.exe'),
    path.join(home, 'bin', 'codex'),
    path.join(home, 'packages', 'standalone', 'current', 'bin', 'codex.exe'),
    path.join(home, 'packages', 'standalone', 'current', 'bin', 'codex'),
    path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    path.join(process.env.HOME || '', '.local', 'bin', 'codex'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'codex'; // fall back to PATH lookup
}

/**
 * Run `codex login` so the CLI performs its normal browser OAuth flow.
 * stdio stays attached to the terminal so the user sees the URL / progress.
 */
export function runCodexLogin() {
  const bin = findCodexBinary();
  return new Promise((resolve) => {
    const child = spawn(bin, ['login'], { stdio: ['inherit', 'inherit', 'inherit'], shell: false });
    child.on('error', (err) => resolve({ code: -1, error: err.message }));
    child.on('exit', (code) => resolve({ code: code ?? -1 }));
  });
}

/**
 * login — run the browser login, then snapshot the result into
 * accounts/<name>_auth.json.
 */
export async function login(name, { quiet = false } = {}) {
  const before = readLiveAuth();
  const beforeId = before ? identityOf(before) : null;

  const result = await runCodexLogin();
  if (result.error) throw new Error(`could not start Codex CLI: ${result.error}`);
  if (result.code !== 0) throw new Error(`codex login exited with code ${result.code}`);

  const after = readLiveAuth();
  if (!after) throw new Error(`login finished but ${authJsonPath()} was not written`);
  if (!hasCredential(after)) throw new Error('auth.json contains no credential');

  const identity = identityOf(after);
  const resolvedName = name || resolveAccountName(after);

  if (beforeId && beforeId === identity && !name && !quiet) {
    // Re-login of the same account — still snapshot, but say so.
    console.log(`Re-authenticated ${displayName(after)}`);
  }

  const file = writeAccount(resolvedName, after);
  return { name: resolvedName, file, auth: after, identity };
}

/** Derive a filesystem-safe archive name for an auth payload. */
export function resolveAccountName(auth) {
  const email = emailOf(auth);
  const localPart = email ? email.split('@')[0] : '';
  return (
    sanitizeName(localPart) ||
    sanitizeName(accountIdOf(auth) || '') ||
    sanitizeName(identityOf(auth)) ||
    null
  );
}

/**
 * Resolve the identity of the live session for archiving.
 * Returns { auth, email, name } or null when nothing usable exists.
 */
export function resolveLiveIdentity(auth) {
  if (!auth || !hasCredential(auth)) return null;
  return {
    auth,
    email: emailOf(auth),
    accountId: accountIdOf(auth),
    name: resolveAccountName(auth),
  };
}

/**
 * logout — archive the live session, then remove `auth.json` (and any
 * `auth.json.lock` left beside it) so the CLI returns to signed-out.
 *
 * The archive is named after the account's email local part — e.g.
 * `goldshoot0720_auth.json` — which keeps `login` and `logout` writing the
 * same filename. Pass `name` to override.
 *
 * Existing archives are never overwritten unless `force` is set.
 */
export function logout({ name, force = false } = {}) {
  const file = authJsonPath();
  const lock = `${file}.lock`;

  if (!fs.existsSync(file)) {
    removeLock(lock);
    return { removed: false, removedLock: false, backedUp: null, name: null, kept: false };
  }

  const resolved = resolveLiveIdentity(readLiveAuth());
  const target = sanitizeName(name) || resolved?.name || null;

  let backedUp = null;
  let kept = false;

  if (target) {
    const dest = accountFilePath(target);
    if (fs.existsSync(dest) && !force) {
      // Already archived — don't clobber an untouched copy with a session
      // whose tokens may be older (or already rotated).
      kept = true;
    } else {
      backedUp = writeAccount(target, resolved.auth);
    }
  }

  fs.rmSync(file, { force: true });
  const removedLock = removeLock(lock);

  return {
    removed: true,
    removedLock,
    backedUp,
    name: target,
    email: resolved?.email || null,
    kept,
  };
}

/** Drop the CLI's advisory lock file if it is still around. */
function removeLock(lock) {
  if (!fs.existsSync(lock)) return false;
  fs.rmSync(lock, { force: true });
  return true;
}

/**
 * switch — write an archived account into the live auth.json.
 *
 * Codex's auth.json holds a single identity, so this is a full replacement
 * (no merging, unlike Grok's scope-keyed map).
 */
export function switchTo(name) {
  const accounts = listAccounts();
  const target = accounts.find((a) => a.name === name);
  if (!target) {
    const available = accounts.map((a) => a.name).join(', ') || '(none)';
    throw new Error(`unknown account "${name}". Available: ${available}`);
  }
  if (!target.auth || !hasCredential(target.auth)) {
    throw new Error(`account "${name}" has no usable credential`);
  }

  fs.mkdirSync(path.dirname(authJsonPath()), { recursive: true });
  const tmp = `${authJsonPath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(target.auth, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, authJsonPath());
  try {
    fs.chmodSync(authJsonPath(), 0o600);
  } catch {
    /* best effort */
  }

  return { name, file: authJsonPath(), auth: target.auth };
}

export { isActive, projectRoot };
