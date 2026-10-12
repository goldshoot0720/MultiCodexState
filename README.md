# multi-codex-state

Manage multiple **Codex CLI** accounts on one machine — archive logins, check live
usage/quota, and switch accounts without going through the browser again.

Built on the same mechanism the Codex CLI itself uses: a single `~/.codex/auth.json`
that Codex reads on each launch, plus the authenticated backend usage endpoint.

## Getting started

### One-line install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/goldshoot0720/MultiCodexState/main/install.sh | bash
```

Options go after `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/goldshoot0720/MultiCodexState/main/install.sh \
  | bash -s -- --install-dir "$HOME/tools/multicodexstate"
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--install-dir <path>` | `~/.multicodexstate` | Where to install |
| `--repo <owner/name>` | `goldshoot0720/MultiCodexState` | Source repository |
| `--branch <name>` | `main` | Branch or tag to install |
| `--no-link` | off | Skip `npm link`; run via `node bin/multicodexstate.js` |
| `-f`, `--force` | off | Reinstall from scratch |
| `-h`, `--help` | — | Usage |

The same settings work as environment variables (`INSTALL_DIR`, `REPO`,
`BRANCH`, `NO_LINK=1`, `FORCE=1`), which is handy when the script is fetched
from somewhere other than a pipe.

### One-line install (Windows)

PowerShell:

```powershell
irm https://raw.githubusercontent.com/goldshoot0720/MultiCodexState/main/install.ps1 | iex
```

CMD (no PowerShell required):

```cmd
curl -fsSL https://raw.githubusercontent.com/goldshoot0720/MultiCodexState/main/install.cmd -o install.cmd && install.cmd && del install.cmd
```

### What the installers do

All three check for Node 18+, npm and git, download the source to
`~/.multicodexstate` (`%USERPROFILE%\.multicodexstate` on Windows), install
dependencies, register the `MultiCodexState` command globally, and run a smoke
test. Re-running updates in place; pass `--force` / `-Force` to reinstall from
scratch.

Exactly one command name is registered. `package.json` declaring both
`MultiCodexState` and `multicodexstate` would be a trap: on a case-insensitive
filesystem (macOS APFS, Windows NTFS) those are the *same file*, so npm creates
the first symlink and then aborts with `EEXIST` on the second. The installers
therefore judge success by whether the command actually resolves rather than by
npm's exit code.

> **If `irm` fails with `WebCmdletWebResponseException` / `HttpWebRequest`**
> this is a TLS or proxy problem in your PowerShell session, not with the
> script. Force TLS 1.2 first, then retry:
>
> ```powershell
> [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
> irm https://raw.githubusercontent.com/goldshoot0720/MultiCodexState/main/install.ps1 | iex
> ```
>
> Or use the CMD variant, which uses `curl` and avoids PowerShell's HTTP stack.

### Manual install

```bash
cd D:/CODE/MultiCodexState
npm install              # only dependency is chalk
npm link                 # registers `MultiCodexState` globally
MultiCodexState          # show help
```

Run it in place without linking:

```bash
node bin/multicodexstate.js list          # from the project directory
```

```
MultiCodexState login [name]    # browser login → snapshot to accounts/<name>_auth.json
MultiCodexState logout          # archive auth.json as accounts/<email>_auth.json, then delete it
MultiCodexState logout <name>   # same, but archive under an explicit name
MultiCodexState switch <name>   # copy an archive back into auth.json
MultiCodexState usage           # plan + rate-limit windows + reset time per account
MultiCodexState list --usage    # account table + live quota + reset time
MultiCodexState update          # check GitHub and pull the latest version
MultiCodexState where           # print resolved paths
```

## Updating

`MultiCodexState update` resolves the `main` branch to a commit SHA on GitHub,
compares it against the local `HEAD`, and — if they differ — fetches that exact
commit and hard-resets onto it, then re-links the global command.

```
$ MultiCodexState update --check
  Checking for updates…
  repo goldshoot0720/MultiCodexState (main)  ·  ~/.multicodexstate

  ↑ Update available
    local  de8d410
    remote 3f9a2c1

  Run MultiCodexState update to install it.
```

Normal commands also run a **passive** check in the background and print a
one-line nudge when a newer commit exists:

```
  ↑ update available MultiCodexState update  (3f9a2c1)
```

Details worth knowing:

- The check compares **commit SHAs**, not version strings. That mirrors the
  installer's own update path and sidesteps the CDN cache that serves stale
  content for branch-name URLs.
- Resolution tries the GitHub API first and falls back to `git ls-remote`. The
  unauthenticated API allows only 60 requests/hour per IP and is routinely
  exhausted behind shared/NAT addresses, so the git protocol is the reliable
  path.
- Results are cached for 6 hours next to your Codex home
  (`$CODEX_HOME/.multicodexstate-update.json`).
- The check is **best-effort**: no git, no network, or no remote → it stays
  silent and the command you actually ran is unaffected.
- Set `CODEX_NO_UPDATE_CHECK=1` to disable the passive check entirely.

## How it works

### The auth file

Unlike Grok's `auth.json` — which is a map keyed by OAuth scope — Codex's
`~/.codex/auth.json` is a **single flat object** holding exactly one identity:

```jsonc
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<JWT>",          // profile + plan claims
    "access_token": "<JWT>",      // short-lived bearer token
    "refresh_token": "rt.1.…",
    "account_id": "72925193-0de0-4780-845a-cd6b2da88525"
  },
  "last_refresh": "2026-10-10T07:18:16.564788900Z"
}
```

Because there is only ever one identity per file, an **archive is a byte-for-byte
copy** of this object and `switch` is a plain overwrite — no merging is needed.

The `id_token` payload carries the fields the tool displays:

| Claim | Example | Used for |
| --- | --- | --- |
| `email` | `you@example.com` | the "account" column, archive naming |
| `name` | `HsingFeng Huang` | display name |
| `https://api.openai.com/auth.chatgpt_plan_type` | `free` / `plus` / `pro` | the plan column |
| `https://api.openai.com/auth.chatgpt_account_id` | `72925193-…` | account identity |

