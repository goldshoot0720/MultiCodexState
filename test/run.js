#!/usr/bin/env node
/**
 * Offline test harness for MultiCodexState.
 *
 * Never touches the real ~/.codex. It creates a throwaway CODEX_HOME, seeds
 * fake accounts, and points the code at a local mock server that reproduces
 * the Codex usage endpoint — including the 401 → refresh → 200 flow.
 *
 * The mock URL is injected through CODEX_USAGE_URL /
 * CODEX_REFRESH_TOKEN_URL_OVERRIDE, so **src/usage.js is never rewritten on
 * disk**. (An earlier generation of this tool patched its source in place and
 * restored it in a `finally` block; a killed run left the real CLI pointing at
 * a dead localhost port. Section 9 guards against that regression.)
 *
 *   node test/run.js            run all checks
 *   node test/run.js --keep     keep the sandbox for manual poking
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const KEEP = process.argv.includes('--keep');

/* ------------------------------------------------------------------ */
/* Tiny test runner                                                    */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n  ${name}`);
}

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`    \u001b[32m✔\u001b[0m ${label}`);
  } else {
    failures.push(`${currentSection} → ${label}${detail ? `\n      ${detail}` : ''}`);
    console.log(`    \u001b[31m✖\u001b[0m ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ */
/* Sandbox                                                             */
/* ------------------------------------------------------------------ */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'multicodexstate-test-'));
const codexHome = path.join(sandbox, 'codexhome');
const accountsDir = path.join(codexHome, 'accounts');
fs.mkdirSync(accountsDir, { recursive: true });

process.env.CODEX_HOME = codexHome;
process.env.CODEX_NO_UPDATE_CHECK = '1';

/* ------------------------------------------------------------------ */
/* Mock server                                                         */
/* ------------------------------------------------------------------ */

const STALE_ACCESS = 'stale.access.token';
const FRESH_ACCESS = 'fresh.access.token';
const FRESH_REFRESH = 'rt.1.fresh';

const mock = {
  mode: 'ok', // 'ok' | 'refresh' | 'hard401'
  usageStatus: 200,
  usagePayload: null,
  tokenStatus: 200,
  calls: { usage: 0, token: 0 },
  seenAuth: [],
  seenAccountHeader: [],
};

function defaultUsagePayload() {
  return {
    user_id: 'user-test',
    account_id: 'acct-test',
    email: 'tester@example.com',
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 42.5,
        limit_window_seconds: 18_000,
        reset_after_seconds: 3600,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
      },
      secondary_window: {
        used_percent: 12,
        limit_window_seconds: 604_800,
        reset_after_seconds: 86_400,
        reset_at: Math.floor(Date.now() / 1000) + 86_400,
      },
    },
    credits: { has_credits: false, unlimited: false, balance: null },
    rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 },
    model_usage: {},
  };
}
mock.usagePayload = defaultUsagePayload();

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.url.startsWith('/usage')) {
    mock.calls.usage += 1;
    const auth = req.headers.authorization || '';
    mock.seenAuth.push(auth);
    mock.seenAccountHeader.push(req.headers['chatgpt-account-id'] || null);

    if (mock.mode === 'hard401') return send(401, { error: 'unauthorized' });
    if (mock.mode === 'refresh' && auth === `Bearer ${STALE_ACCESS}`) {
      return send(401, { error: 'expired' });
    }
    return send(mock.usageStatus, mock.usagePayload);
  }

  if (req.url.startsWith('/token')) {
    mock.calls.token += 1;
    if (mock.mode === 'hard401' || mock.tokenStatus !== 200) {
      return send(mock.tokenStatus, { error: 'invalid_grant' });
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      send(200, {
        access_token: FRESH_ACCESS,
        refresh_token: FRESH_REFRESH,
        id_token: 'fresh.id.token',
        expires_in: 3600,
      });
    });
    return undefined;
  }

  return send(404, { error: 'not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
process.env.CODEX_USAGE_URL = `${base}/usage`;
process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = `${base}/token`;

/* ------------------------------------------------------------------ */
/* Imports (after env is set — usage.js reads URLs at module load)     */
/* ------------------------------------------------------------------ */

const usage = await import('../src/usage.js');
const accounts = await import('../src/accounts.js');
const commands = await import('../src/commands.js');
const paths = await import('../src/paths.js');
const version = await import('../src/version.js');

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt(claims) {
  return `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`;
}

function makeAuth({ email, accountId, name, plan, accessToken, refreshToken, expSeconds }) {
  const exp = expSeconds ?? Math.floor(Date.now() / 1000) + 86400 * 7;
  const idToken = makeJwt({
    email,
    name,
    exp,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: plan,
    },
  });
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: accessToken || makeJwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
      refresh_token: refreshToken || `rt.1.${accountId}`,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
}

const ALPHA = makeAuth({
  email: 'alpha@example.com',
  accountId: 'acct-alpha',
  name: 'Alpha Person',
  plan: 'plus',
});
const BETA = makeAuth({
  email: 'beta@example.com',
  accountId: 'acct-beta',
  name: 'Beta Person',
  plan: 'pro',
  expSeconds: Math.floor(Date.now() / 1000) - 60, // expired
});

/* ------------------------------------------------------------------ */
/* 1. paths                                                            */
/* ------------------------------------------------------------------ */

section('1. paths & name sanitising');

eq('sanitizeName strips spaces to underscores', paths.sanitizeName('my acct'), 'my_acct');
eq('sanitizeName drops path separators', paths.sanitizeName('a/b\\c'), 'abc');
eq('sanitizeName keeps dots and dashes', paths.sanitizeName('a.b-c_d'), 'a.b-c_d');
eq('accountNameFromFile round-trips', paths.accountNameFromFile('/x/alpha_auth.json'), 'alpha');
eq('authJsonPath honours CODEX_HOME', paths.authJsonPath(), path.join(codexHome, 'auth.json'));
eq('accountsDir lives under codexHome', paths.accountsDir(), accountsDir);

// A traversal attempt is neutralised by sanitising (the separators are
// stripped), so the resulting path must still land inside the accounts dir.
const traversalFile = paths.accountFilePath('../../etc/passwd');
check(
  'a traversal name is contained inside the accounts dir',
  path.dirname(path.resolve(traversalFile)) === path.resolve(accountsDir),
  traversalFile
);

let emptyNameRejected = false;
try {
  paths.accountFilePath('///');
} catch {
  emptyNameRejected = true;
}
check('accountFilePath rejects a name that sanitises to nothing', emptyNameRejected);

/* ------------------------------------------------------------------ */
/* 2. JWT / identity                                                   */
/* ------------------------------------------------------------------ */

section('2. auth parsing & identity');

eq('jwtClaims reads email', accounts.emailOf(ALPHA), 'alpha@example.com');
eq('planTypeOf reads the OpenAI auth claim', accounts.planTypeOf(ALPHA), 'plus');
eq('accountIdOf reads tokens.account_id', accounts.accountIdOf(ALPHA), 'acct-alpha');
eq('identityOf prefers account_id', accounts.identityOf(ALPHA), 'acct-alpha');
eq('displayName uses the profile name', accounts.displayName(ALPHA), 'Alpha Person');
check('hasCredential true for a token payload', accounts.hasCredential(ALPHA));
check('hasCredential false for an empty object', !accounts.hasCredential({}));
eq('jwtClaims tolerates a malformed token', JSON.stringify(accounts.jwtClaims('not-a-jwt')), '{}');

const alphaStatus = accounts.tokenStatus(ALPHA);
eq('tokenStatus marks a future token valid', alphaStatus.state, 'valid');
const betaStatus = accounts.tokenStatus(BETA);
eq('tokenStatus marks a past token expired', betaStatus.state, 'expired');
check('humanExpiry renders an expired delta', /expired/.test(accounts.humanExpiry(betaStatus.expiresAt)));

/* ------------------------------------------------------------------ */
/* 3. time parsing                                                     */
/* ------------------------------------------------------------------ */

section('3. timestamp parsing');

const epochSec = 1_794_077_437;
eq('parseInstant reads epoch seconds', usage.parseInstant(epochSec), epochSec * 1000);
eq('parseInstant reads epoch milliseconds', usage.parseInstant(epochSec * 1000), epochSec * 1000);
eq(
  'parseInstant reads an RFC 3339 string',
  usage.parseInstant('2026-10-18T13:37:26.239595+00:00'),
  Date.parse('2026-10-18T13:37:26.239595+00:00')
);
eq('parseInstant reads a numeric string as seconds', usage.parseInstant(String(epochSec)), epochSec * 1000);
eq('parseInstant rejects garbage', usage.parseInstant('not a date'), null);
eq('parseInstant rejects null', usage.parseInstant(null), null);

const iso = new Date(Date.now() + 2 * 3600_000).toISOString();
check('formatResetTime renders a readable local time', /^\w+ \d+, \d{2}:\d{2}$/.test(usage.formatResetTime(iso) || ''));
check('formatResetTime withYear appends the year', /\d{4}$/.test(usage.formatResetTime(iso, { withYear: true }) || ''));
eq('formatResetTime returns null on garbage', usage.formatResetTime('nope'), null);
eq('formatCountdown says now for the past', usage.formatCountdown(Date.now() - 1000), 'now');
check('formatCountdown renders hours and minutes', /^\d+h \d+m$/.test(usage.formatCountdown(Date.now() + 4 * 3600_000 + 12 * 60_000) || ''));
eq('daysUntil floors rather than rounds up', usage.daysUntil(Date.now() + 6 * 86_400_000 + 2 * 3600_000), 6);
eq('daysUntil returns 0 once due', usage.daysUntil(Date.now() - 1000), 0);

section('4. window labelling');

eq('windowLabel names a 5h window', usage.windowLabel(18_000), '5h');
eq('windowLabel names a 7d window', usage.windowLabel(604_800), 'weekly');
eq('windowLabel names a 30d window', usage.windowLabel(2_592_000), 'monthly');
eq('windowLabel names a 1d window', usage.windowLabel(86_400), 'daily');
eq('windowLabel falls back for a zero duration', usage.windowLabel(0), 'window');

/* ------------------------------------------------------------------ */
/* 5. payload normalisation                                            */
/* ------------------------------------------------------------------ */

section('5. usage payload normalisation');

const norm = usage.parseUsage(defaultUsagePayload());
eq('plan_type is surfaced', norm.planType, 'plus');
eq('both windows are parsed', norm.windows.length, 2);
eq('primary window keeps used_percent', norm.windows[0].usedPercent, 42.5);
eq('primary window is labelled 5h', norm.windows[0].label, '5h');
eq('secondary window is labelled weekly', norm.windows[1].label, 'weekly');
eq('remaining percent is derived', norm.windows[0].remainingPercent, 57.5);
check('hasUsageData is true when a percent is present', norm.hasUsageData);
check('noCapReported is false for a normal payload', !norm.noCapReported);
check('resetAt is parsed into epoch ms', norm.windows[0].resetAt > Date.now());
eq('reset credits are surfaced', norm.resetCredits, 1);

const freePayload = {
  plan_type: 'free',
  rate_limit: {
    allowed: false,
    limit_reached: true,
    primary_window: { used_percent: 100, limit_window_seconds: 2_592_000, reset_at: epochSec },
    secondary_window: null,
  },
};
const free = usage.parseUsage(freePayload);
eq('a null secondary_window is skipped', free.windows.length, 1);
eq('the free window is labelled monthly', free.windows[0].label, 'monthly');
eq('limit_reached is surfaced', free.limitReached, true);

const empty = usage.parseUsage({ plan_type: 'free', rate_limit: {} });
eq('no windows means noCapReported', empty.noCapReported, true);
eq('noCapReported yields no windows', empty.windows.length, 0);

const relative = usage.parseUsage({
  rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_after_seconds: 7200 } },
});
check(
  'reset_after_seconds is used when reset_at is absent',
  relative.windows[0].resetAt > Date.now() + 7000 * 1000
);

