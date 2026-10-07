# AMP Token Monitor

Standalone, read-only monitor for the token cost of the RxAi AMP agent memory
system. Built via the Spec Kit flow in `specs/001-token-monitor/`
(spec.md → plan.md → tasks.md, authored by agy CLI from `SPEC-INPUT.md`).

It measures the five cost centers of the memory protocol:
C1 session-start injection (`INDEX.md` + `not_indexed.md`), C2 turn
amplification (visible as cache efficiency), C3 on-demand region/issue reads,
C4 write cost (output tokens), C5 protocol overhead (`PROTOCOL.md` vs the
`AGENTS.md` digest).

## Quick start

```bash
cd tokenMonitor
npm install
npm run scan        # tokenize memory artifacts + recall-budget verdict (exit 2 when OVER)
npm run sessions    # real token spend from Claude Code transcripts
npm run benchmark:codex -- --cases 20 \
  --models gpt-6-astra,gpt-5.6-sol --reasoning medium \
  --project /path/to/target-project \
  --memory-repo /path/to/AgentMemory
npm run benchmark:claude -- --cases 16 \
  --models claude-opus-5-5 --effort xhigh \
  --project /path/to/target-project \
  --memory-repo /path/to/AgentMemory-snapshot
npm run backfill    # historical time series from the memory repo's git log
npm run serve -- --watch   # dashboard at http://localhost:4173, rescan every 5 min
npm test            # unit tests
```

## Codex AMP A/B benchmark

`benchmark:codex` runs fresh, ephemeral, read-only Codex sessions against a
table of investigation tasks you define for the repository under test. A
case is one session, so `--cases 20` produces five AMP-on/off pairs for each of
two models.

**Define the tasks first.** The questions are specific to the repository being
measured, so they are not committed:

```bash
cp config/tasks.example.json config/tasks.json   # then edit
```

Each entry needs an `id`, the `question` to ask, the `signals` (strings whose
presence in the answer indicates the model reached the right material), and
`expectedIssue` — the memory issue the task should surface, or `null` for a
control task that no memory covers. `config/tasks.json` is gitignored;
`AMP_BENCH_TASKS` points at a different file. Pair order is counterbalanced. The prompts are identical between
arms; only `AMP_DISABLE=1` differs. The prompt rules live in `src/prompt_rules.ts`, shared with the
Claude Code runner: `--hooks` (L2) sends the v2 hook-delivery wording, identical to what Claude Code
gets; L1 keeps its original sentence telling the model to honour `AMP_DISABLE` itself, because with
no hooks running nothing else keeps the AMP-off arm from performing recall through the skill. Each
result records `rulesVersion` (L2 = 2, L1 = 1) and the report prints `Prompt rules: vN`.

The runner uses `--ignore-user-config` to keep connector setup out of the
measurement, records exact usage from Codex JSON events, saves raw output under
the gitignored `data/codex-amp-ab/` directory, and writes `summary.json` plus
`report.md`. Interrupted runs resume automatically from `results.ndjson`.

