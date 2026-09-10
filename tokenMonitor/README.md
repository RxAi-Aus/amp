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
arms; only `AMP_DISABLE=1` differs.

The runner uses `--ignore-user-config` to keep connector setup out of the
measurement, records exact usage from Codex JSON events, saves raw output under
the gitignored `data/codex-amp-ab/` directory, and writes `summary.json` plus
`report.md`. Interrupted runs resume automatically from `results.ndjson`.

Before an AMP-on run, sync the configured memory clone's local cache so agents
can read issue bodies without network access:

```bash
cd /path/to/AgentMemory
GH_TOKEN="$(gh auth token)" REPO_OWNER=owner REPO_NAME=repo npm run cache:sync
```

The benchmark never edits the target project. It requires an existing local
AMP cache and exits during preflight if the cache is absent.

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