eq('bar renders a full bar at 100%', usage.bar(100, 10), '█'.repeat(10));
eq('bar renders an empty bar at 0%', usage.bar(0, 10), '░'.repeat(10));
eq('bar clamps above 100%', usage.bar(500, 10), '█'.repeat(10));
eq('money unwraps a { val } wrapper', usage.money({ val: 18 }), 18);
eq('money passes a bare number through', usage.money(18), 18);
eq('money returns null for junk', usage.money('x'), null);

/* ------------------------------------------------------------------ */
/* 6. fetchUsage over the mock                                         */
/* ------------------------------------------------------------------ */

section('6. live usage fetch (mock server)');

mock.mode = 'ok';
mock.calls = { usage: 0, token: 0 };
const okUsage = await usage.fetchUsage(ALPHA);
check('fetchUsage succeeds', okUsage.ok === true, JSON.stringify(okUsage).slice(0, 200));
eq('fetchUsage returns the plan', okUsage.planType, 'plus');
eq('fetchUsage sends the account id header', mock.seenAccountHeader[0], 'acct-alpha');
eq('fetchUsage does not call the token endpoint when fresh', mock.calls.token, 0);

mock.mode = 'refresh';
mock.calls = { usage: 0, token: 0 };
mock.seenAuth = [];
const staleAuth = {
  ...ALPHA,
  tokens: { ...ALPHA.tokens, access_token: STALE_ACCESS },
};
let refreshedTokens = null;
const refreshed = await usage.fetchUsage(staleAuth, {
  onTokenRefreshed: (t) => (refreshedTokens = t),
});
check('fetchUsage recovers from 401', refreshed.ok === true, JSON.stringify(refreshed).slice(0, 200));
eq('the token endpoint was called exactly once', mock.calls.token, 1);
eq('the usage endpoint was retried', mock.calls.usage, 2);
check('onTokenRefreshed received the new access token', refreshedTokens?.access_token === FRESH_ACCESS);
eq('onTokenRefreshed carried the rotated refresh token', refreshedTokens?.refresh_token, FRESH_REFRESH);
eq('the retry used the fresh token', mock.seenAuth[1], `Bearer ${FRESH_ACCESS}`);

