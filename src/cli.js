import { spawn } from 'node:child_process';

import chalk from 'chalk';

import {
  listAccounts,
  readLiveAuth,
  displayName,
  emailOf,
  planTypeOf,
  sameAccount,
  humanExpiry,
  tokenStatus,
  updateAccountTokens,
} from './accounts.js';
import { fetchUsage, formatResetTime, formatCountdown, daysUntil, parseInstant } from './usage.js';
import { login, logout, switchTo, findCodexBinary } from './commands.js';
import { accountsDir, authJsonPath } from './paths.js';
import { ROOT, REPO, BRANCH, checkForUpdate, cachedUpdateNotice, syncToRemote, shortSha, appVersion } from './version.js';
import {
  accent,
  warning,
  failure,
  displayWidth,
  padVisible,
  truncateVisible,
  tag,
  planBadge,
  activeBadge,
  statusChip,
  paintPercent,
  paintBar,
  frameWidth,
  renderCard,
  renderTable,
  renderCommandHeader,
  sectionRule,
  withProgress,
  suggestCommand,
} from './ui.js';

const CMD = 'MultiCodexState';
const KNOWN_COMMANDS = ['login', 'add', 'logout', 'switch', 'use', 'list', 'ls', 'usage', 'update', 'upgrade', 'where', 'help'];

/**
 * The "account" column. The email is the field that actually distinguishes
 * two archives, so it leads; the plan badge is appended cleanly.
 */
function accountLabel(a, width = 30) {
  if (!a.email) {
    const fallback = a.displayName && a.displayName !== a.name ? a.displayName : '(no email)';
    return padVisible(chalk.gray(truncateVisible(fallback, width)), width);
  }

  const badge = a.plan ? planBadge(a.plan) : '';
  if (!badge) {
    return padVisible(chalk.white(truncateVisible(a.email, width)), width);
  }

  const badgeW = displayWidth(badge);
  const emailMax = Math.max(8, width - badgeW - 2);
  const emailText = truncateVisible(a.email, emailMax);
  const composed = `${chalk.white(emailText)}  ${badge}`;
  return padVisible(composed, width);
}

/**
 * "Resets: October 18, 21:37, 2026 (in 6d 3h)" — the full reset line.
 *
 * The absolute date always carries the year, because a weekly window can roll
 * over into the next month and "October 18" alone stops being unambiguous.
 * Colour shifts to yellow/red as the reset approaches, so an imminent
 * rollover is obvious at a glance.
 *
 * `WindowViewModel.ResetText` in the GUI builds the same string from the same
 * epoch-ms value — keep the two in step.
 */
function resetLine(value, { label = 'Resets' } = {}) {
  if (parseInstant(value) == null) return null;
  const when = formatResetTime(value, { withYear: true });
  const countdown = formatCountdown(value);
  const days = daysUntil(value);

  const head = chalk.gray(`${label}:`);
  const paint =
    days != null && days <= 0
      ? failure
      : days != null && days <= 1
        ? warning
        : chalk.white;
  const absolute = paint(when);
  const rel =
    countdown && countdown !== 'now'
      ? chalk.gray(` (in ${countdown})`)
      : failure.bold(' (imminent)');
  return `${head} ${absolute}${rel}`;
}

/** "used 42 · no capped allowance" style hint, or null. */
function creditsText(u) {
  const bits = [];
  if (u.credits?.unlimited) bits.push('unlimited credits');
  else if (u.credits?.hasCredits) bits.push('credits available');
  if (u.credits?.balance != null) bits.push(`balance ${u.credits.balance}`);
  if (u.resetCredits != null) bits.push(`${u.resetCredits} reset credit(s)`);
  return bits.length ? bits.join(' · ') : null;
}

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

/* ------------------------------------------------------------------ */
/* Usage cards & fleet summary                                         */
/* ------------------------------------------------------------------ */

