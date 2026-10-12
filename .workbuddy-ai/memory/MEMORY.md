# MultiCodexState — 專案長期筆記

Codex CLI 多帳號管理工具，是 `goldshoot0720/MultiGrokState` 的 Codex 版改寫。
Node.js ESM + chalk ^5，無其他依賴。

## ⚙️ 工作約定（使用者指定，必須遵守）

**每次改完檔案就自動 commit + push，不用再問。**（使用者 2026-10-12 指定）

- **只在真的有變動時提交**：先 `git status --porcelain`，乾淨就跳過，
  **絕不加 `--allow-empty`**（空 commit 只會污染歷史）。
- **訊息格式沿用 conventional commits**：`feat:` / `fix:` / `chore:` / `docs:` / `test:`，
  body 寫「為什麼」而不只是「改了什麼」——照既有 commit（b31f034 / 7225218 / 81eb5df）的寫法。
- **直接推 `origin main`**（`github.com/goldshoot0720/MultiCodexState`）。
  這是單人專案，**不要另開 branch、不要開 PR**。
- **憑證紅線**：`auth.json` / `*_auth.json` 已被 `.gitignore` 擋掉。
  commit 前掃一眼 staged 清單，**確認沒有用 `-f` 把憑證塞進來**。
- **動到 `install.ps1` / `install.cmd` 時**，commit 前先驗 CRLF（見下方紅線），
  否則會把 LF 汙染推上去，raw 端點的 curl 安裝就壞了。
- `git config` 已就緒：`goldshoot0720 <goldshoot0720@gmail.com>`、`credential.helper=helper-selector`。

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

- `npm test` = `node test/run.js`，**155 項**檢查，不碰真實 `~/.codex`。
- harness 自己起 mock HTTP server（`/usage` + `/token`），三種模式：
  `ok` / `refresh`（stale token 回 401）/ `hard401`。
- 測試**不可斷言「當下 checkout」的 git 狀態** → 第 10 節在暫存 repo 裡自己造
  branch / detached 兩種狀態（install.sh 會把安裝副本留在 detached）。
- **第 11 節測 `--json`**：用 child process 跑 `bin/multicodexstate.js`（不是 import
  `runCli`），因為只有走真正的進入點才能抓到「多餘的 banner／更新通知汙染 stdout」。
  也斷言 `list --json` **完全不碰網路**（`mock.calls.usage === 0`）。

## 桌面 GUI（Avalonia）

`gui/MultiCodexStateGui/`，從 MultiGrokState 的 `gui/` 移植。`gui/run.cmd` 啟動
（第一次會自動 `dotnet build -c Release`，需要 .NET SDK 8.0+；本機是 10.0.302，可跑）。

- **GUI 不自己讀 `auth.json`、也不自己打 usage 端點**，一律 shell out 給 CLI 的
  `list --json` / `usage --json` → auth 與 quota 邏輯只有一份。
- CLI 原本**沒有 `--json`**（MultiGrokState 的 GUI 靠這個）→ 這次補上，見下方契約。
- `CliService` 解析順序：`MULTICODEXSTATE_CLI` 覆寫 → repo 內的 `bin/multicodexstate.js`
  （向上找 6 層）→ 全域指令。找檔名時**同時試舊名 `cs.js`**，讓舊 checkout 也能跑。
- 跑 CLI 時會設 `CODEX_NO_UPDATE_CHECK=1`，避免更新檢查拖慢或汙染輸出。
- **`bin/`、`obj/` 已加進 `.gitignore`**（`gui/**/bin/`、`gui/**/obj/`）。

### `--json` 契約（GUI 消費，也可拿來寫腳本）

- `list --json` → `[{name,email,displayName,plan,status,expiresAt,isActive,error}]`，
  `expiresAt` 是 **epoch ms**。**不做網路請求**。
- `usage --json` → `[{name,email,planType,ok,error,limitReached,noCapReported,windows[],credits,resetCredits,modelUsage}]`
- `where --json` → `{authJson,accountsDir,codexBinary}`
- `windows[]` = `{key,label,windowSeconds,usedPercent,remainingPercent,resetAt}`。
- **有 `--json` 時 stdout 只有那份文件**：沒有顏色、沒有 banner，而且
  **背景更新通知被強制關掉**（否則會把 JSON 弄壞）。單一帳號失敗 → 該列
  `ok:false` + `error`，**不是少一列**。

### 免費方案 vs plus/pro（使用者明確要求必須相容）

- **`windows` 是可變長度陣列，不是固定的 weekly/monthly 兩個欄位。**
  plus/pro = 5h + weekly 兩列；free = 只有一列 30 天（`secondary_window: null`）。
- GUI 用 `ItemsControl` 綁 `Windows` 集合，**列數由 payload 決定**，卡片不假設有幾列。
- 「完全沒有 window」≠ 真的 0%：`noCapReported: true` 時畫 0% 但顯示說明文字。
- 測試第 11 節有專門斷言：free 方案只有 1 個 window 且 label = `monthly`；
  windowless payload → `noCapReported: true` 且 `windows.length === 0`。
- `WindowViewModel.ResetText` 用 **`DateTimeOffset.FromUnixTimeMilliseconds`** 組
  （Codex 給 epoch ms），**不是** MultiGrokState 那種 `DateTimeOffset.TryParse(ISO 字串)`。
- `AccountViewModel.ExpiryText` 的措辭刻意與 `accounts.js` 的 `humanExpiry()` 一致。


## ⚠️ 從 MultiGrokState 改名時的最大陷阱

**`bin/gs.js` 這個「內部檔名」不在專案名替換清單裡**，第一次改名時漏掉，
導致三個 installer 全部指向不存在的舊檔名。已定案為 **`bin/multicodexstate.js`**。

- 整體改名後要 grep 舊專案的**所有識別字**：專案全名、小寫變體、縮寫、
  **檔名**（`gs.js`）、環境變數前綴（`MG_`）、binary 名（`grok`）。
- **`npm link` 讀 `package.json` 的 `bin`，所以檔名錯了它照樣成功** →
  e2e 安裝「看起來」正常，只有 smoke test 會警告（且只印警告不中斷）。
  **驗證時要涵蓋 `--no-link` 等非 happy path。**
- 改 `install.ps1` / `install.cmd` 一律用 **Node 逐字替換**，不要用 Git Bash 的 sed
  （sed 會把 CRLF 吃成 LF）；改完必驗 `CRLF=… bareLF=0`。


## 待辦 / 未做

- `codex login` 的互動流程未在 CI 驗證（需要瀏覽器）。
- `wham/usage` 是**內部端點**，非官方公開 API，形狀可能變；已設計成壞掉時
  只印單帳號錯誤行，不會整個崩。