mock.mode = 'hard401';
mock.calls = { usage: 0, token: 0 };
const hardFail = await usage.fetchUsage(staleAuth);
check('fetchUsage reports failure when refresh is impossible', hardFail.ok === false);
check('the failure carries an error message', typeof hardFail.error === 'string' && hardFail.error.length > 0);

mock.mode = 'ok';
const noToken = await usage.fetchUsage({ tokens: {} });
check('fetchUsage reports failure with no access token', noToken.ok === false);

/* ------------------------------------------------------------------ */
/* 7. archive read/write                                               */
/* ------------------------------------------------------------------ */

section('7. account archive');

const alphaFile = accounts.writeAccount('alpha', ALPHA);
check('writeAccount writes <name>_auth.json', alphaFile === path.join(accountsDir, 'alpha_auth.json'));
accounts.writeAccount('beta', BETA);

const listed = accounts.listAccounts();
eq('listAccounts finds both archives', listed.length, 2);
eq('listAccounts sorts by name', listed.map((a) => a.name).join(','), 'alpha,beta');
eq('listAccounts reads the email', listed[0].email, 'alpha@example.com');
eq('listAccounts reads the plan', listed[1].plan, 'pro');
eq('listAccounts marks the expired account', listed[1].status, 'expired');

const loaded = accounts.readAccount('alpha');
eq('readAccount returns the payload', accounts.emailOf(loaded.auth), 'alpha@example.com');

