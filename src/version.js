/**
 * Version + update checking.
 *
 * The CLI is installed by cloning a git repo, so "am I up to date?" is really
 * "does the local checkout match the tip of the tracked branch?". We answer
 * that by resolving the branch to an immutable commit SHA and comparing it to
 * the local `HEAD` — the same SHA-based strategy the installer uses, which
 * sidesteps the CDN cache that serves stale content for branch-name URLs.
 *
 * Resolution tries the GitHub REST API first and falls back to `git ls-remote`.
 * The API is capped at 60 unauthenticated requests/hour per IP and is
 * routinely exhausted behind shared/NAT addresses, so the git protocol is the
 * reliable path; the API is merely a little faster when it happens to work.
 *
 * Everything here is best-effort and offline-safe: if there is no git, no
 * network, or no remote, the check reports "could not check" rather than
 * failing the command the user actually ran.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

export const REPO = 'goldshoot0720/MultiCodexState';
export const BRANCH = 'main';

/** Run a git subcommand, resolving to stdout or null on any failure. */
function git(args, cwd, { stream = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: stream ? 'inherit' : ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    // In stream mode git writes straight to the terminal; we only care about
    // the exit code, so there is no stdout to collect.
    if (stream) {
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code === 0 ? '' : null));
      return;
    }
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

/** SHA of the commit this checkout is on (no network needed). */
export async function localSha(cwd = ROOT) {
  const out = await git(['rev-parse', 'HEAD'], cwd);
  return out ? out.trim().split('\n')[0] : null;
}

/** How far behind the tip this checkout is, without hitting the network. */
export async function localStatus(cwd = ROOT) {
  const sha = await localSha(cwd);
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd))?.trim();
  // The installer leaves the checkout detached at FETCH_HEAD, so `HEAD` here
  // is literally the string "HEAD" — flag that instead of reporting it as a
  // branch name, since a detached HEAD changes how an update must be applied.
  const detached = !branch || branch === 'HEAD';
  return { sha, branch: detached ? null : branch, detached };
}

/** The configured remote URL, or null. */
export async function remoteUrl(cwd = ROOT) {
  const out = await git(['remote', 'get-url', 'origin'], cwd);
  return out ? out.trim() : null;
}

/** Resolve a branch/tag/SHA to a concrete commit SHA via the GitHub API. */
export async function remoteShaApi({ repo = REPO, branch = BRANCH, timeout = 8000 } = {}) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${branch}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'MultiCodexState',
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.sha || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a branch to a commit SHA without the REST API, via the git protocol.
 *
 * This is the workhorse: the unauthenticated GitHub API allows only 60
 * requests/hour per IP and is frequently exhausted (shared/NAT addresses hit
 * this constantly), whereas `git ls-remote` has no such cap and returns the
 * same SHA. The API is tried first only because it is marginally faster.
 */
export async function remoteShaGit({ repo = REPO, branch = BRANCH } = {}) {
  const out = await git(['ls-remote', `https://github.com/${repo}.git`, `refs/heads/${branch}`]);
  if (!out) return null;
  const sha = out.trim().split(/\s+/)[0];
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Resolve a branch to a commit SHA, preferring the API and falling back to git. */
export async function remoteSha(opts = {}) {
  return (await remoteShaApi(opts)) || (await remoteShaGit(opts));
}

/**
 * Compare the local checkout against the remote branch tip.
 * @returns {Promise<{ok:boolean, reason?:string, current:string|null,
 *   latest:string|null, behind:boolean, branch:string|null}>}
 */
export async function checkForUpdate({ repo = REPO, branch = BRANCH } = {}) {
  const { sha: current, branch: localBranch, detached } = await localStatus();
  if (!current) {
    return { ok: false, reason: 'not a git checkout', current: null, latest: null, behind: false, branch: null };
  }

  const latest = await remoteSha({ repo, branch });
  if (!latest) {
    return {
      ok: false,
      reason: 'could not reach GitHub',
      current,
      latest: null,
      behind: false,
      branch: localBranch,
      detached,
    };
  }

  // A short-SHA match is enough: 7 hex chars uniquely identify a commit here.
  const behind = !current.startsWith(latest.slice(0, 7)) && !latest.startsWith(current.slice(0, 7));
  return { ok: true, current, latest, behind, branch: localBranch || branch, detached };
}

/**
 * Move the checkout onto the remote branch tip.
 *
 * This deliberately does NOT use `git pull`. The installer leaves the
 * checkout detached at FETCH_HEAD, and `git pull` on a detached HEAD reports
 * "Already up to date" and changes nothing — a silent no-op that would make
 * the update command useless for every real installation.
 *
 * Instead we resolve the branch to an immutable SHA (never a cached branch
 * name, for the CDN reasons the installer documents), fetch that exact commit,
 * and hard-reset onto it. Untracked files are left alone; any tracked local
 * edits are discarded, which is why the caller checks for a clean tree first.
 */
export async function syncToRemote({ repo = REPO, branch = BRANCH, cwd = ROOT, quiet = true } = {}) {
  if (!(await isClean(cwd))) return { ok: false, dirty: true };

  const sha = await remoteSha({ repo, branch });
  if (!sha) return { ok: false, error: 'could not resolve the remote branch' };

  const stream = !quiet;
  const fetched = await git(['fetch', '--depth', '1', 'origin', sha], cwd, { stream });
  if (fetched == null) return { ok: false, error: 'git fetch failed' };

  const reset = await git(['reset', '--hard', 'FETCH_HEAD'], cwd, { stream });
  if (reset == null) return { ok: false, error: 'git reset failed' };

  return { ok: true, sha };
}

/** True when the working tree has no staged or unstaged changes. */
export async function isClean(cwd = ROOT) {
  const out = await git(['status', '--porcelain'], cwd);
  // `git status --porcelain` prints nothing for a clean tree; null means git
  // itself failed, which we treat as "not safe to overwrite".
  return out != null && out.trim() === '';
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — polite to the GitHub API

export function cacheFile() {
  const root = process.env.CODEX_STATE_HOME || process.env.CODEX_HOME;
  if (!root) {
    // Fall back to a home-relative path so it stays per-user without a token dir.
    return path.join(
      process.env.USERPROFILE || process.env.HOME || '.',
      '.multicodexstate-update.json'
    );
  }
  return path.join(root, '.multicodexstate-update.json');
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(value) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch {
    /* best effort — a failed cache write must never break the CLI */
  }
}

/**
 * Passive check used on normal command runs, guarded by a TTL cache so we hit
 * the network at most once every few hours. Returns null when there is nothing
 * worth telling the user (up to date, offline, not a git checkout).
 */
export async function cachedUpdateNotice({ repo = REPO, branch = BRANCH, ttl = CACHE_TTL_MS } = {}) {
  const cached = readCache();
  if (cached && Date.now() - (cached.checkedAt || 0) < ttl) {
    return cached.behind ? cached : null;
  }

  const result = await checkForUpdate({ repo, branch });
  const record = { ...result, checkedAt: Date.now() };
  writeCache(record);
  return result.ok && result.behind ? record : null;
}

/* ------------------------------------------------------------------ */

export const shortSha = (sha) => (sha ? sha.slice(0, 7) : 'unknown');