function renderUsageCard(a, usageResult, { active = false, width = frameWidth(), showTokenStatus = false } = {}) {
  const limitHit = Boolean(usageResult?.limitReached);

  const marker = active ? accent.bold('▶') : ' ';
  const nameText = active ? accent.bold(a.name) : chalk.white.bold(a.name);
  const plan = usageResult?.planType || a.plan;

  const badges = [
    active ? activeBadge() : '',
    planBadge(plan),
    limitHit ? tag('LIMIT REACHED') : '',
  ].filter(Boolean);

  const title = badges.length ? `${marker} ${nameText}  ${badges.join(' ')}` : `${marker} ${nameText}`;
  const identityLabel = a.email || (a.displayName && a.displayName !== a.name ? a.displayName : '');
  const titleRight = identityLabel ? chalk.white(identityLabel) : '';

  const lines = [];
  if (showTokenStatus) {
    const exp = a.expiresAt ? chalk.gray(` (${humanExpiry(a.expiresAt)})`) : '';
    lines.push(`${chalk.gray('token')}     ${statusChip(a.status)}${exp}`);
  }

  if (!a.auth) {
    lines.push(failure.bold('✖ no credential'));
    return renderCard({ title, titleRight, lines, width });
  }

  if (!usageResult?.ok) {
    lines.push(failure.bold(`✖ ${usageResult?.error || 'unknown error'}`));
    return renderCard({ title, titleRight, lines, width });
  }

  const windows = usageResult.windows
    .slice()
    .sort((x, y) => (x.windowSeconds || Infinity) - (y.windowSeconds || Infinity));

  for (const w of windows) {
    const pct = w.usedPercent ?? (usageResult.noCapReported ? 0 : null);
    const tag = padVisible(accent.bold(`[${w.label}]`), 10);
    const pctText = padVisible(paintPercent(pct), 6, 'right');
    const rem = w.remainingPercent != null ? chalk.gray(`  · ${w.remainingPercent.toFixed(1)}% remaining`) : '';
    lines.push(`${tag}${paintBar(pct, 22)}  ${pctText}${rem}`);
    const reset = resetLine(w.resetAt);
    if (reset) lines.push(`${' '.repeat(10)}${reset}`);
  }

  if (!windows.length && usageResult.noCapReported) {
    const tag = padVisible(chalk.gray('[window]'), 10);
    lines.push(`${tag}${paintBar(0, 22)}  ${padVisible(paintPercent(0), 6, 'right')}${chalk.gray('  · no cap reported')}`);
  } else if (!windows.length) {
    lines.push(chalk.gray('no rate-limit windows reported for this plan'));
  }

  const credits = creditsText(usageResult);
  if (credits) {
    lines.push(`${chalk.white(credits)}`);
  }
  if (usageResult.limitReached) {
    lines.push(failure.bold('✖ rate limit reached'));
  }

  const modelEntries = Object.entries(usageResult.modelUsage || {});
  if (modelEntries.length) {
    lines.push('---');
    for (const [model, pct] of modelEntries) {
      const mLabel = padVisible(chalk.gray(truncateVisible(String(model), 15)), 16);
      lines.push(`${mLabel}${paintBar(pct, 16)}  ${padVisible(paintPercent(pct), 6, 'right')}`);
    }
  }

  return renderCard({ title, titleRight, lines, width });
}

