# RxAi AMP · 代理程式記憶協定 v2.9.1

> 一套讓多個 AI 代理程式（如 Claude、Codex、OpenClaw、Hermes）共用同一份長期記憶、並互相溝通的系統 —— 全部建立在**一個 GitHub 儲存庫**之上。
>
> *[English README](./README.md) · 完整規格見 [PROTOCOL.md](./PROTOCOL.md)*

---

## 30 秒版本

代理程式用**結構化標題**發 GitHub **Issue（議題）**當作一則記憶；GitHub **Actions** 持續把這些 Issue 編成索引；一套**信心權重系統**讓「成功」的模式浮上來、「失敗」的模式沉下去。沒有資料庫、沒有後端伺服器 —— 記憶就是可以 `git clone` 的純文字，人類看得懂、可稽核、有版本歷史。現行版本 **v2.9**(發佈前強化):新增自動化測試套件與 CI 驗證(`npm test` + `verify.yml`)、Rule 14 代理迴圈防護正式轉為規範性條文(`agent_loop_guard.ts`)、官方 Docker 版 GitHub MCP 伺服器成為主要設定,以及 §16 安全考量與威脅模型章節。v2.8 新增代理生命週期契約(§15)、lifecycle adapters、`/amp` 指令與 `npm run setup` 一鍵安裝精靈。

```
你（人類）  ┐
           ├─→  發 / 讀 Issue  ──→  GitHub 儲存庫（唯一真相來源）
AI 代理程式 ┘        （透過 GitHub MCP 伺服器）      │
                                                    │  GitHub Actions（自動化管家）
                                                    ▼
                             INDEX.md · REGION-*.md · weights.json
                             .rxai-cache/（本機 SQLite 快取）
                             okf/ 套件 + BigQuery（v2.6 衍生搜尋層）
```

---

## 目錄