accounts.updateAccountTokens('alpha', { access_token: FRESH_ACCESS, refresh_token: FRESH_REFRESH });
const afterUpdate = accounts.readAccount('alpha');
eq('updateAccountTokens replaces the access token', afterUpdate.auth.tokens.access_token, FRESH_ACCESS);
eq('updateAccountTokens rotates the refresh token', afterUpdate.auth.tokens.refresh_token, FRESH_REFRESH);
eq('updateAccountTokens preserves account_id', afterUpdate.auth.tokens.account_id, 'acct-alpha');
eq('updateAccountTokens preserves sibling fields', afterUpdate.auth.auth_mode, 'chatgpt');

/* ------------------------------------------------------------------ */
/* 8. commands: logout / switch                                        */
/* ------------------------------------------------------------------ */

section('8. logout & switch');

const liveFile = paths.authJsonPath();
fs.writeFileSync(liveFile, JSON.stringify(ALPHA, null, 2));
fs.writeFileSync(`${liveFile}.lock`, '');

const logoutRes = commands.logout({});
check('logout removed auth.json', !fs.existsSync(liveFile));
check('logout removed auth.json.lock', !fs.existsSync(`${liveFile}.lock`));
eq('logout archived under the email local part', logoutRes.name, 'alpha');
check('logout reported the email', logoutRes.email === 'alpha@example.com');

// Re-create a live session, then log out again — the existing archive must be kept.
fs.writeFileSync(liveFile, JSON.stringify(BETA, null, 2));
const keptRes = commands.logout({});
eq('logout keeps an existing archive by default', keptRes.kept, true);
eq('the kept archive was not overwritten', accounts.readAccount('beta').auth.tokens.account_id, 'acct-beta');

