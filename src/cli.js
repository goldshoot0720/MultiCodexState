import { spawn } from 'node:child_process';

import chalk from 'chalk';

import {
  listAccounts,
  readLiveAuth,
  displayName,
  emailOf,
  planTypeOf,
  identityOf,
  humanExpiry,
  updateAccountTokens,
} from './accounts.js';
import { fetchUsage, bar, formatResetTime, formatCountdown, daysUntil, parseInstant } from './usage.js';
import { login, logout, switchTo, findCodexBinary } from './commands.js';
import { accountsDir, authJsonPath } from './paths.js';
import { ROOT, REPO, BRANCH, checkForUpdate, cachedUpdateNotice, syncToRemote, shortSha } from './version.js';

const CMD = 'MultiCodexState';

const STATUS_STYLE = {
  valid: (s) => chalk.green(s),
  expiring: (s) => chalk.yellow(s),
  expired: (s) => chalk.red(s),
  unknown: (s) => chalk.gray(s),
  invalid: (s) => chalk.red(s),
};

function statusChip(state) {
  const paint = STATUS_STYLE[state] || chalk.gray;
  return paint(`● ${state}`);
}

/**
 * Terminal display width of a string.
 *
 * Counts ANSI escapes as zero (chalk wraps text in them) and CJK/wide
 * glyphs as two cells, which `.length` does not. Without this, a name like
 * "鋒兄" misaligns every column to its right.
 */
function displayWidth(text) {
  const stripped = text.replace(/\u001b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd); // CJK ext. B+
    width += wide ? 2 : 1;
  }
  return width;
}