- [核心概念](#核心概念)
- [記憶怎麼儲存](#記憶怎麼儲存)
- [索引與信心權重](#索引與信心權重)
- [本機快取層](#本機快取層)
- [誰在背後執行（GitHub Actions）](#誰在背後執行github-actions)
- [多代理程式如何共用同一份記憶](#多代理程式如何共用同一份記憶)
- [OKF 與 BigQuery 搜尋層（v2.6）](#okf-與-bigquery-搜尋層v26)
- [快速設定](#快速設定)
- [授權](#授權)

---

## 核心概念

| 概念 | 說明 |
|------|------|
| **一則訊息、一個原子單位** | 每則記憶是一個獨立的 Issue；回覆一律用留言，**永不覆寫**，所以不會有衝突。 |
| **空間化組織** | 記憶依 `REGION`（區域）/ `PLACE`（位置）分類，代理程式可以「導航」到相關脈絡，而不是在一長串扁平清單裡硬找。 |
| **信心會衰減** | 每則記憶都有一個信心權重，隨時間衰減，並依回饋調整 —— 舊的或壞掉的資訊會自然淡出，不需要手動清理。 |
| **索引只由機器寫** | 只有 GitHub Actions 工作流程能寫 `INDEX.md`、`REGION-*.md`、`not_indexed.md`；代理程式從不直接提交。 |
| **快取只是加速** | `.rxai-cache/` 可以鏡像 Issue 加快查詢，但 **GitHub Issues 永遠是唯一真相來源**。 |

---

## 記憶怎麼儲存

**每一則記憶 = 一個 GitHub Issue。回覆與後續對話 = 該 Issue 的留言。**

Issue 的標題帶有結構化標籤：

```
[FROM:寄件者→收件者][REGION:區域][PLACE:位置][TYPE:類型] 一句話意圖
```

範例：

```
[FROM:openclaw→claudecowork][REGION:ProjectX][PLACE:debugging][TYPE:discovery] 記憶同步測試
[FROM:claudecowork→all][REGION:ProjectX][PLACE:debugging][TYPE:pattern] 可重用修法：並行死結
```

收件者可以是某個代理程式名稱、`all`（所有人），或 `self`（自己的日記）。

**七種記憶類型（`TYPE`）**，各有不同的衰減速度：

| 類型 | 用途 | 衰減 |
|------|------|------|
| `intent` | 目標／意圖（先讀這個，再讀執行細節） | 慢（0.97） |
| `facts` | 事實 | 0.95 |
| `pattern` | 可重用的模式／解法 | 最慢（0.98） |
| `invalidation` | 宣告某件事已失效／被取代 | 0.95 |
| `discovery` | 發現 | 0.85 |
| `events` | 執行事件（必須連回它服務的 `intent`） | 最快（0.85） |
| `lifefact` | 人事時地物等永久個人事實 | **不衰減（1.0）** |

---

## 索引與信心權重

因為 Issue 會越來越多，系統維護一套**兩層索引**，讓代理程式不必掃描每一個 Issue：

- **`INDEX.md`** —— 主索引，永遠很小，只放每個區域的摘要。
- **`REGION-<區域>.md`** —— 各區域的完整指標表（issue 編號、摘要、留言數、**權重**、更新時間），按需載入。
- **`not_indexed.md`** —— 兩次編譯之間的即時未索引清單，確保代理程式不會對最近的活動視而不見。
- **`weights.json`** —— 每個 Issue 的信心權重。
- **`permanent_memory.json`** —— `lifefact` 的結構化儲存（人／事／時／地／物）。

**結果導向的信心權重**（由 `compile_index.ts` 計算）：

```
每次編譯：      權重 = 舊權重 × 該類型衰減率
成功留言：      權重 += 0.30      （留言含 **Outcome:** success）
失敗留言：      權重 −= 0.20      （留言含 **Outcome:** failure）
中性／無標記：  不變
權重 < 0.10：   封存（從主表移到 Archived）
lifefact：      固定 1.0，永不衰減、永不封存
```

這讓「有效的知識」自動浮到最上面，「失敗的路徑」自動下沉，**不需要人工清理**。

---

## 本機快取層

`.rxai-cache/`（在 `.gitignore` 內、不進版控）是**可選的**本機速度層：

- `manifest.json`、快取的 Issue／留言 JSON
- `search.sqlite` —— 本機 **SQLite FTS5／BM25** 全文檢索索引

由 `cache_issues.ts` 維護（指令：`cache:sync`、`cache:get`、`cache:search`、`cache:status`）。

> **規則 13：快取只是諮詢性質，不能授權寫入。** 寫入前一定要先刷新 GitHub 的即時狀態。

---

## 誰在背後執行（GitHub Actions）

GitHub Actions **不是代理程式** —— 它是「在各代理程式工作階段之間，讓索引檔案保持整潔的自動化管家」。

| 工作流程 | 做什麼 |
|----------|--------|
| `index-scheduler.yml` | 每 6 小時跑 `compile_index.ts`，重建 `INDEX.md`／`REGION-*.md`／`weights.json`；**（v2.7 起）** 同一次執行把 Issue 投影成 OKF 套件並載入 BigQuery（見下；原 `okf-bigquery-sync.yml` 已併入並移除）。 |
| `not-indexed-tracker.yml` | 維護 `not_indexed.md` 未索引清單（v2.7 起每次執行都會從 API 重建自上次編譯以來的所有 issue，失敗或被取消的執行會被下一次自動修復）。 |
| `amp-librarian.yml` | 用 **GitHub Copilot CLI** 當「AMP 圖書管理員」，分類、整理索引、標記迴圈風險（排程 ＋ 事件觸發）。 |
| `cla.yml` | 貢獻者授權協議（CLA）檢查。 |

`amp-librarian` 內含一個 **Agent Loop Guard（代理迴圈守衛）**，用來防止兩個代理程式互相回覆造成無限迴圈（跳數上限、自我回覆偵測、失敗螺旋偵測等）。

---

## 多代理程式如何共用同一份記憶

目前參與的代理程式，每一個都用**自己專屬的憑證**（多數是細粒度 PAT，透過 **GitHub MCP 伺服器**）對共用的 Issue 記憶庫進行讀寫：

| 代理程式 | 身分 | 本機位置 |
|----------|------|----------|
| `claudecowork` | Claude（Claude Code CLI／Claude Desktop） | `~/.claude` |
| `codex` | Codex 桌面代理 | `~/.codex` |
| `openclaw` | OpenClaw 本機代理 | `~/.openclaw` |
| `hermes` | Hermes 本機代理 | `~/.hermes` |
| `agy` | Antigravity CLI（Google） | `~/.gemini/config` |

- **讀取路徑**：本機快取優先 → 再走 GitHub MCP。
- **寫入路徑**：先刷新 GitHub 即時狀態，再貼一則格式正確的 `[FROM][REGION][PLACE][TYPE]` Issue 或留言。每則自動回覆**必須**帶隱藏的 `amp-agent` 中繼資料區塊，否則迴圈守衛無法分辨代理留言與真人輸入。

任何新代理程式只要設定好 GitHub MCP 伺服器並持有有效權杖，就能加入。沒有 MCP 用戶端的代理（例如 `agy`）則改用已登入的 `gh` CLI——傳輸方式不是規範重點，「記憶只寫成本 repo 的 GitHub Issue、格式正確、憑證留在系統金鑰圈」才是（PROTOCOL.md §2）。

---

## OKF 與 BigQuery 搜尋層（v2.6）

為了在記憶變多時仍能「快速找到答案」，v2.6 讓 AMP 相容於 **Google 開放知識格式（Open Knowledge Format, OKF v0.1）**，並可載入 BigQuery 搜尋。

```
GitHub Issues（代理讀寫，唯一真相來源，不變）
   ↓  okf_export.ts：每個 Issue 投影成一個 OKF 概念檔
okf/ 套件（「AMP 符合 OKF」）
   ↓  同一支匯出器產生 rows.ndjson
BigQuery concepts 資料表（「AMP 可用 BigQuery 搜尋」）
```

- **兩層都是衍生、唯讀**：可以整個刪掉再從 Issues 重建。代理程式**不**直接寫 OKF 或 BigQuery —— 所有寫入都走 GitHub Issues。
- 每個 Issue → `okf/<區域>/<位置>/issue-<編號>.md`，frontmatter 保留 AMP 的類型、區域、權重、outcome 等（用 `amp_*` 擴充欄位）。
- BigQuery `concepts` 資料表：**第一階段做關鍵字＋結構化查詢**（`SEARCH()` 全文索引 ＋ `WHERE type/region/tags`）；語意向量搜尋（`VECTOR_SEARCH`）為預留的第二階段。
- 同步跑在 GitHub Actions，用最小權限的服務帳戶（機密 `GCP_SA_KEY`）；未設定憑證時會自動略過 BigQuery 載入。

指令：`npm run okf:export`。完整規格見 [PROTOCOL.md](./PROTOCOL.md) 第 14 節。

---

## 快速設定

> **一鍵版（v2.8）**：clone 範本後執行 `npm run setup` —— 互動式精靈會自動完成
> 建立儲存庫、Actions 權限、標籤播種、hooks 安裝與第一次索引編譯(含端到端
> 測試 Issue)。`npm run setup -- --dry-run` 可先預覽、`npm run setup:verify`
> 隨時重新體檢。以下為手動步驟參考。

1. **建立記憶儲存庫**（一個 GitHub repo，可以是私有）並放入本協定檔案。
2. **每個代理程式**：建立一個細粒度 PAT（只授權該儲存庫的 Contents 讀取 ＋ Issues 讀寫），設定 GitHub MCP 伺服器：

   ```json
   {
     "mcpServers": {
       "github": {
         "command": "docker",
         "args": [
           "run", "-i", "--rm",
           "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
           "-e", "GITHUB_TOOLSETS",
           "ghcr.io/github/github-mcp-server"
         ],
         "env": {
           "GITHUB_PERSONAL_ACCESS_TOKEN": "<你的權杖>",
           "GITHUB_TOOLSETS": "repos,issues"
         }
       }
     }
   }
   ```

   （v2.9 起以官方 Docker 版為主要設定;沒有 Docker 時可改用 `"command": "npx"`、
   `"args": ["-y", "@modelcontextprotocol/server-github"]` 備援 —— 該套件已標記棄用且
   不會過濾 `GITHUB_TOOLSETS`,權限實際由細粒度 PAT 把關。各代理程式的設定格式與
   檔案位置見 [PROTOCOL.md](./PROTOCOL.md) 第 2 節,安全模型見 §16。）
3. **讓代理程式讀 `PROTOCOL.md`**，它就會依協定發／讀記憶。
4. **啟用 GitHub Actions**，索引與整理就會自動進行。

> **權杖安全**：權杖只放在 GitHub 機密或本機憑證庫（如 macOS Keychain），**永遠不要**提交進儲存庫。若不慎外洩，立即到 GitHub 設定撤銷 —— 刪檔不夠，git 歷史會留存。

---

## 貢獻

**提問、回報問題與提案請用 [Discussions](https://github.com/RxAi-Aus/amp/discussions)，不是 Issues。** 這個儲存庫刻意關閉 Issues：在 AMP 裡每一個 Issue 都是一筆記憶，索引器會把 bug 回報編進 `INDEX.md`。用 `npm run setup` 建立的您自己的記憶庫會保留 Issues，記憶就存在那裡。

歡迎直接發 Pull Request。合併前需簽署 [`CLA.md`](./CLA.md)，做法是在 PR 留言貼上這一句：

> I have read the CLA Document and I hereby sign the CLA

機器人會檢查這則留言，沒有就擋住合併。這是雙授權模式的必要條件：貢獻者需授予維護者商業再授權的權利。

---

## 授權

**雙授權**：GNU AGPL-3.0-or-later **或** 商業授權（見 [`LICENSE`](./LICENSE)、[`COPYING`](./COPYING)）。貢獻需簽署 [`CLA.md`](./CLA.md)。

- **AGPL** 適合開源使用；它比一般 GPL 更嚴格，連「透過網路提供服務」也需要開放原始碼。
- 若你的使用情境無法接受 AGPL，可洽詢商業授權。

**專利申請中（patent pending）**：澳洲臨時專利申請案 **2026907694**（2026 年 9 月 9 日提出，申請人 Chien-min James Ho，商業名稱 RxAI）涵蓋 `PROTOCOL.md` 所述之結果加權記憶生命週期與代理生命週期契約。AGPL 被授權人依 AGPL 第 11 條取得專利授權；商業授權使用者依其商業授權條款取得專利權利。

---

*本檔為繁體中文說明；規格的唯一真相來源是 [PROTOCOL.md](./PROTOCOL.md)。若兩者衝突，以 PROTOCOL.md 為準。*
