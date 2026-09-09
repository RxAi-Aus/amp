# Feature Specification: AMP Token Monitor

**Feature Branch**: `001-token-monitor`

**Created**: 2026-08-08

**Status**: Draft

**Input**: User description: "reference SPEC-INPUT.md"

## Domain Analysis & Token Cost Model

The AMP Token Monitor operates across five distinct cost centers within the Agent Memory Protocol (AMP):

- **C1 — RECALL injection (per session start):** Ingesting compiled memory index files. L2 agents (Claude Code hooks) inject `INDEX.md` + `not_indexed.md` verbatim; folderless agents (hermes) read `AGENTS.md` (8.6 KB) as a digest. Budget ceiling stays under ~15 KB / 4,000 tokens.
- **C2 — Turn amplification:** Injected context is re-sent on every conversation turn. Cumulative turn cost is modeled as: `tok(inject) × (1 + (turns - 1) × cacheReadRatio)`. Prompt cache invalidation re-charges full price on mid-session file modifications.
- **C3 — Navigation reads (per task):** On-demand reads of `REGION-{name}.md` files, issue bodies, comments, and `cache:search` outputs.
- **C4 — Write cost:** Output token cost for creating or modifying issues and comment bodies (charged at output rates, approximately 5x input price).
- **C5 — Protocol overhead:** Worst-case cost of reading `PROTOCOL.md` (71 KB ≈ ~18k tokens) in its entirety.

## User Scenarios & Testing

### User Story 1 - Artifact Token Scan & Recall Budget Check CLI (Priority: P1)

As an agent session or CI pipeline gatekeeper, I want to scan all memory artifacts, count their tokens per model, and check the recall injection size against a configurable budget so that we can prevent runaway context costs.

**Why this priority**: This forms the core engine. Without it, token usage cannot be measured, and budget enforcement cannot happen. Developing this story alone creates a viable MVP that can run locally or block builds in a CI pipeline.

**Independent Test**: Can be fully verified by running the CLI `scan` command against a test directory containing mock markdown memory files. It will output a table of token/byte/character sizes and exit with code 0 if OK, or exit with code 2 if the budget is exceeded.

**Acceptance Scenarios**:

1. **Given** a configured memory repo containing standard artifacts under the 4,000 token budget, **When** running `npm run scan` (or CLI `scan`), **Then** it must output a table showing bytes, characters, token counts, and cost estimates per model, report a budget verdict of "OK", and exit with code 0.
2. **Given** a configured memory repo where the recall injection artifacts (`INDEX.md` + `not_indexed.md`) exceed the configured budget, **When** running `npm run scan` (or CLI `scan`), **Then** it must print the detail table, report a budget verdict of "OVER", and exit with code 2.
3. **Given** no existing configuration file, **When** running `scan` for the first time, **Then** it must automatically create `tokmon.config.json` with standard defaults (4,000 token budget, default directory locations, Claude/Gemini/GPT models and pricing) and successfully perform the scan.

---

### User Story 2 - Claude Code Transcript Parsing & Live Session Attribution (Priority: P2)

As a developer (e.g. James), I want to analyze my local Claude Code transcripts (`.jsonl`) to track actual session expenses, identify memory-specific usage, and evaluate prompt cache hit ratios.

**Why this priority**: Enables understanding the real-world operational costs of agent sessions. It allows developers to check cache hit efficiency (reducing C2 amplification) and identifies whether memory activities are driving costs.

**Independent Test**: Can be tested by running the `sessions` command against a directory populated with mock or real `.jsonl` session files, verifying that the aggregated input, output, cache-read, and cache-creation counts are displayed accurately without external API calls.

**Acceptance Scenarios**:

1. **Given** a directory containing Claude Code project transcripts, **When** running the CLI `sessions` command, **Then** it must parse the `.jsonl` files and output aggregated input, output, cache-read, and cache-creation tokens, displaying the cache efficiency ratio and estimated $ spend grouped by day and model.
2. **Given** a mix of general coding session logs and sessions containing AMP memory-marker tags or skill calls, **When** running `sessions`, **Then** it must report "AMP-marked activity" and "Full Memory-Repo Session totals" separately and never conflate them.

---

### User Story 3 - Interactive localhost Dashboard with Watch Mode (Priority: P3)

As a memory system owner, I want an offline-first visual cockpit showing dashboard panels of current costs, budget thresholds, historical snapshots, and session cache efficiency trends.

**Why this priority**: A visual interface is critical for long-term health monitoring. It makes the metric projections and trends digestible for humans, and watch mode automates rescanning.

**Independent Test**: Run `serve --watch` and open `http://localhost:4173`. Verifying that modifying a local markdown file triggers a rescan, updates the snapshot file, and causes the browser page to refresh with updated data.

**Acceptance Scenarios**:

