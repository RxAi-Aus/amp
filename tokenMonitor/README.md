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
npm run backfill    # historical time series from the memory repo's git log
npm run serve -- --watch   # dashboard at http://localhost:4173, rescan every 5 min
npm test            # 13 node:test unit tests
```

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

## Guarantees

- **Read-only**: never writes to GitHub or any memory artifact; git usage is
  `log`/`show` only.
- **Offline**: no network egress at all; works with local clones only.
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
