# AMP Token Monitor — Input Specification (v1.0, 2026-08-08)

Author: Claude (claudecowork), acting as LLM token-usage expert.
Audience: the Spec Kit pipeline (`/speckit.specify` → `/speckit.plan` → `/speckit.tasks`) and the implementing agent.

## 1. Problem

RxAi AMP (Agent Memory Protocol) stores agent memory as GitHub Issues and injects
compiled index files into every agent session. Nobody currently knows what this
costs in LLM tokens, per session or over time. The protocol's own roadmap
(IMPROVEMENT.md "Direction Plans — 2026-08-08", Plan 1) sets a hard target —
session-start injection stays under ~15 KB regardless of memory growth — but
there is no instrument that measures it. Build that instrument: a standalone,
read-only monitoring app.

## 2. Token cost model of the memory system (domain analysis)

The system spends tokens in five distinct cost centers:

- **C1 — RECALL injection (per session start).** L2 agents (Claude Code hooks)
  inject `INDEX.md` + `not_indexed.md` verbatim; folderless agents (hermes)
  read `AGENTS.md` (8.6 KB) as digest. Today: INDEX.md 786 B + not_indexed.md
  236 B ≈ ~260 tokens — tiny, but it grows with region count and churn.
- **C2 — Turn amplification.** Injected context is re-sent on *every*
  conversation turn as input tokens. With prompt caching, turns 2..n pay the
  cache-read rate (~10% of input rate on Claude); a mid-session file change
  invalidates the prefix and re-pays full price. Effective session cost ≈
  `tok(inject) × (1 + (turns−1) × cacheReadRatio)`.
- **C3 — Navigation reads (per task).** `REGION-{name}.md` files, issue bodies
  + comments fetched on demand, `cache:search` output.
- **C4 — Write cost.** Composing issue/comment bodies is *output* tokens,
  typically ~5× the input price.
- **C5 — Protocol overhead.** Worst case an agent reads `PROTOCOL.md` whole
  (71 KB ≈ ~18k tokens); `AGENTS.md` and the `rxai-amp` skill exist precisely
  to avoid this. The monitor should make that avoidance visible.

## 3. Goals

1. **Artifact cost projection (static):** exact token counts for every memory
   artifact, per configured model, with $ cost estimates.
2. **Recall budget enforcement:** compute current C1 injection cost against a
   configurable budget (default 4,000 tokens ≈ 15 KB) → OK / WARN (≥80%) / OVER.
3. **Growth tracking:** timestamped snapshots (ndjson) on every scan; optional
   git-history backfill tokenizing `INDEX.md`/`not_indexed.md`/`REGION-*.md`
   at past commits of the memory repo for a retroactive time series.
4. **Live session attribution (Claude Code):** parse
   `~/.claude/projects/<project>/*.jsonl` transcripts; per assistant request
   read `message.usage` (`input_tokens`, `cache_creation_input_tokens`,
   `cache_read_input_tokens`, `output_tokens`) and `message.model`. Report
   (a) full totals for sessions whose project dir is a memory-repo clone, and
   (b) "AMP-marked activity" inside other projects' sessions — requests whose
   content matches AMP markers (`[FROM:` + `[REGION:` title grammar,
   `rxai-amp` skill invocation, "RxAi AMP shared memory" block, issue writes
   to the memory slug). Report the two classes separately; never conflate.
5. **Cache efficiency:** per session, ratio `cache_read / (input +
   cache_creation + cache_read)` — shows whether C2 amplification is being
   absorbed by caching.
6. **CLI + dashboard:** CLI commands for scan/report/sessions/backfill; a
   self-contained localhost web dashboard with charts (artifact costs, budget
   gauge, growth over time, session spend, cache efficiency) that stays
   running and refreshes (watch mode).

## 4. Non-goals