function renderHeadroomSummary(results, width = frameWidth()) {
  const candidates = results
    .filter((r) => r.usage?.ok && !r.usage.limitReached && r.usage.windows.length > 0)
    .map((r) => {
      const maxUsed = Math.max(...r.usage.windows.map((w) => Number(w.usedPercent ?? 0)));
      const shortest = r.usage.windows
        .slice()
        .sort((x, y) => (x.windowSeconds || Infinity) - (y.windowSeconds || Infinity))[0];
      return {
        name: r.account.name,
        active: r.active,
        maxUsed,
        primaryUsed: Number(shortest?.usedPercent ?? maxUsed),
      };
    });

  if (candidates.length < 2) return null;

  candidates.sort((a, b) => {
    if (a.maxUsed !== b.maxUsed) return a.maxUsed - b.maxUsed;
    if (a.primaryUsed !== b.primaryUsed) return a.primaryUsed - b.primaryUsed;
    return a.active === b.active ? 0 : a.active ? -1 : 1;
  });

  const best = candidates[0];
  const msg = best.active
    ? `${chalk.gray('Active account')} ${accent.bold(best.name)} ${chalk.gray(`has optimal headroom (${best.maxUsed.toFixed(1)}% max used)`)}`
    : `${chalk.gray('Most available quota:')} ${chalk.white.bold(best.name)} ${chalk.gray(`(${best.maxUsed.toFixed(1)}% max used ·`)} ${accent(`${CMD} switch ${best.name}`)}${chalk.gray(')')}`;

  return renderCard({
    lines: [msg],
    width,
  });
}

async function fetchAccountUsageWithProgress(account) {
  if (!account.auth) return { ok: false, error: 'no credential' };
  try {
    return await withProgress(`Fetching live quota for ${account.name}…`, () =>
      fetchUsage(account.auth, {
        onTokenRefreshed: (tokens) => updateAccountTokens(account.name, tokens),
      })
    );
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

function vaultStatsLine(accounts, liveAuth) {
  const counts = { valid: 0, expiring: 0, expired: 0, invalid: 0, unknown: 0 };
  for (const a of accounts) {
    counts[a.status] = (counts[a.status] || 0) + 1;
  }
  const bits = [];
  if (counts.valid) bits.push(accent(`${counts.valid} valid`));
  if (counts.expiring) bits.push(warning(`${counts.expiring} expiring`));
  const bad = counts.expired + counts.invalid;
  if (bad) bits.push(failure(`${bad} expired or invalid`));
  if (counts.unknown) bits.push(chalk.gray(`${counts.unknown} unknown`));

  const health = bits.join(chalk.gray(' · ')) || chalk.gray('empty');
  const liveState = liveAuth ? chalk.gray(`live: ${authJsonPath()}`) : chalk.gray('live: signed out');
  return `${health}   ${chalk.gray('│')}   ${liveState}`;
}

async function cmdList(argv) {
  const json = argv.includes('--json');
  // --json is a machine contract for the desktop GUI: it must never fan out
  // into a live usage fetch, or the caller gets a slow, network-dependent list.
  const live = !json && Boolean(argv.includes('--usage') || argv.includes('-u'));
  const accounts = listAccounts();
  const liveAuth = readLiveAuth();

  if (json) {
    writeJson(
      accounts.map((a) => ({
        name: a.name,
        email: a.email,
        displayName: a.displayName,
        plan: a.plan,
        status: a.status,
        expiresAt: a.expiresAt,
        isActive: Boolean(liveAuth && a.auth && sameAccount(liveAuth, a.auth)),
        error: a.error || null,
      }))
    );
    return;
  }

  const width = frameWidth();

  if (!accounts.length) {
    console.log();
    console.log(
      renderCard({
        title: accent.bold('Accounts'),
        titleRight: tag('0 accounts'),
        lines: [
          warning.bold('No accounts archived yet.'),
          chalk.gray('Archive directory: ') + chalk.white(accountsDir()),
          chalk.gray('Run ') + accent.bold(`${CMD} login <name>`) + chalk.gray(' to sign in and snapshot an account.'),
        ],
        width,
      })
    );
    console.log();
    return;
  }

  const activeAcc = liveAuth ? accounts.find((a) => a.auth && sameAccount(liveAuth, a.auth)) : null;
  const activePill = activeAcc
    ? tag(`Active: ${activeAcc.name}`)
    : liveAuth
      ? tag('Unarchived session')
      : tag('Signed out');
  const countPill = tag(`${accounts.length} ACCOUNT${accounts.length === 1 ? '' : 'S'}`);

  console.log();
  console.log(
    renderCommandHeader({
      title: 'Accounts',
      badges: [countPill, activePill],
      subtitle: vaultStatsLine(accounts, liveAuth),
      width,
    })
  );

  const rows = accounts.map((a, i) => {
    const active = Boolean(liveAuth && a.auth && sameAccount(liveAuth, a.auth));
    const marker = active ? accent.bold('▶') : ' ';
    const indexCol = `${marker} ${chalk.gray(String(i + 1).padStart(2))}`;
    const nameCol = active ? accent.bold(a.name) : chalk.white.bold(a.name);
    const accountCol = accountLabel(a, 30);
    let expiryText = a.expiresAt ? humanExpiry(a.expiresAt) : '';
    if (a.status === 'expired') expiryText = expiryText.replace(/^expired\s+/i, '');
    const tokenCol = `${statusChip(a.status)}${expiryText ? chalk.gray(` ${expiryText}`) : ''}`;
    return [indexCol, nameCol, accountCol, tokenCol];
  });

  console.log(
    renderTable({
      columns: [
        { label: '#', width: 4 },
        { label: 'NAME', width: 14 },
        { label: 'ACCOUNT', width: 30 },
        { label: 'TOKEN', width: 18 },
      ],
      rows,
      width,
    })
  );

  console.log(`  ${chalk.gray('vault')}  ${chalk.white(accountsDir())}`);
  if (!live) {
    console.log(
      `  ${chalk.gray('Run')} ${accent(`${CMD} list --usage`)} ${chalk.gray('(-u) for live quota and reset times')}`
    );
  }
  console.log();

  if (live) await printUsageTable(accounts, liveAuth);
}

async function printUsageTable(accounts, liveAuth) {
  const width = frameWidth();
  console.log(sectionRule('Quota usage', width));
  console.log();

  const results = [];
  for (const a of accounts) {
    const active = Boolean(liveAuth && a.auth && sameAccount(liveAuth, a.auth));
    const u = await fetchAccountUsageWithProgress(a);
    results.push({ account: a, active, usage: u });
    console.log(renderUsageCard(a, u, { active, width }));
  }

  const summary = renderHeadroomSummary(results, width);
  if (summary) console.log(summary);
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
  const liveAuth = readLiveAuth();

  if (json) {
    writeJson(await usageRows(accounts));
    return;
  }

  const width = frameWidth();

  if (!accounts.length) {
    console.log();
    console.log(
      renderCard({
        title: accent.bold('Quota usage'),
        lines: [
          warning('Nothing to show yet.'),
          chalk.gray('Archive an account first with ') + accent.bold(`${CMD} login <name>`),
        ],
        width,
      })
    );
    console.log();
    return;
  }

  console.log();
  console.log(
    renderCommandHeader({
      title: 'Quota usage',
      badges: [tag(`${accounts.length} TARGET${accounts.length === 1 ? '' : 'S'}`)],
      subtitle: chalk.gray('Reported usage by account'),
      width,
    })
  );

  const results = [];
  for (const a of accounts) {
    const active = Boolean(liveAuth && a.auth && sameAccount(liveAuth, a.auth));
    const u = await fetchAccountUsageWithProgress(a);
    results.push({ account: a, active, usage: u });
    console.log(renderUsageCard(a, u, { active, width, showTokenStatus: true }));
  }

  const summary = renderHeadroomSummary(results, width);
  if (summary) console.log(summary);
  console.log();
}

async function cmdLogin(argv) {
  const name = argv.find((a) => !a.startsWith('-'));
  const width = frameWidth();

  console.log();
  console.log(
    renderCard({
      title: accent.bold('Sign in'),
      titleRight: tag(name ? `AS ${name}` : 'AUTO NAME'),
      lines: [
        chalk.white('Launching official Codex CLI browser OAuth flow…'),
        chalk.gray('binary  ') + chalk.gray(findCodexBinary()),
      ],
      width,
    })
  );
  console.log();

  const res = await login(name);
  const st = tokenStatus(res.auth);
  const plan = planTypeOf(res.auth);
  const email = emailOf(res.auth);

  console.log();
  console.log(
    renderCard({
      title: accent.bold('✔ ACCOUNT ARCHIVED & ACTIVE'),
      titleRight: [activeBadge(), planBadge(plan)].filter(Boolean).join(' '),
      lines: [
        `${chalk.gray('account  ')}${accent.bold(res.name)}  ${chalk.gray(`(${displayName(res.auth)})`)}`,
        `${chalk.gray('email    ')}${chalk.white(email || 'no email')}`,
        `${chalk.gray('token    ')}${statusChip(st.state)}${st.expiresAt ? chalk.gray(` (${humanExpiry(st.expiresAt)})`) : ''}`,
        `${chalk.gray('saved →  ')}${accent(res.file)}`,
      ],
      width,
    })
  );
  console.log();
}

function cmdLogout(argv) {
  const force = argv.includes('--force') || argv.includes('-f');
  const name = argv.find((a) => !a.startsWith('-'));
  const res = logout({ name, force });
  const width = frameWidth();

  console.log();
  if (!res.removed) {
    const lines = [warning.bold('○ No live auth.json — already signed out.')];
    if (res.removedLock) lines.push(chalk.gray('cleaned up a stale auth.json.lock'));
    console.log(
      renderCard({
        title: accent.bold('Sign out'),
        lines,
        width,
      })
    );
    console.log();
    return;
  }

  const lines = [
    `${chalk.gray('removed  ')}${chalk.white(authJsonPath())}`,
  ];
  if (res.removedLock) lines.push(`${chalk.gray('cleaned  ')}${chalk.gray(`${authJsonPath()}.lock`)}`);
  if (res.backedUp) {
    lines.push(
      `${chalk.gray('archived ')}${accent.bold(res.backedUp)}${res.email ? chalk.gray(`  <${res.email}>`) : ''}`
    );
  } else if (res.kept) {
    lines.push(
      warning(`kept existing ${res.name}_auth.json untouched `) + chalk.gray('(pass -f to overwrite)')
    );
  } else {
    lines.push(warning('no email in live session — signed out without archiving'));
  }

  console.log(
    renderCard({
      title: accent.bold('✔ SIGNED OUT'),
      titleRight: res.backedUp ? tag('ARCHIVED') : tag('CLEARED'),
      lines,
      width,
    })
  );
  console.log();
}

function cmdSwitch(argv) {
  const name = argv.find((a) => !a.startsWith('-'));
  if (!name) throw new Error(`usage: ${CMD} switch <name>`);
  const res = switchTo(name);
  const width = frameWidth();
  const plan = planTypeOf(res.auth);
  const st = tokenStatus(res.auth);

  console.log();
  console.log(
    renderCard({
      title: accent.bold('✔ SWITCHED ACTIVE ACCOUNT'),
      titleRight: [activeBadge(), planBadge(plan)].filter(Boolean).join(' '),
      lines: [
        `${accent.bold('▶')} ${accent.bold(res.name)}  ${chalk.gray(`${displayName(res.auth)} <${emailOf(res.auth) || 'no email'}>`)}`,
        `${chalk.gray('token    ')}${statusChip(st.state)}${st.expiresAt ? chalk.gray(` (${humanExpiry(st.expiresAt)})`) : ''}`,
        `${chalk.gray('note     ')}Codex picks this up on the next launch (written 0600)`,
      ],
      width,
    })
  );
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
  const interactive = Boolean(process.stdout.isTTY);

  // When captured by the desktop GUI or a script (!isTTY), emit crisp,
  // status-bar-friendly text without multi-line decorative borders.
  if (!interactive) {
    const status = await checkForUpdate();
    if (!status.ok) {
      console.log(`Could not check for updates: ${status.reason}${status.current ? ` (${shortSha(status.current)})` : ''}`);
      return;
    }
    if (!status.behind) {
      console.log(`✔ Already up to date (${shortSha(status.current)})`);
      return;
    }
    if (checkOnly) {
      console.log(`↑ Update available: ${shortSha(status.current)} → ${shortSha(status.latest)} (run ${CMD} update)`);
      return;
    }
    const pull = await runUpdate({ quiet: true });
    if (!pull.ok) {
      if (pull.dirty) {
        console.log(`✖ Local changes in ${ROOT} would be overwritten.`);
      } else {
        console.log(`✖ Update failed${pull.error ? `: ${pull.error}` : ''}`);
      }
      process.exitCode = 1;
      return;
    }
    const link = await new Promise((resolve) => {
      const child = spawn('npm', ['link', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: ROOT,
        stdio: 'ignore',
        shell: process.platform === 'win32',
      });
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      child.on('close', (code) => resolve({ ok: code === 0, code }));
    });
    console.log(
      link.ok
        ? `✔ Updated to ${shortSha(pull.sha || status.latest)}`
        : `✔ Updated to ${shortSha(pull.sha || status.latest)} (npm link failed — global command may be stale)`
    );
    return;
  }

  const width = frameWidth();
  console.log();
  console.log(
    renderCommandHeader({
      title: 'Update',
      badges: [tag(`v${appVersion()}`)],
      subtitle: chalk.gray(`repo ${REPO} (${BRANCH})  ·  ${ROOT}`),
      width,
    })
  );

  const status = await withProgress('Checking GitHub for the latest commit…', () => checkForUpdate());
  if (!status.ok) {
    console.log(
      renderCard({
        title: warning.bold('▲ COULD NOT CHECK FOR UPDATES'),
        lines: [
          warning(status.reason),
          ...(status.current ? [chalk.gray('local   ') + chalk.white(shortSha(status.current))] : []),
        ],
        width,
      })
    );
    console.log();
    return;
  }

  if (!status.behind) {
    console.log(
      renderCard({
        title: accent.bold('✔ ALREADY UP TO DATE'),
        titleRight: tag(shortSha(status.current)),
        lines: [chalk.gray('Your installation matches the tip of ') + chalk.white(`${REPO}@${BRANCH}`)],
        width,
      })
    );
    console.log();
    return;
  }

  console.log(
    renderCard({
      title: warning.bold('↑ UPDATE AVAILABLE'),
      titleRight: tag(`${shortSha(status.current)} → ${shortSha(status.latest)}`),
      lines: [
        `${chalk.gray('local   ')}${chalk.white(shortSha(status.current))}`,
        `${chalk.gray('remote  ')}${accent.bold(shortSha(status.latest))}`,
        ...(checkOnly
          ? [`${chalk.gray('run     ')}${accent.bold(`${CMD} update`)} ${chalk.gray('to install it')}`]
          : []),
      ],
      width,
    })
  );

  if (checkOnly) {
    console.log();
    return;
  }

  const pull = await withProgress('Syncing repository to latest commit…', () => runUpdate({ quiet: true }));
  if (!pull.ok) {
    const lines = pull.dirty
      ? [
          failure.bold('✖ Local changes would be overwritten.'),
          chalk.gray(`Commit or discard them in ${ROOT}, then retry.`),
        ]
      : [
          failure.bold(`✖ Update failed${pull.error ? `: ${pull.error}` : ''}`),
          chalk.gray(`The checkout may be offline, or ${ROOT} may not be a git clone.`),
          chalk.gray('Re-running the installer will also refresh it.'),
        ];
    console.log(
      renderCard({
        title: failure.bold('✖ UPDATE FAILED'),
        lines,
        width,
      })
    );
    console.log();
    process.exitCode = 1;
    return;
  }

  const link = await withProgress('Re-linking global command…', () =>
    new Promise((resolve) => {
      const child = spawn('npm', ['link', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: ROOT,
        stdio: 'ignore',
        shell: process.platform === 'win32',
      });
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      child.on('close', (code) => resolve({ ok: code === 0, code }));
    })
  );

  const lines = [
    `${chalk.gray('commit   ')}${accent.bold(shortSha(pull.sha || status.latest))}`,
    link.ok
      ? `${chalk.gray('command  ')}${accent('✔ global MultiCodexState link refreshed')}`
      : `${chalk.gray('command  ')}${warning('▲ npm link failed — source updated, global command may be stale')}`,
  ];
  console.log(
    renderCard({
      title: accent.bold('✔ UPDATED'),
      titleRight: tag(shortSha(pull.sha || status.latest)),
      lines,
      width,
    })
  );
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
  const badge = tag('UPDATE AVAILABLE');
  const sha = tag(shortSha(notice.latest));
  return `  ${badge}  ${chalk.gray('run')} ${accent.bold(`${CMD} update`)}  ${sha}`;
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

/* ------------------------------------------------------------------ */
/* Help & paths                                                        */
/* ------------------------------------------------------------------ */

function cmdHelp() {
  const commands = [
    ['login [name]', 'Sign in and archive an account (alias: add)'],
    ['logout [name]', 'Archive the live session and sign out (-f to overwrite)'],
    ['switch <name>', 'Activate a saved account (alias: use)'],
    ['list', 'List local accounts (alias: ls)'],
    ['list --usage', 'Include live quota and reset times (-u)'],
    ['usage [name...]', 'Show quota for all or selected accounts'],
    ['where', 'Show credential, archive and executable paths'],
    ['update', 'Install the latest version (alias: upgrade, --check to inspect)'],
  ];
  const narrow = process.stdout.columns && process.stdout.columns < 72;
  console.log(`\n  ${accent.bold(CMD)}  ${chalk.gray('v' + appVersion())}`);
  console.log(`  Usage: ${CMD} <command>\n`);
  for (const [command, description] of commands) {
    const label = chalk.bold(narrow ? command : padVisible(command, 17));
    console.log(`  ${label}${narrow ? '\n    ' : '  '}${chalk.gray(description)}`);
  }
  console.log('\n  Use --json with list, usage, or where for machine-readable output.');
  console.log(chalk.gray('  Paths: CODEX_HOME, CODEX_STATE_HOME, CODEX_BIN'));
  console.log(chalk.gray('  Options: MULTICODEXSTATE_THEME, CODEX_NO_UPDATE_CHECK=1\n'));
}

function cmdWhere(rest) {
  const codexBinary = findCodexBinary();
  if (rest.includes('--json')) {
    writeJson({
      authJson: authJsonPath(),
      accountsDir: accountsDir(),
      codexBinary,
    });
    return;
  }

  const width = frameWidth();
  const liveAuth = readLiveAuth();
  const count = listAccounts().length;

  console.log();
  console.log(
    renderCard({
      title: accent.bold('Local paths'),
      titleRight: tag(`v${appVersion()}`),
      lines: [
        `${chalk.gray('codex home   ')}${chalk.white(authJsonPath())}  ${liveAuth ? tag('LIVE') : tag('ABSENT')}`,
        `${chalk.gray('archives     ')}${chalk.white(accountsDir())}  ${tag(`${count} ARCHIVED`)}`,
        `${chalk.gray('codex binary ')}${accent(codexBinary)}`,
      ],
      width,
    })
  );
  console.log();
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
    case 'where':
      return cmdWhere(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return cmdHelp();
    default: {
      const suggestion = suggestCommand(cmd, KNOWN_COMMANDS);
      const hint = suggestion ? chalk.gray(' — did you mean ') + accent.bold(suggestion) + chalk.gray('?') : '';
      console.log();
      console.log(`  ${tag('UNKNOWN')}  ${warning(`Unknown command "${cmd}"`)}${hint}`);
      return cmdHelp();
    }
  }
}