1. **Given** an existing snapshot dataset, **When** starting the dashboard using the `serve` command on port 4173, **Then** a browser can access the page completely offline and render five panels: Artifact Costs, Budget Gauge, Growth Over Time, Session Spend, and Cache Efficiency.
2. **Given** the server is running with the `--watch` flag, **When** the `INDEX.md` memory file is modified, **Then** the background worker must detect the change, run a rescan, write to `data/snapshots.ndjson`, and the browser dashboard must automatically refresh to show the new data.

---

### User Story 4 - Git-History Backfill Time Series (Priority: P4)

As a memory system developer, I want to scan the Git history of my memory repository to retroactively construct a time series of token usage over time.

**Why this priority**: Necessary to show long-term growth trends in the dashboard, backfilling data points from past commits.

**Independent Test**: Run `backfill --since <date>` to reconstruct past snapshots in `data/snapshots.ndjson` from Git commit history.

**Acceptance Scenarios**:

1. **Given** a memory repository with multiple Git commits, **When** running `backfill --since 2026-08-01`, **Then** it must checkout the historical files at those commits, compute token counts, and append historical snapshots to `data/snapshots.ndjson`.

### Edge Cases

- **Missing/Corrupted Configuration File**: If `tokmon.config.json` is missing or corrupted, the system should log a warning and fallback to hardcoded defaults (or regenerate the config file if missing) rather than crashing.
- **Port Conflict in Dashboard Server**: If port 4173 is already in use, the `serve` command should fail gracefully with a descriptive error message and exit rather than hanging.
- **Missing Local Cache (`.rxai-cache/`)**: When offline and `.rxai-cache/` is missing, the system must exclude GitHub issues from the scan and issue a warning instead of failing or making network requests (network egress is disabled by default).
- **Corrupted Transcript Files**: If a `.jsonl` file in the Claude project folder contains invalid JSON lines or incomplete session data, the transcript parser must skip that line or file with a warning, rather than halting execution.
- **Git Shallow Clones**: When running `backfill` on a shallow repository clone, the Git walker should stop gracefully at the oldest commit and warn the user that the backfill is incomplete due to shallow history.
- **Concurrent Writes to Snapshot File**: If watch mode triggers a rescan while another process (e.g. CLI scan) is writing to `data/snapshots.ndjson`, file write locks or append safety must prevent file corruption.

## Requirements

### Functional Requirements

- **FR-1 (`scan` Command)**:
  - System MUST tokenize all artifacts of the configured memory repository: `INDEX.md`, `not_indexed.md`, all `REGION-*.md`, `AGENTS.md`, `PROTOCOL.md`, skill files, and—when `.rxai-cache/` exists—every cached issue body and comments.
  - System MUST compute token counts for each model defined in the configuration.
  - System MUST compare the C1 recall injection cost (`INDEX.md` + `not_indexed.md`) against the configured budget and output the verdict: OK (under 80%), WARN (>=80% and <100%), or OVER (>=100%).
  - System MUST append a single snapshot JSON line containing the token counts and timestamp to `data/snapshots.ndjson`.
- **FR-2 (`report` Command)**:
  - System MUST generate a human-readable CLI summary table of the latest scan.
  - System MUST compute and display the trend vs previous snapshots (e.g., Δ tokens/week).
- **FR-3 (`sessions` Command)**:
  - System MUST parse all transcript `.jsonl` files in `claudeProjectsDir`.
  - System MUST extract input, output, cache-read, and cache-creation tokens per request along with the model ID.
  - System MUST calculate the cache efficiency ratio: `cache_read_input_tokens / (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)`.
  - System MUST aggregate and report separately:
    - (a) Full Memory-Repo Sessions: sessions in directories that are clones of the memory repo.
    - (b) AMP-Marked Activity: requests matching AMP markers (`[FROM:`, `[REGION:`, `rxai-amp` skill invocation, "RxAi AMP shared memory" blocks, issue writes).
  - System MUST group these aggregates by day and model, applying financial cost estimates based on the config.
- **FR-4 (`backfill` Command)**:
  - System MUST support a `--since <date>` parameter.
  - System MUST walk the Git history of the memory repo, check out the state of `INDEX.md`, `not_indexed.md`, and `REGION-*.md` at past commits, tokenize them, and write historical snapshots into `data/snapshots.ndjson` with the original commit timestamps.
- **FR-5 (`serve` Command)**:
  - System MUST host a localhost dashboard on the configured port (default 4173) using a Node.js native `http` server.
  - System MUST support a `--watch` flag that watches memory repository files for modifications and rescans on a 5-minute interval or upon change.
  - System MUST serve exactly one HTML file containing inline CSS and JS, ensuring zero external CDN or network dependencies (fully offline capable).
  - System MUST support light and dark theme awareness.
- **FR-6 (CLI Utilities)**:
  - System MUST output output in raw JSON format when `--json` flag is provided on any command.
  - System MUST exit with code 2 when the C1 budget status is OVER.