- No writes to GitHub, no modification of any memory artifact, no posting of
  memory issues (read-only projection, same stance as the repo's other tools).
- No cloud/hosted component, no telemetry, no network egress except optional
  read-only GitHub API reads (issue bodies when no local cache) — default off.
- No hermes/agy transcript parsing in v1 (schemas unverified) — design the
  session-source layer as pluggable so they can be added later.
- Not a proxy/interceptor: it measures artifacts and reads logs after the
  fact; it does not sit in the request path.

## 5. Users & primary use cases

- **James (owner):** "what does memory recall cost me today, per model, and is
  it growing toward the budget ceiling?" — runs dashboard, checks weekly.
- **Agents (claudecowork etc.):** run `scan --json` inside a session to check
  the budget before/after posting memories.
- **CI (later):** budget check as a workflow gate (exit code ≠ 0 when OVER).

## 6. Functional requirements

- FR-1 `scan`: tokenize all artifacts of the configured memory repo
  (`INDEX.md`, `not_indexed.md`, every `REGION-*.md`, `AGENTS.md`,
  `PROTOCOL.md`, skill files, and — when `.rxai-cache/` exists — every cached
  issue body+comments). Output: per-artifact × per-model token table + totals
  + C1 budget verdict. Appends one snapshot line to `data/snapshots.ndjson`.
- FR-2 `report`: human-readable summary (terminal) from the latest scan +
  trend vs previous snapshots (Δ tokens/week).
- FR-3 `sessions`: transcript analysis per §3.4/§3.5 with per-day, per-model
  aggregation and $ estimates.
- FR-4 `backfill --since <date>`: git-history time series (memory repo).
- FR-5 `serve [--watch]`: localhost dashboard (default port 4173); `--watch`
  rescans on interval (default 5 min) and on artifact file changes.
- FR-6 `--json` on every command for machine consumption; exit code 2 when
  budget OVER (CI-friendly).
- FR-7 Config file `tokmon.config.json` (auto-created with defaults on first
  run): `memoryRepoPath` (default `~/Documents/AgentMemory`),
  `claudeProjectsDir` (default `~/.claude/projects`), `budgets`
  (`recallInjectionTokens: 4000`), `models[]` — each `{ id, label, tokenizer:
  "o200k" | "approx", calibrationRatio, pricePerMTokInput, pricePerMTokOutput,
  cacheReadRatio, cacheWriteRatio }` — and `port`. All prices editable; ship
  with current published prices for the Claude family (verified at build
  time), and clearly-labeled editable estimates for GPT/Gemini rows.

## 7. Token counting methodology

- Exact BPE where the vocabulary is public: `gpt-tokenizer` (pure JS, zero
  native deps) with `o200k_base` — exact for the GPT-4o/5 family.
- Claude & Gemini vocabularies are not public: count with o200k as the base
  measure × per-family `calibrationRatio` (config; default 1.0 for Claude
  family — o200k is empirically within a few % on English/Markdown — and 1.0
  for Gemini). Label these columns "≈ calibrated estimate" in all outputs.
- Optional `--exact-claude` flag (later, off by default): call Anthropic's
  count-tokens API when `ANTHROPIC_API_KEY` is present, to measure the true
  ratio and suggest a better `calibrationRatio`. v1 may stub this.
- Bytes and chars are always reported alongside tokens (they are
  tokenizer-independent ground truth).

## 8. Constraints

- Lives at `tokenMonitor/` inside the AMP dev repo as a **self-contained
  subproject**: own `package.json`, own `tsconfig.json`, own `node_modules`.
  Runtime deps: `gpt-tokenizer` ONLY. Dev deps: `typescript` only. The parent
  repo's zero-dep rule stays intact outside this folder.
- Node 22 ESM TypeScript, 2-space indent, camelCase — match parent repo style.
- Dashboard: ONE self-contained HTML file (inline CSS/JS, hand-rolled
  SVG/canvas charts, no CDN, no framework), served by `node:http`. Light +
  dark theme aware.
- Read-only toward the memory system. `data/` (snapshots) is gitignored —
  transcripts contain personal data; nothing derived from them is committed.
- All timestamps UTC ISO 8601 `Z`.

## 9. Success criteria (acceptance)

- SC-1: `npm run scan` completes < 5 s against the live repo and prints a
  table whose INDEX.md token count is within ±2% of an independent o200k
  count of the same bytes.
- SC-2: Budget verdict reproduces Plan-1 semantics: with today's artifacts it
  reports OK (~260 tokens vs 4,000), and OVER when pointed at a fixture
  exceeding the budget.
- SC-3: `sessions` finds ≥1 real session under the AgentMemory project dirs
  and reports non-zero input/output/cache token totals and a $ estimate.
- SC-4: `backfill` produces ≥2 historical points from the memory repo's git
  history.
- SC-5: Dashboard renders all five panels from real data with zero external
  network requests, in light and dark mode.
- SC-6: Whole pipeline runs offline (no GH token needed) when `.rxai-cache/`
  and local clones exist.

## 10. Suggested layout (hint, not mandate)

```
tokenMonitor/
  package.json  tsconfig.json  tokmon.config.json  README.md
  src/ cli.ts config.ts tokenize.ts artifacts.ts transcripts.ts
      snapshots.ts backfill.ts report.ts server.ts
  public/ index.html
  data/ (gitignored)
```
