# MultiCodexState

Codex CLI account archives. The CLI in `src/` is the only place that reads `auth.json`, refreshes tokens, or calls the usage endpoint. The Avalonia GUI shells out to `list --json` and `usage --json`.

Run `node test/run.js` after a CLI or contract change. It passes when every check is green.

## Ship

When the user says `自動提交至 https://github.com/goldshoot0720/MultiCodexState`, commit the current work and push to `origin` `main`. Do not ask for a second confirmation. Done means `git status -sb` shows `main` level with `origin/main`.

Leave out `auth.json`, `*_auth.json`, `node_modules/`, `gui/**/bin/`, `gui/**/obj/`, and `gui/MultiCodexState.app/`.

## Accounts

`account_id` is the ChatGPT workspace. Team logins share it, so it cannot by itself mark the live archive. `sameAccount` compares email when both payloads have one, and falls back to `identityOf` only when an email is missing. The active marker and `isActive` use `sameAccount`.

## Usage document

`usage --json` is the GUI contract. `model_usage` from the endpoint is often a nested object per model. Forward only numeric values. A non-numeric `modelUsage` makes the GUI reject the whole document, so the 5h and weekly bars never appear.

`resetCredits` is the reset count (`rate_limit_reset_credits.available_count`). In the GUI, setting it must also notify `HasCredits`. Otherwise the row stays hidden when that count is the only credit text.

A live `usage` call refreshes tokens. Run it only when the task needs current quota. Do not print access tokens, refresh tokens, or API keys.

## macOS window

`App.axaml` `Name` is the menu-bar title. `gui/run.sh` publishes a self-contained `.app` so the Dock shows that name and `Assets/app-icon.png`. Launching the DLL with `dotnet` shows "Avalonia Application".

The project targets `net8.0` and rolls forward to a newer runtime. A Finder launch does not inherit a shell `PATH`; `CliService` resolves `node` itself, including `/opt/homebrew/bin/node`.