Both levels also pass `--ignore-rules` (execpolicy `.rules` files; on a working
machine `~/.codex/rules/default.rules` is a growing list of one-off approvals)
and `--disable memories` (Codex's own cross-session memory), so AMP is the only
memory under test. The flags between `exec` and `-m` are recorded as
`Codex flags:` in the report. Neither flag stops `AGENTS.md`: the project's
file and `$CODEX_HOME/AGENTS.md` still load, identically in both arms. There
is no temperature or seed to pin; the paired, order-alternated design is what
absorbs sampling noise.

**Cost and output composition.** `turn.completed` carries
`reasoning_output_tokens`, a subset of `output_tokens`; the second report table
splits output into reasoning and visible (the difference) and prices each arm at
the list prices in `config/prices.json` (USD per 1M tokens: `input`,
`cachedInput`, `output`; `--prices` or `AMP_BENCH_PRICES` for another file).
Cost is uncached input × input + cached input × cached + output × output, so
reasoning bills once at the output rate. Codex never reports a price, and a
ChatGPT-plan run is not billed per token: the column is the API-equivalent, and
a model missing from the file reads `n/a`. In agentic sessions input dominates
(hundreds of thousands of tokens re-sent per call, ~85% cached), so a raw
`Input tokens Δ` can fall while `Cost Δ` rises; read the two together.

**Per-call telemetry (`--rollouts`).** With `--rollouts` the runner drops
`--ephemeral`, finds each session's `rollout-*-<thread id>.jsonl` under
`$CODEX_HOME/sessions/`, copies it next to the run as `<id>.rollout.jsonl`, and
adds a third table from its `token_count` events: model calls per case, the
first call's input (system prompt, tools, AGENTS.md, injected recall), peak
single-call input, and cold starts (a first call with no cached input). Like
`--hooks`, it requires `CODEX_HOME` to point at an isolated home, never
`~/.codex`, so benchmark sessions stay out of your own `codex resume` history;
at L1 that home needs its own `auth.json`.

**Re-render without spending tokens.** `--report-only --out <run dir>` rebuilds
`summary.json` and `report.md` from `results.ndjson` with the current prices and
report layout, carrying the run's metadata over from its old summary. It needs
no `--models`, `--project` or memory repo.

Before an AMP-on run, sync the configured memory clone's local cache so agents
can read issue bodies without network access:

```bash
cd /path/to/AgentMemory
GH_TOKEN="$(gh auth token)" REPO_OWNER=owner REPO_NAME=repo npm run cache:sync
```

The benchmark never edits the target project. It requires an existing local
AMP cache and exits during preflight if the cache is absent.

## Claude Code AMP A/B benchmark

`benchmark:claude` is the L2 counterpart for Claude Code: the same task table,
schedule, prompt rules and `Recall used:` line, run through `claude -p` with
the installed SessionStart/PostToolUse/Stop hooks. The AMP-off arm sets
`AMP_DISABLE=1` so the same hooks become no-ops. Sessions are read-only via an
explicit tool allowlist (Read, Grep, Glob, and a short list of read-only shell
prefixes); user MCP connectors are excluded with `--strict-mcp-config` and
only user-level settings load, so the two arms differ in nothing but the hook
injection.

`--models` is required; there is no default model. Pass `--effort` too: without
it Claude Code resolves the level from user settings, which the stream events do
not report, so the run records the effort as `unset` and cannot be compared
across settings changes.

`--memory-repo` is passed to the hooks as `RXAI_AMP_REPO`. Point it at a
pinned clone of the memory repo (with `origin` removed so the hook's
`git pull` cannot move it) when a run must see the same records as an earlier
one; the store keeps decaying otherwise. Usage is exact from the `assistant`
and `result` stream events: context tokens per API call (input + cache
creation + cache read), output, wall time, and the list-price cost Claude Code
reports. The ledger each AMP-on session wrote is copied into `results.ndjson`
as the evidence that recall was injected. Output goes under the gitignored
`data/claude-amp-ab/` directory unless `--out` says otherwise.

The report keeps the hooks' side and the model's side apart. **Injected
(ledger)** counts memory tasks whose expected issue the AMP-on session ledger
records as injected at the summary tier (a title-only listing is noted as
`pointer`); **Cited (model)** counts those whose answer names it on the
`Recall used:` line. **Control silent (ledger)** and **Control none (model)**
are the same pair for control tasks. The two sides differ when the model had the
summary in context and did not attribute it — on 2026-09-23 two Opus sessions
did exactly that, and a single "Memory hits" column read as a retrieval miss.
The prompt rules carry a version (`RULES_VERSION` in `src/prompt_rules.ts`, shared
with the Codex runner's L2 mode, printed in the report as `Prompt rules: vN`); v2
tells the model memory arrives at session start and/or alongside the prompt, where
v1 said session start alone. Compare citation rates only across runs made under
the same version.

`tokmon.config.json` is auto-created on first run — paths, the recall budget
(default 4,000 tokens ≈ the IMPROVEMENT.md Plan-1 target), and the per-model
price table (Claude prices verified 2026-08-08; GPT/Gemini rows are labeled
estimates — edit them).

## How counting works

- Exact `o200k_base` BPE (pure-JS `gpt-tokenizer`) is the base measure.
- Claude/Gemini vocabularies aren't public; per-model columns are
  `o200k × calibrationRatio` and always labeled ≈. Claude's default ratio is
  1.18 (o200k undercounts Claude tokens by ~15–20%). For exact Claude counts
  use the Anthropic `count_tokens` API and tune `calibrationRatio`.
- Session numbers are exact — read from `message.usage` in
  `~/.claude/projects/*/*.jsonl` (input / output / cache-read / cache-write),
  priced with cache reads at 0.1× and cache writes at 1.25× input price.
- "Memory sessions" = full totals of sessions in memory-repo project dirs;
  "AMP-marked activity" = only requests carrying AMP markers (`[FROM:`,
  `rxai-amp`, …) inside other projects. The two are never conflated.

## Core monitor guarantees

- **Read-only**: the scan, report, sessions, and backfill commands never write
  to GitHub or any memory artifact; git usage is `log`/`show` only.
- **Offline**: those core monitor commands have no network egress and work with
  local clones only. The explicit `benchmark:codex` command calls the Codex
  service and writes raw results only to its chosen output directory.
- **Private**: `data/snapshots.ndjson` and everything derived from transcripts
  stays local and gitignored.

## Layout

```
src/            config, tokenize, artifacts, snapshots, report,
                transcripts, backfill, server, cli
public/index.html   self-contained dashboard (hand-rolled SVG, light/dark)
tests/          node:test suite (run via npm test)
data/           snapshots.ndjson (gitignored)
specs/          Spec Kit documents for feature 001-token-monitor
```