- **FR-7 (Configuration)**:
  - System MUST automatically create `tokmon.config.json` with defaults if not present.
  - Configuration MUST allow editing:
    - `memoryRepoPath` (default `~/Documents/AgentMemory`)
    - `claudeProjectsDir` (default `~/.claude/projects`)
    - `budgets` (`recallInjectionTokens`: default 4,000)
    - `models` (array of configurations including `id`, `label`, `tokenizer`, `calibrationRatio`, `pricePerMTokInput`, `pricePerMTokOutput`, `cacheReadRatio`, `cacheWriteRatio`)
    - `port` (default 4173)

### Constraints

- **CS-1 (Subproject Isolation)**: The app must live at `tokenMonitor/` in the AMP dev repo as a self-contained subproject with its own `package.json`, `tsconfig.json`, and `node_modules`.
- **CS-2 (Zero-Dependency Runtime)**: Runtime dependencies must be strictly limited to `gpt-tokenizer`. Dev dependencies must be limited to `typescript`.
- **CS-3 (Environment)**: Must run on Node 22 ESM TypeScript, using a 2-space indent and camelCase style.
- **CS-4 (Dashboard Architecture)**: The dashboard must consist of exactly ONE self-contained HTML file (inline CSS/JS, hand-rolled SVG/canvas charts, no external CDNs, no libraries/frameworks), served by `node:http`.
- **CS-5 (Data Privacy)**: The tool must be read-only towards the memory system. The `data/` folder must be gitignored to ensure transcripts containing personal data are never committed.
- **CS-6 (Standard Timestamps)**: All timestamps must use UTC ISO 8601 `Z`.
- **CS-7 (Token Calibration)**: Calibrate token counts for models without public vocabularies (Claude, Gemini) using `gpt-tokenizer` `o200k_base` multiplied by a configurable `calibrationRatio` (default 1.0). Print "≈ calibrated estimate" in tables for these models.

### Key Entities

- **Config**: Root configuration containing paths, budget token limit, server port, and model lists.
  - Attributes: `memoryRepoPath`, `claudeProjectsDir`, `budgets`, `models`, `port`.
- **Artifact**: A specific file within the memory repository.
  - Attributes: `path` (relative), `type` (INDEX, REGION, PROTOCOL, etc.), `bytes`, `characters`, `tokenCounts` (dictionary of model ID to count), `costs` (dictionary of model ID to cost).
- **Snapshot**: A point-in-time state of the memory repository.
  - Attributes: `timestamp` (UTC ISO 8601 Z), `artifacts` (list of Artifact tokens), `budgetVerdict` ("OK" | "WARN" | "OVER").
- **Session**: A parsed sequence of interactions from Claude project transcripts.
  - Attributes: `sessionId`, `model`, `requests` (list of logs), `totalSpend`, `cacheEfficiency`, `classification` ("FULL_REPO" | "AMP_MARKED").

## Success Criteria

### Measurable Outcomes

- **SC-001**: Running `npm run scan` must complete in less than 5 seconds against the live memory repository and produce a token count for `INDEX.md` within ±2% of an independent `o200k` count of the same bytes.
- **SC-002**: The budget verdict must evaluate recall injection costs: print "OK" for normal sizes (e.g. ~260 tokens vs 4,000) and exit with code 2 ("OVER") when run against a fixture exceeding 4,000 tokens.
- **SC-003**: The `sessions` command must successfully parse at least one session file under the local Claude project directories and output non-zero input, output, cache-read, and cache-creation token totals with a corresponding dollar estimate.
- **SC-004**: The `backfill` command must fetch historical states and produce at least two chronological data points written to `snapshots.ndjson`.
- **SC-005**: The local dashboard must load and display all 5 visual panels (Artifact Costs, Budget Gauge, Growth Over Time, Session Spend, Cache Efficiency) using mock/real data offline (zero external HTTP requests), and render legibly in both light and dark mode.
- **SC-006**: The entire suite must execute fully offline without requiring a GitHub API token or internet connection, provided the local clones and `.rxai-cache/` directory exist.

## Assumptions

- **A-1 (Transcript Format)**: Claude Code transcripts are stored in JSONL format inside `~/.claude/projects/<project>/*.jsonl` where each line contains standard JSON object representation of message requests including a `message.usage` block with `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, and `message.model`.
- **A-2 (Git History Availability)**: The local memory repository is a standard Git repository containing at least a few commits of `INDEX.md` and `not_indexed.md` to support the backfill time series.
- **A-3 (BPE Calibration Accuracy)**: The `o200k_base` vocabulary represents a highly accurate base model for GPT-4o, and applying a calibration ratio of 1.0 to Claude/Gemini model counts is empirically sufficient (within a few %) for tracking and budgeting purposes.
- **A-4 (Local Access Only)**: No external API keys (Anthropic/GitHub) are required for baseline operation, and all processing is done locally.
- **A-5 (No Write Operations)**: The tool is completely safe to run in any directory as it does not perform any writes or commits to the memory repository.
