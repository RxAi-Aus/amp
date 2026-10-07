# Claude Code AMP L2 Benchmark — Opus 5.5, effort unpinned — 2026-09-23

## Result

Sixteen fresh `claude -p` sessions on `claude-opus-5-5`: eight AMP-on/off
pairs, two per task, over the same four investigation tasks and the same three
expected memory issues as the Claude runs of 2026-09-06 and the Codex runs of
2026-09-10/11. AMP-on ran the installed SessionStart/PostToolUse/Stop hooks;
AMP-off ran the same hooks with `AMP_DISABLE=1`.

| Model | Pairs | Context Δ | Uncached input Δ | Tool output Δ | Tool calls Δ | Time Δ | Cost Δ | Cost lower | Start ctx on/off | Stop blocked | Memory hits | Control correct | Signal coverage on/off |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `claude-opus-5-5` | 8 | +26.8% | +74.8% | +32.2% | +12.5% | +7.9% | +41.4% | 1/8 | 31.7k / 29.6k | 0/8 | 6/6 | 2/2 | 34/34 vs 33/34 |

Negative percentages would mean the AMP-on arm used less than its disabled
pair; none did. Totals over the eight pairs:

| | AMP on | AMP off |
|---|---:|---:|
| Tool output before the answer | 156 KB | 118 KB |
| Tool calls | 54 | 48 |
| Context processed (Σ input + cache creation + cache read) | 3.22M | 2.54M |
| Uncached input (input + cache creation) | 235k | 135k |
| Wall time | 219 s | 203 s |
| List-price cost (Claude Code `result` event) | $1.91 | $1.35 |

The three memory-backed tasks alone were close to flat on tool output (89 KB
on vs 83 KB off). The control task, which no memory covers, read 14–17 KB more
in both AMP-on pairs. All six memory-eligible AMP-on sessions cited the
expected issue in their `Recall used:` line, both control sessions answered
`none`, and none of the eight AMP-off sessions produced an issue number. All
eight AMP-on ledgers recorded the same three injected issues; no session was
blocked by the Stop hook.

## Reading

This is the same shape as the Sonnet 5 result of 2026-09-06, further along the
same axis. AMP's saving is the blind exploration it prevents; Opus 5.5 does
almost none. Its AMP-off sessions averaged 15 KB of tool output per task
against Opus 5's 52 KB on the identical tasks and tree, and cost $1.35 for
eight sessions against Opus 5's $6.31. The fixed per-session price of the
injection (about 2.1k tokens of start context, then re-read on every call) and
the hook round-trips are now larger than anything the memory replaces. Recall
delivery itself did not regress: 6/6 citations, 2/2 correct controls, no
fabricated issue numbers.

## Method

- Runner: `npm run benchmark:claude` (this directory), added for this run. It
  reuses the Codex benchmark's task table, schedule and prompt rules, and runs
  `claude -p --output-format stream-json` with `--strict-mcp-config`,
  user-level settings only, `--permission-mode default`, and an explicit
  read-only allowlist (Read, Grep, Glob, and `ls`/`cat`/`head`/`tail`/`wc`/
  `tree`/`rg`/`grep`/`find`/`sed -n`/`git log|show|status|diff|branch`).
  Edit, Write, Task/Agent, Web tools, Skill and Workflow are disallowed.
- The prompt's AMP line was changed for Claude: the Codex text asked the model
  to check `AMP_DISABLE` itself, which on Claude produced a denied `echo` and a
  session that refused the memory it had been given. The Claude runner says
  memory, when enabled, is already injected, and not to run commands to check
  or fetch it. The first attempt was discarded after one pair and the run
  restarted.
- Memory store pinned: a clone of the memory repo at the 2026-09-06 18:09Z
  compile (the last state in which the three expected issues were the Region's
  top three; all three are archived by weight today), `origin` removed so the
  hook's `git pull` cannot advance it, passed as `--memory-repo` and reaching
  the hooks as `RXAI_AMP_REPO`. Issue bodies were fetched live with `gh`.
- Target pinned: a detached worktree of the target project at the same commit
  the 2026-09-06 Claude runs used.
- Effort: not pinned. No `--effort` flag was passed, and the stream events do
  not report the level Claude Code resolved. User settings at the time had a
  global `high` and no entry for this model ID, so `high` is the likely level;
  if model settings match by prefix, the `claude-opus-5` entry (`xhigh`) would
  have applied instead. Unverified. Each session produced 24–248 thinking
  tokens. The follow-up run pins `--effort xhigh`. Cache TTL as reported: 1h.
- Same schedule as the Codex runs: pair order counterbalanced, arm order
  alternating, deterministic rather than randomized.

## Limitations

- The effort level is unknown (see Method), and the 2026-09-06 Opus 5 run it is
  compared with did not record its level either. Part of the gap in how much
  each model reads may be effort rather than model.
- Two pairs per task is exploratory. The control-task increase rests on two
  pairs.
- Cost is Claude Code's list-price estimate; under a subscription it is a
  relative figure.
- Tool-output bytes are counted from stream `tool_result` blocks up to the
  answer; the 2026-09-06 Claude figures were computed from transcripts by a
  separate script, so cross-run comparisons are of like measures but not one
  pipeline.
- Both arms had a few denied compound shell commands (`cd …; …`, `for` loops);
  these were of the same kind in both arms and not AMP-related.

Raw stream JSONL, answers, ledgers, `results.ndjson`, `summary.json` and
`report.md` are retained under the gitignored
`tokenMonitor/data/claude-amp-ab/opus-5-5-2026-09-23/`.