/** Pad a (possibly colourised) string to a terminal display width. */
function padVisible(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** Truncate to a display width, never splitting an ANSI escape sequence. */
function truncateVisible(text, width) {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of text.replace(/\u001b\[[0-9;]*m/g, '')) {
    const w = displayWidth(ch);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/**
 * The "account" column. The email is the field that actually distinguishes
 * two archives, so it leads; the plan type is appended when it fits.
 */
function accountLabel(a, width = 34) {
  if (!a.email) {
    const fallback = a.displayName && a.displayName !== a.name ? a.displayName : '(no email)';
    return padVisible(chalk.gray(truncateVisible(fallback, width)), width);
  }

  const plan = a.plan ? a.plan : null;
  const withPlan = plan ? `${a.email}  ${plan}` : a.email;

  const text =
    plan && displayWidth(withPlan) <= width
      ? `${chalk.white(a.email)}  ${chalk.gray(plan)}`
      : chalk.white(truncateVisible(a.email, width));

  return padVisible(text, width);
}

/** Colour a usage percentage by how close it is to the cap. */
function paintPercent(pct) {
  if (pct == null) return chalk.gray('—');
  const text = `${pct.toFixed(1)}%`;
  if (pct >= 90) return chalk.red(text);
  if (pct >= 70) return chalk.yellow(text);
  return chalk.green(text);
}

function paintBar(pct) {
  if (pct == null) return chalk.gray('░'.repeat(20));
  const p = Number(pct) || 0;
  const glyphs = bar(p, 20);
  if (p >= 90) return chalk.red(glyphs);
  if (p >= 70) return chalk.yellow(glyphs);
  return chalk.green(glyphs);
}

function rule(label) {
  const width = 62;
  if (!label) return chalk.gray('─'.repeat(width));
  const head = ` ${label} `;
  return chalk.gray(head + '─'.repeat(Math.max(0, width - head.length - 1)));
}

/**
 * "Resets: October 18, 21:37 (in 6d 3h)" — the full reset line.
 * Colour shifts to yellow/red as the reset approaches, so an imminent
 * rollover is obvious at a glance.
 */
function resetLine(value, { label = 'Resets' } = {}) {
  if (parseInstant(value) == null) return null;
  const when = formatResetTime(value, { withYear: true });
  const countdown = formatCountdown(value);
  const days = daysUntil(value);

  const head = chalk.gray(`${label}:`);
  const paint = days != null && days <= 0 ? chalk.red : days != null && days <= 1 ? chalk.yellow : chalk.white;
  const absolute = paint(when);
  const rel = countdown && countdown !== 'now' ? chalk.gray(` (in ${countdown})`) : chalk.red(' (imminent)');
  return `${head} ${absolute}${rel}`;
}

/** The window we surface in the compact table: the tightest reported one. */
function headlineWindow(u) {
  if (!u.windows || !u.windows.length) return null;
  // Prefer the shortest window — that is the one that runs out first.
  return u.windows
    .slice()
    .sort((a, b) => (a.windowSeconds || Infinity) - (b.windowSeconds || Infinity))[0];
}

/** "used 42 · no capped allowance" style hint, or null. */
function creditsText(u) {
  const bits = [];
  if (u.credits?.unlimited) bits.push('unlimited credits');
  else if (u.credits?.hasCredits) bits.push('credits available');
  if (u.credits?.balance != null) bits.push(`balance ${u.credits.balance}`);
  if (u.resetCredits) bits.push(`${u.resetCredits} reset credit(s)`);
  return bits.length ? bits.join(' · ') : null;
}

/* ------------------------------------------------------------------ */

/**
 * Emit a JSON document on stdout and nothing else.
 *
 * The desktop GUI parses this, so it has to be the *only* thing on stdout:
 * no chalk, no trailing banner, no update notice. Written with
 * `process.stdout.write` rather than `console.log` so a pretty-printed
 * document keeps its own trailing newline instead of gaining a second one.
 */
function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function cmdList(argv) {
  const json = argv.includes('--json');
  // --json is a machine contract for the desktop GUI: it must never fan out
  // into a live usage fetch, or the caller gets a slow, network-dependent list.
  const live = !json && Boolean(argv.includes('--usage') || argv.includes('-u'));
  const accounts = listAccounts();
  const liveAuth = readLiveAuth();
  const liveId = liveAuth ? identityOf(liveAuth) : null;

  if (json) {
    writeJson(
      accounts.map((a) => ({
        name: a.name,
        email: a.email,
        displayName: a.displayName,
        plan: a.plan,
        status: a.status,
        expiresAt: a.expiresAt,
        isActive: Boolean(liveId && a.auth && identityOf(a.auth) === liveId),
        error: a.error || null,
      }))
    );
    return;
  }

  if (!accounts.length) {
    console.log();
    console.log(chalk.yellow('  No accounts archived yet.'));
    console.log(chalk.gray(`  Archive directory: ${accountsDir()}`));
    console.log(chalk.gray('  Run: ') + chalk.cyan(`${CMD} login <name>`));
    console.log();
    return;
  }

  console.log();
  console.log(chalk.bold.cyan('  Codex accounts') + chalk.gray(`  (${accounts.length})`));
  console.log(rule());
  console.log(
    '  ' +
      chalk.gray('#  ') +
      padVisible(chalk.bold('name'), 16) +
      padVisible(chalk.bold('account'), 34) +
      chalk.bold('token')
  );
  console.log(rule());

  for (const [i, a] of accounts.entries()) {
    const active = liveId && a.auth && identityOf(a.auth) === liveId;
    const marker = active ? chalk.green('▶') : chalk.gray(' ');
    const name = padVisible(active ? chalk.green.bold(a.name) : chalk.white(a.name), 16);
    const label = accountLabel(a);
    const expiry = a.expiresAt ? chalk.gray(humanExpiry(a.expiresAt)) : '';
    console.log(`  ${marker} ${chalk.gray(String(i + 1).padStart(2))} ${name}${label}${statusChip(a.status)} ${expiry}`);
  }

  console.log(rule());
  console.log(chalk.gray(`  live: ${authJsonPath()}`));
  console.log();

  if (live) await printUsageTable(accounts);
}

async function printUsageTable(accounts) {
  console.log(rule('live usage'));
  const gutter = Math.max(16, ...accounts.map((a) => a.name.length + 2));
  const indent = ' '.repeat(2 + gutter);
  for (const a of accounts) {
    if (!a.auth) {
      console.log(`  ${chalk.gray(a.name.padEnd(gutter))}${chalk.red('no credential')}`);
      continue;
    }
    console.log(`  ${chalk.bold.white(a.name.padEnd(gutter))}${chalk.gray(a.email || '')}`);
    try {
      const u = await fetchUsage(a.auth, {
        onTokenRefreshed: (tokens) => updateAccountTokens(a.name, tokens),
      });
      if (!u.ok) {
        console.log(`${indent}${chalk.red(`✖ ${u.error}`)}`);
        continue;
      }
      const w = headlineWindow(u);
      const pct = w ? w.usedPercent ?? (u.noCapReported ? 0 : null) : u.noCapReported ? 0 : null;
      const period = w ? `[${w.label}]` : '';
      console.log(
        `${indent}${paintBar(pct)} ${paintPercent(pct).padEnd(14)} ${chalk.gray(period)}`
      );
      const reset = resetLine(w ? w.resetAt : null);
      if (reset) console.log(`${indent}${' '.repeat(21)}${reset}`);
    } catch (err) {
      console.log(`${indent}${chalk.red(`✖ ${err.message}`)}`);
    }
  }
  console.log(rule());
  console.log();
}

/**
 * Fetch usage for each archive and flatten it into the JSON contract the
 * desktop GUI consumes.
 *
 * One row per account, always present — a failed fetch becomes `ok:false`
 * plus an `error` string rather than a missing row, so the GUI can show the
 * failure next to the account instead of silently dropping it.
 *
 * `windows` stays a *list*: Codex reports a 5h + 7d pair on paid plans but a
 * single 30-day window on free, so there is no fixed set of columns to map
 * onto.
 */
async function usageRows(accounts) {
  const rows = [];
  for (const a of accounts) {
    const row = {
      name: a.name,
      email: a.email,
      planType: a.plan || null,
      ok: false,
      error: null,
      limitReached: null,
      noCapReported: false,
      windows: [],
      credits: null,
      resetCredits: null,
      modelUsage: {},
    };

    if (!a.auth) {
      row.error = 'no credential';
      rows.push(row);
      continue;
    }

    try {
      const u = await fetchUsage(a.auth, {
        onTokenRefreshed: (tokens) => updateAccountTokens(a.name, tokens),
      });
      if (u.ok) {
        row.ok = true;
        row.planType = u.planType || a.plan || null;
        row.limitReached = u.limitReached;
        row.noCapReported = u.noCapReported;
        row.windows = u.windows;
        row.credits = u.credits;
        row.resetCredits = u.resetCredits;
        row.modelUsage = u.modelUsage;
      } else {
        row.error = u.error;
      }
    } catch (err) {
      row.error = err.message;
    }

    rows.push(row);
  }
  return rows;
}

async function cmdUsage(argv) {
  const json = argv.includes('--json');
  const only = argv.filter((a) => !a.startsWith('-'));
  const all = listAccounts();
  const accounts = only.length ? all.filter((a) => only.includes(a.name)) : all;

  if (json) {
    writeJson(await usageRows(accounts));
    return;
  }

  if (!accounts.length) {
    console.log();
    console.log(chalk.yellow('  Nothing to show. Archive an account first with ') + chalk.cyan(`${CMD} login <name>`));
    console.log();
    return;
  }

  console.log();
  console.log(chalk.bold.cyan('  Usage & quota'));
  console.log(rule());

  for (const a of accounts) {
    if (!a.auth) {
      console.log(`  ${chalk.white(a.name)} ${chalk.red('— no credential')}`);
      continue;
    }
    console.log(`  ${chalk.bold.white(a.name)} ${chalk.gray(a.email || '')}`);
    try {
      const u = await fetchUsage(a.auth, {
        onTokenRefreshed: (tokens) => updateAccountTokens(a.name, tokens),
      });
      if (!u.ok) {
        console.log(`    ${chalk.red('✖ ' + u.error)}`);
        console.log();
        continue;
      }
      if (u.planType) console.log(`    ${chalk.gray('plan')} ${chalk.white(u.planType)}`);
      for (const w of u.windows) {
        const pct = w.usedPercent ?? (u.noCapReported ? 0 : null);
        console.log(`    ${chalk.gray(w.label.padEnd(8))}${paintBar(pct)} ${paintPercent(pct)}`);
        if (w.remainingPercent != null) {
          console.log(`            ${chalk.gray(`${w.remainingPercent.toFixed(1)}% remaining`)}`);
        }
        const reset = resetLine(w.resetAt);
        if (reset) console.log(`            ${reset}`);
      }
      if (!u.windows.length) {
        console.log(`    ${chalk.gray('no rate-limit windows reported for this plan')}`);
      }
      const credits = creditsText(u);
      if (credits) console.log(`    ${chalk.gray(credits)}`);
      if (u.limitReached) console.log(`    ${chalk.red('rate limit reached')}`);
      for (const [model, pct] of Object.entries(u.modelUsage || {})) {
        console.log(`    ${chalk.gray(String(model).padEnd(14))} ${paintPercent(pct)}`);
      }
    } catch (err) {
      console.log(`    ${chalk.red('✖ ' + err.message)}`);
    }
    console.log();
  }
  console.log(rule());
  console.log();
}

async function cmdLogin(argv) {
  const name = argv.find((a) => !a.startsWith('-'));
  console.log();
  console.log(chalk.cyan('  Opening Codex CLI login…'));
  console.log(chalk.gray(`  binary: ${findCodexBinary()}`));
  console.log();

  const res = await login(name);
  console.log();
  console.log(chalk.green('  ✔ Saved account ') + chalk.bold.white(res.name));
  console.log(chalk.gray(`    ${displayName(res.auth)} <${emailOf(res.auth) || 'no email'}>`));
  console.log(chalk.gray(`    → ${res.file}`));
  console.log();
}

function cmdLogout(argv) {
  const force = argv.includes('--force') || argv.includes('-f');
  const name = argv.find((a) => !a.startsWith('-'));
  const res = logout({ name, force });

  console.log();
  if (!res.removed) {
    console.log(chalk.yellow('  No live auth.json — already signed out.'));
    if (res.removedLock) console.log(chalk.gray('    removed a stale auth.json.lock'));
  } else {
    console.log(chalk.green('  ✔ Signed out') + chalk.gray(`  (removed ${authJsonPath()})`));
    if (res.removedLock) console.log(chalk.gray(`    removed ${authJsonPath()}.lock`));
    if (res.backedUp) {
      console.log(
        chalk.gray('    archived to ') +
          chalk.white(res.backedUp) +
          (res.email ? chalk.gray(`  <${res.email}>`) : '')
      );
    } else if (res.kept) {
      console.log(chalk.gray(`    ${res.name}_auth.json already existed — left as-is (use -f to overwrite)`));
    } else {
      console.log(chalk.yellow('    no email in the live session — nothing to archive under'));
    }
  }
  console.log();
}

function cmdSwitch(argv) {
  const name = argv.find((a) => !a.startsWith('-'));
  if (!name) throw new Error(`usage: ${CMD} switch <name>`);
  const res = switchTo(name);
  console.log();
  console.log(chalk.green('  ✔ Active account: ') + chalk.bold.white(res.name));
  console.log(chalk.gray(`    ${displayName(res.auth)} <${emailOf(res.auth) || 'no email'}>`));
  console.log(chalk.gray('    Codex picks this up on the next launch (auth.json is read per session).'));
  console.log();
}

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

/**
 * Move the source checkout onto the remote branch tip and re-link the
 * global command.
 *
 * Uses syncToRemote() rather than `git pull` on purpose: the installer leaves
 * the checkout detached at FETCH_HEAD, where `git pull` is a no-op that
 * silently reports success. See src/version.js.
 */
function runUpdate({ quiet = false } = {}) {
  return syncToRemote({ quiet });
}

async function cmdUpdate(argv) {
  const checkOnly = argv.includes('--check') || argv.includes('-c');

  console.log();
  console.log(chalk.bold.cyan('  Checking for updates…'));
  console.log(chalk.gray(`  repo ${REPO} (${BRANCH})  ·  ${ROOT}`));
  console.log();

  const status = await checkForUpdate();
  if (!status.ok) {
    console.log(chalk.yellow(`  Could not check for updates: ${status.reason}`));
    if (status.current) console.log(chalk.gray(`  local ${shortSha(status.current)}`));
    console.log();
    return;
  }

  if (!status.behind) {
    console.log(chalk.green('  ✔ Already up to date') + chalk.gray(`  (${shortSha(status.current)})`));
    console.log();
    return;
  }

  console.log(chalk.yellow('  ↑ Update available'));
  console.log(chalk.gray('    local  ') + chalk.white(shortSha(status.current)));
  console.log(chalk.gray('    remote ') + chalk.white(shortSha(status.latest)));
  console.log();

  if (checkOnly) {
    console.log(chalk.gray('  Run ') + chalk.cyan(`${CMD} update`) + chalk.gray(' to install it.'));
    console.log();
    return;
  }

  console.log(chalk.gray('  Syncing to the latest commit…'));
  console.log();
  const pull = await runUpdate();
  if (!pull.ok) {
    if (pull.dirty) {
      console.log(chalk.red('  ✖ Local changes would be overwritten.'));
      console.log(chalk.gray(`    Commit or discard them in ${ROOT}, then retry.`));
    } else {
      console.log(chalk.red(`  ✖ Update failed${pull.error ? `: ${pull.error}` : ''}`));
      console.log(chalk.gray(`    The checkout may be offline, or ${ROOT} may not be a git clone.`));
      console.log(chalk.gray('    Re-running the installer will also refresh it.'));
    }
    console.log();
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log(chalk.gray('  Re-linking the global command…'));
  const link = await new Promise((resolve) => {
    const child = spawn('npm', ['link', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });

  console.log();
  console.log(chalk.green('  ✔ Updated to ') + chalk.bold.white(shortSha(pull.sha || status.latest)));
  if (!link.ok) {
    console.log(chalk.yellow('    npm link failed — the source is updated, but the global command may be stale.'));
  }
  console.log();
}

/**
 * One-line nudge shown after normal commands when a newer commit exists.
 * Populated asynchronously by the background check; flushed on exit so it
 * never delays the command the user actually ran.
 */
function updateNoticeLine() {
  const notice = globalThis.__csUpdateNotice;
  if (!notice) return null;
  return '  ' + chalk.gray('↑ update available ') + chalk.cyan(`${CMD} update`) + chalk.gray(`  (${shortSha(notice.latest)})`);
}

/** Print the pending notice (if any) once, on the way out. */
export function flushUpdateNotice() {
  if (globalThis.__csUpdateNoticeShown) return;
  const notice = updateNoticeLine();
  if (!notice) return;
  globalThis.__csUpdateNoticeShown = true;
  console.log();
  console.log(notice);
  console.log();
}

function cmdHelp() {
  console.log(`
${chalk.bold.cyan(`  ${CMD}`)} ${chalk.gray('— manage multiple Codex CLI accounts')}

${chalk.bold('  Usage')}
    ${chalk.cyan(`${CMD} login [name]`)}       Run ${chalk.gray('codex login')} then snapshot auth.json → ${chalk.gray('accounts/<name>_auth.json')}
    ${chalk.cyan(`${CMD} logout`)}              Archive auth.json as ${chalk.gray('accounts/<email>_auth.json')}, then delete it
    ${chalk.cyan(`${CMD} logout <name>`)}       Same, but archive under an explicit name
    ${chalk.cyan(`${CMD} logout -f`)}           Overwrite an existing archive instead of keeping it
    ${chalk.cyan(`${CMD} switch <name>`)}       Copy an archived account into the live auth.json
    ${chalk.cyan(`${CMD} list`)}                List archived accounts
    ${chalk.cyan(`${CMD} list --usage`)}        List accounts and fetch live quota
    ${chalk.cyan(`${CMD} usage [name...]`)}     Show plan, rate-limit windows & reset times
    ${chalk.cyan(`${CMD} update`)}              Check GitHub and pull the latest version
    ${chalk.cyan(`${CMD} update --check`)}      Only report whether an update is available
    ${chalk.cyan(`${CMD} where`)}               Print the resolved paths

${chalk.bold('  Machine-readable output')}
    ${chalk.cyan(`${CMD} list --json`)}         Account list as JSON (what the desktop GUI reads)
    ${chalk.cyan(`${CMD} usage --json`)}        Usage as JSON — one row per account, with a windows array
    ${chalk.cyan(`${CMD} where --json`)}        Resolved paths as JSON
    With ${chalk.gray('--json')} stdout carries the document and nothing else: no colour, no
    banners, and the background update notice is suppressed so it can't corrupt it.

${chalk.bold('  Usage output')}
    Each window shows a bar, a percentage, and when it rolls over, e.g.
    ${chalk.white('Resets: October 18, 21:37, 2026 (in 6d 2h)')} (local time; the
    countdown turns yellow inside a day, red once due).

${chalk.bold('  How it works')}
    ${chalk.gray('•')} Codex keeps its session in ${chalk.white('~/.codex/auth.json')} (a flat object with a tokens block).
    ${chalk.gray('•')} ${chalk.cyan('login')} runs the official CLI flow, then copies that file to
      ${chalk.white('~/.codex/accounts/<name>_auth.json')} — the archive.
    ${chalk.gray('•')} ${chalk.cyan('logout')} copies that file to ${chalk.white('accounts/<email>_auth.json')}
      first, then deletes ${chalk.white('auth.json')}.
    ${chalk.gray('•')} ${chalk.cyan('switch')} copies an archive back into auth.json.
    ${chalk.gray('•')} ${chalk.cyan('usage')} calls ${chalk.gray('chatgpt.com/backend-api/wham/usage')} with the
      stored token, refreshing via ${chalk.gray('auth.openai.com/oauth/token')} when stale.

${chalk.bold('  Environment')}
    ${chalk.gray('CODEX_HOME')}        override ~/.codex
    ${chalk.gray('CODEX_BIN')}         path to the codex executable
    ${chalk.gray('CODEX_NO_UPDATE_CHECK=1')}  disable the background update check
`);
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;

  // Suppress the background check when the user is already managing updates
  // directly, has opted out, or asked for machine-readable output — a stray
  // notice line would corrupt the JSON the caller is parsing.
  const wantsNotice =
    process.env.CODEX_NO_UPDATE_CHECK !== '1' &&
    cmd !== 'update' &&
    cmd !== 'upgrade' &&
    !argv.includes('--json');

  if (wantsNotice) {
    // Never let a slow network stall the real command: give the check a short
    // grace period, then print whatever the cache already knows.
    const check = cachedUpdateNotice()
      .then((notice) => {
        if (notice) globalThis.__csUpdateNotice = notice;
      })
      .catch(() => {});
    // Fire-and-forget; the notice is flushed at process exit by the entry point.
    check.finally(() => flushUpdateNotice());
  }

  switch (cmd) {
    case 'login':
    case 'add':
      return cmdLogin(rest);
    case 'logout':
      return cmdLogout(rest);
    case 'switch':
    case 'use':
      return cmdSwitch(rest);
    case 'list':
    case 'ls':
      return cmdList(rest);
    case 'usage':
      return cmdUsage(rest);
    case 'update':
    case 'upgrade':
      return cmdUpdate(rest);
    case 'where': {
      const codexBinary = findCodexBinary();
      if (rest.includes('--json')) {
        writeJson({
          authJson: authJsonPath(),
          accountsDir: accountsDir(),
          codexBinary,
        });
        return;
      }
      console.log();
      console.log(chalk.gray('  codex home   ') + chalk.white(authJsonPath()));
      console.log(chalk.gray('  archives     ') + chalk.white(accountsDir()));
      console.log(chalk.gray('  codex binary ') + chalk.white(codexBinary));
      console.log();
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return cmdHelp();
    default:
      console.log(chalk.yellow(`  Unknown command "${cmd}"`));
      return cmdHelp();
  }
}