### `login`

`MultiCodexState login <name>` shells out to the real `codex login`, which performs the
normal browser OAuth flow and writes `auth.json`. Once it exits cleanly we read
that file and copy it to:

```
~/.codex/accounts/<name>_auth.json
```

No credentials are ever minted by this tool — the Codex CLI owns the flow. We
just archive the result.

### `logout`

Copies the live `auth.json` to `accounts/<email>_auth.json`, **then** deletes
`auth.json`. No email is needed from you — the local part of the account's
address becomes the filename:

| Live account | Archive written |
| --- | --- |
| `goldshoot0720@gmail.com` | `~/.codex/accounts/goldshoot0720_auth.json` |

That is what signs Codex out: with `auth.json` gone the CLI has no session.

- Pass a name (`logout myacct`) to archive under something else.
- If `accounts/<name>_auth.json` already exists it is **left as-is** rather than
  overwritten (the archive on disk may hold newer rotated tokens); pass `-f` /
  `--force` to overwrite.
- If the live session carries no email the file is deleted without an archive
  and the CLI says so.

### `switch`

Reads an archive and writes it straight to `auth.json`, atomically and with
owner-only permissions (`0600`). Codex reads this file per session, so a new
session picks up the account immediately.

### Account identity

`list` and `usage` identify each archive by its **email**, because that is the
field that actually distinguishes two accounts:

```
  #  name            account                           token
──────────────────────────────────────────────────────────────
  ▶  1 work            goldshoot0720@gmail.com  free     ● valid in 7d 17h
     2 personal        someone.else@example.com  plus     ● valid in 3h 12m
```

Column padding counts **CJK glyphs as two cells**, so a name like `鋒兄` does
not push the status column out of alignment.

If an archive has no email the column shows `(no email)` and the row falls back
to the display name or the archive name.

### Usage / quota

```
GET https://chatgpt.com/backend-api/wham/usage
```

Required headers:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <access_token>` |
| `ChatGPT-Account-Id` | the `account_id` from `auth.json` |
| `Accept` | `application/json` |

This is the authenticated backend the Codex CLI itself uses. It is **not a
documented public API**, so the shape may change without notice.

The response looks like:

```jsonc
{
  "email": "you@example.com",
  "plan_type": "plus",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window": {
      "used_percent": 42.5,
      "limit_window_seconds": 18000,      // 5 hours
      "reset_after_seconds": 3600,
      "reset_at": 1794077437              // epoch SECONDS
    },
    "secondary_window": {
      "used_percent": 12,
      "limit_window_seconds": 604800,     // 7 days
      "reset_after_seconds": 86400,
      "reset_at": 1794077437
    }
  },
  "credits": { "has_credits": false, "unlimited": false, "balance": null },
  "rate_limit_reset_credits": { "available_count": 1, "applicable_available_count": 1 }
}
```

Two details worth knowing:

- **Windows are labelled by duration, not by position.** Paid plans ship a
  5-hour `primary_window` and a 7-day `secondary_window`; the free plan ships a
  single 30-day window and a `null` secondary. `windowLabel()` reads
  `limit_window_seconds`, so the labels stay correct across plans.
- **`reset_at` is epoch seconds**, while `auth.json` stores `last_refresh` as
  an RFC 3339 string with nanosecond precision. `parseInstant()` accepts both
  (plus `reset_after_seconds` as a fallback) and returns `null` on anything
  unparseable, so a malformed value degrades to a missing line rather than
  `Invalid Date` leaking into the UI.

#### Reset time

Every window prints when it rolls over, rendered in **your local timezone**:

```
  work you@example.com
    plan plus
    5h      ████░░░░░░░░░░░░░░░░ 20.0%
            80.0% remaining
            Resets: October 18, 21:37, 2026 (in 6d 2h)
    weekly  ██░░░░░░░░░░░░░░░░░░  6.0%
            94.0% remaining
            Resets: November 1, 08:00, 2026 (in 19d 13h)