// logout() deletes auth.json, so re-create the live session before retrying.
fs.writeFileSync(liveFile, JSON.stringify(BETA, null, 2));
const forcedRes = commands.logout({ force: true });
eq('logout -f overwrites the archive', forcedRes.kept, false);
check('logout -f wrote the archive', Boolean(forcedRes.backedUp));

fs.writeFileSync(liveFile, JSON.stringify(ALPHA, null, 2));
const namedRes = commands.logout({ name: 'custom name' });
eq('an explicit name wins over the email', namedRes.name, 'custom_name');
check('the named archive exists', fs.existsSync(path.join(accountsDir, 'custom_name_auth.json')));

const switchRes = commands.switchTo('alpha');
eq('switch writes the live auth.json', accounts.identityOf(accounts.readLiveAuth()), 'acct-alpha');
eq('switch reports the account name', switchRes.name, 'alpha');

let unknownThrew = false;
try {
  commands.switchTo('does-not-exist');
} catch (err) {
  unknownThrew = /unknown account/.test(err.message);
}
check('switch rejects an unknown account', unknownThrew);

eq('resolveAccountName derives from the email', commands.resolveAccountName(BETA), 'beta');
check('isActive is true for the switched account', accounts.isActive('alpha'));

accounts.deleteAccount('custom_name');
check('deleteAccount removes the file', !fs.existsSync(path.join(accountsDir, 'custom_name_auth.json')));

/* ------------------------------------------------------------------ */
/* 9. source integrity (the harness must not pollute src/)             */
/* ------------------------------------------------------------------ */

section('9. source integrity');

const usageSrc = fs.readFileSync(path.join(ROOT, 'src', 'usage.js'), 'utf8');
check('src/usage.js contains no localhost URL', !/127\.0\.0\.1|localhost/.test(usageSrc));
check('src/usage.js still points at the real usage host', usageSrc.includes('chatgpt.com/backend-api/wham/usage'));
check('src/usage.js still points at the real token host', usageSrc.includes('auth.openai.com/oauth/token'));
check('the usage URL is env-overridable', /process\.env\.CODEX_USAGE_URL/.test(usageSrc));
check('the token URL is env-overridable', /process\.env\.CODEX_REFRESH_TOKEN_URL_OVERRIDE/.test(usageSrc));

/* ------------------------------------------------------------------ */
/* 10. version helpers (isolated repos, never the ambient checkout)    */
/* ------------------------------------------------------------------ */

section('10. version helpers');

function gitIn(dir, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

const repoDir = path.join(sandbox, 'probe-repo');
fs.mkdirSync(repoDir, { recursive: true });
await gitIn(repoDir, ['init']);
await gitIn(repoDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
await gitIn(repoDir, [
  '-c',
  'user.email=test@example.com',
  '-c',
  'user.name=Test',
  'commit',
  '--allow-empty',
  '-m',
  'init',
]);

const branchStatus = await version.localStatus(repoDir);
eq('localStatus detects a branch', branchStatus.branch, 'main');
eq('localStatus reports not detached', branchStatus.detached, false);
check('localStatus returns a 40-char sha', /^[0-9a-f]{40}$/.test(branchStatus.sha || ''));

await gitIn(repoDir, ['checkout', '--detach', 'HEAD']);
const detachedStatus = await version.localStatus(repoDir);
eq('localStatus reports a detached HEAD', detachedStatus.detached, true);
eq('a detached HEAD has no branch name', detachedStatus.branch, null);

const notARepo = await version.localStatus(sandbox);
check('localStatus tolerates a non-repo directory', notARepo.sha === null);

eq('shortSha truncates to 7 chars', version.shortSha('abcdef1234567890'), 'abcdef1');
eq('shortSha handles null', version.shortSha(null), 'unknown');
eq('REPO points at MultiCodexState', version.REPO, 'goldshoot0720/MultiCodexState');

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

server.close();

console.log('\n' + '─'.repeat(64));
if (failures.length === 0) {
  console.log(`  \u001b[32m✔ all ${passed} checks passed\u001b[0m`);
} else {
  console.log(`  \u001b[31m✖ ${failures.length} of ${passed + failures.length} checks failed\u001b[0m`);
  for (const f of failures) console.log(`\n    ${f}`);
  process.exitCode = 1;
}
console.log('─'.repeat(64) + '\n');

if (KEEP) {
  console.log(`  sandbox kept at ${sandbox}\n`);
} else {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
