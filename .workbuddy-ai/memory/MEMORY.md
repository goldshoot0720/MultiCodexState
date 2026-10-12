# MultiCodexState — 專案長期筆記

Codex CLI 多帳號管理工具，是 `goldshoot0720/MultiGrokState` 的 Codex 版改寫。
Node.js ESM + chalk ^5，無其他依賴。

## 與 MultiGrokState 的關鍵差異（改寫時最容易踩的地方）

| 面向 | Grok | Codex |
| --- | --- | --- |
| `auth.json` 結構 | **scope-keyed map**，一個檔可含多 identity | **單一扁平物件**，一個檔只有一個 identity |
| 憑證欄位 | 頂層 `key` / `refresh_token` / `email` / `oidc_client_id` | `tokens.{id_token,access_token,refresh_token,account_id}` |
| 身分識別 | `user_id` / `email` | `tokens.account_id`（首選）／ id_token 的 `email` |
| `switch` | **merge**（保留其他 identity） | **整檔覆寫** |
| usage 端點 | `cli-chat-proxy.grok.com/v1/billing`（週/月兩支） | `chatgpt.com/backend-api/wham/usage`（一支） |
| usage 認證 | `Authorization` + `x-grok-client-mode: cli` | `Authorization` + **`ChatGPT-Account-Id`** |
| 視窗 | weekly / monthly 兩個固定形狀 | `rate_limit.primary_window` / `secondary_window`，**依 `limit_window_seconds` 命名** |
| 重置時間 | ISO 字串 | **epoch 秒**（`reset_at`），另有 `reset_after_seconds` |
| refresh | `POST auth.x.ai/oauth2/token`（form-encoded） | `POST auth.openai.com/oauth/token`（JSON，fallback form） |

- Codex OAuth **client_id = `app_EMoamEEZ73f0CkXaXp7hrann`**，scope `openid profile email`。
- 付費方案：`primary_window` = 5h、`secondary_window` = 7d；**免費方案只有一個 30 天視窗**，
  `secondary_window` 為 `null` → 不可假設 secondary 一定是 weekly。
- Codex CLI 的 binary 在 Windows 是 `codex.exe`（`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\`，
  實際是 symlink 到 `~/.codex/packages/standalone/current/bin/`）。
- 從 binary 抓 endpoint 的方法（沒有 `strings` 時）：
  `grep -a -o -E "https://[a-z.]*openai[a-zA-Z0-9./_-]*" <binary>`。
  這樣查到 `auth.openai.com/oauth/token`、`oauth/revoke`、`CODEX_REFRESH_TOKEN_URL_OVERRIDE`。

## 紅線 / 已驗證結論

- **`CODEX_REFRESH_TOKEN_URL_OVERRIDE` 是 CLI 自己就認的環境變數** →
  測試 harness 用它 + `CODEX_USAGE_URL` 注入 mock，**永不改寫 source 檔**
  （MultiGrokState 早期改寫 source 再還原，被中斷就留下 localhost 汙染）。
  `test/run.js` 第 9 節專門守這件事。
- **`reset_at` 是 epoch 秒**。`parseInstant()` 用 `< 1e11` 判斷秒 vs 毫秒
  （2026 年 epoch 秒 ≈ 1.8e9、毫秒 ≈ 1.8e12）。
- **`--usage` 會 rotate refresh_token**：401 → refresh → 200 會拿到新的
  `access_token` + `refresh_token`。**測試時若對真實帳號的副本跑 usage，
  OpenAI 端會把舊 refresh_token 作廢** → 真實存檔要記得回寫，
  否則使用者的存檔會壞掉。**教訓：不要拿真實憑證的副本去測 refresh 路徑。**
- Windows 上 `sed`（Git Bash）輸出會把 CRLF 吃成 LF → `install.cmd` / `install.ps1`
  必須用 Node 事後強制轉回 CRLF，並確認 `git ls-files --eol` 是 `i/crlf w/crlf`。
  `.gitattributes` 要用 **`*.cmd -text`**（不是 `text eol=crlf`），否則 raw 端點吐 LF。

## 測試

- `npm test` = `node test/run.js`，**113 項**檢查，不碰真實 `~/.codex`。
- harness 自己起 mock HTTP server（`/usage` + `/token`），三種模式：
  `ok` / `refresh`（stale token 回 401）/ `hard401`。
- 測試**不可斷言「當下 checkout」的 git 狀態** → 第 10 節在暫存 repo 裡自己造
  branch / detached 兩種狀態（install.sh 會把安裝副本留在 detached）。

## 待辦 / 未做

- `codex login` 的互動流程未在 CI 驗證（需要瀏覽器）。
- `wham/usage` 是**內部端點**，非官方公開 API，形狀可能變；已設計成壞掉時
  只印單帳號錯誤行，不會整個崩。