```

The parenthesised countdown turns yellow inside one day and red once the reset
is due. `daysUntil()` **floors** rather than rounds up, so a `6d 2h` countdown
reads as `6d` and never disagrees with the countdown beside it.

### Token refresh

Access tokens are short-lived. A stale one returns **HTTP 401/403**, at which
point the tool refreshes once and retries:

```
POST https://auth.openai.com/oauth/token
{ "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "rt.1.…",
  "scope": "openid profile email" }
```

The endpoint takes JSON; a `400`/`415` is retried once as
`application/x-www-form-urlencoded` for deployments that only accept form
encoding. The refreshed `access_token` / `refresh_token` / `id_token` are
merged back into the stored credential, preserving `account_id`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex CLI home; `auth.json` lives here |
| `CODEX_STATE_HOME` | `$CODEX_HOME` | Where `accounts/` is stored |
| `CODEX_BIN` | auto-detected | Path to the `codex` executable |
| `CODEX_NO_UPDATE_CHECK` | unset | Set to `1` to disable the background update check |
| `CODEX_USAGE_URL` | Codex backend | Override the usage endpoint (used by the test harness) |
| `CODEX_REFRESH_TOKEN_URL_OVERRIDE` | `auth.openai.com` | Override the token-refresh endpoint (honoured by the CLI too) |

## Layout

```
bin/multicodexstate.js  CLI entry point (the file name is internal; the command is MultiCodexState)
src/paths.js       path resolution + name sanitising
src/accounts.js    auth.json parsing, archive read/write, JWT decode
src/usage.js       usage endpoint, token refresh, response normalisation
src/commands.js    login / logout / switch implementations
src/version.js     update checking (local HEAD vs GitHub SHA, TTL cache)
src/cli.js         chalk rendering + command dispatch
test/run.js        local test harness (mock API + isolated CODEX_HOME)
install.ps1        PowerShell installer (irm ... | iex)
install.cmd        CMD installer (curl -o ... && ... && del)
install.sh         macOS / Linux installer (curl ... | bash)
```

## Uninstall

macOS / Linux:

```bash
npm unlink -g multi-codex-state          # remove the global command
rm -rf ~/.multicodexstate
```

Windows:

```powershell
npm unlink -g multi-codex-state          # remove the global command
Remove-Item -Recurse -Force "$env:USERPROFILE\.multicodexstate"
```

Your archived accounts under `~/.codex/accounts/` are left alone — delete them
manually if you want them gone.

## Local testing

The harness never touches your real `~/.codex`. It creates a throwaway
`CODEX_HOME`, seeds fake accounts, and points the code at a local mock server
that reproduces the Codex usage endpoint — including the **401 → refresh → 200**
flow.

The mock URL is injected through `CODEX_USAGE_URL` /
`CODEX_REFRESH_TOKEN_URL_OVERRIDE`, so **`src/usage.js` is never rewritten on
disk**. (An earlier generation of this tool patched the file in place and
restored it in a `finally` block; a killed run left the real CLI pointing at a
dead localhost port. Section 9 of the suite guards against that regression.)

```bash
npm test              # run all 113 checks
node test/run.js --keep   # keep the sandbox for manual poking
```

Covered: path sanitising and traversal containment, JWT/identity/plan parsing,
timestamp parsing (epoch seconds, epoch ms, RFC 3339, numeric strings,
malformed input), window labelling, payload normalisation (including the free
plan's `null` secondary window), the live fetch path, token rotation
persistence, archive read/write, logout (archives the live session under its
email, removes `auth.json` and `auth.json.lock`, keeps existing archives,
`-f` force-overwrite), switch, unknown-account errors, source-file integrity,
and version helpers exercised in isolated temporary repos.

## Security

- Archives and `auth.json` are written `0600` and atomically (temp + rename).
- Account names are sanitised, so a name can never escape the archive directory.
- Tokens are equivalent to full account access — keep `$HOME` private, never
  commit `~/.codex/accounts/`.

## Notes

- Only official OpenAI endpoints are contacted: `auth.openai.com` and
  `chatgpt.com/backend-api/wham/usage`.
- The `--usage` flag refreshes tokens for every listed account, which will
  rotate their `refresh_token`s in the archive.
- `wham/usage` is an internal endpoint, not a documented public API. If OpenAI
  changes it, `usage` degrades to a per-account error line rather than crashing.
