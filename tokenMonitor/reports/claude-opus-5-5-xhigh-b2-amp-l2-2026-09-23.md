# Claude Code AMP L2 Benchmark — Opus 5.5 at xhigh, weighted prompt matching (B2) — 2026-09-23

## Result

A third run of the same day's Opus 5.5 `xhigh` set-up — pinned memory
snapshot, pinned worktree, four tasks, two pairs per task, same allowlist and
prompt — with one change to the hooks since the task-aware run: prompt
overlaps are weighted (a Place token 2, generic software vocabulary 0.5, a
term rare across the store's pointer rows 2, anything else 1) and a record
expands at 2 or above. The previous run had expanded the SMTP record on every
task, control included, because its title shares "function" and "cloud" with
every question about this app. This run expanded exactly the expected record
on each memory-backed task and nothing on the control (ledgers: #373, #368,
#355, none; every expansion carries the fetched, tagged title).

| Model | Effort | Pairs | Context Δ | Uncached input Δ | Tool output Δ | Tool calls Δ | Time Δ | Cost Δ | Cost lower | Start ctx on/off | Stop blocked | Memory hits | Control correct | Signal coverage on/off |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `claude-opus-5-5` | xhigh | 8 | −6.5% | +34.6% | −4.6% | −6.1% | −3.9% | +14.1% | 3/8 | 31.0k / 29.5k | 0/8 | 5/6 | 2/2 | 34/34 vs 34/34 |

| Totals over 8 pairs | v2.10 hooks | v2.11 (task-aware) | B2 (weighted) |
|---|---:|---:|---:|
| Tool output before the answer | 381 / 320 KB (+19.2%) | 272 / 320 KB (−14.9%) | 290 / 304 KB (−4.6%) |
| Tool calls | 87 / 81 | 80 / 90 | 77 / 82 |
| Context processed | 7.17M / 5.61M (+27.9%) | 5.27M / 6.10M (−13.6%) | 5.42M / 5.79M (−6.5%) |
| Wall time | 327 / 305 s | 300 / 329 s | 307 / 319 s |
| List-price cost | $3.35 / $2.63 (+27.1%) | $2.90 / $2.76 (+4.9%) | $2.97 / $2.60 (+14.1%) |
| Memory hits / control / signals | 6/6 · 2/2 · 34/34 | 4/6 · 2/2 · 34/34 | 5/6 · 2/2 · 34/34 |
| Thinking tokens on / off | 3,952 / 4,429 | 5,580 / 4,825 | 5,579 / 5,916 |

## Per task

| Task | v2.10 on / off | v2.11 on / off | B2 on / off | B2 cost on / off | B2 expansion | `Recall used:` (on) |
|---|---:|---:|---:|---:|---|---|
| Image pipeline (#373) | 28 / 28 KB | 26 / 33 KB | 28 / 28 KB | $0.36 / $0.21 | #373 | #373, #373 |
| Invitation email (#368) | 35 / 37 KB | 31 / 33 KB | 27 / 34 KB | $0.31 / $0.29 | #368 | #368, none |
| Spec scope (#355) | 70 / 35 KB | 22 / 34 KB | 25 / 32 KB | $0.32 / $0.36 | #355 | #355, #355 |
| Payments (control) | 57 / 60 KB | 57 / 60 KB | 66 / 58 KB | $0.49 / $0.43 | — | none, none |

## Reading

The weighting did what it was built to do — the control task received no
memory at all — and the benchmark cannot see a benefit from it. The whole
difference between this run and the task-aware one sits in two places: the
control task read 66 KB against 57 KB with nothing injected, where the
previous run had read 57 KB with an unrelated summary injected; and the
first session of the run again cost more for the same reading ($0.45 for
27 KB and 8 calls, against $0.28 for its repeat). The AMP-off arm itself
moved from 320 KB to 304 KB between the two runs on an identical tree and
prompt. At two pairs per task, differences of this size are the noise of the
measurement, not the effect of the change. What the three runs do show
together is stable: both task-aware variants read less than their disabled
pair and cost a few percent more, where the v2.10 hooks read 19% more and
cost 27% more; the spec task's doubling is gone in both.

Citations 5/6: the same email slot (pair 6) answered `Recall used: none` as
in the previous run, with the summary in context; both spec sessions cited
#355 this time.

The unrelated expansion that B2 removes was not what the control task had
been paying for. Its remaining excess — 8 KB here, 14–17 KB in the unpinned
run — comes with the navigation layer and the pointer lines themselves, which
are injected before the task is known. The lever left on the control task is
the size of that block, not the matcher.

## Method

As in `claude-opus-5-5-xhigh-taskaware-amp-l2-2026-09-23.md`; the installed
hooks are the template's 48e3af2 as ported to the fork (9adb7630). Bodies
were fetched live with `gh`; since this port the ledger records the fetched
title on expansion, so the `[FROM:…]` tags in the ledgers are direct
evidence of the fetch.

## Limitations

- Two pairs per task. The AMP-off arm alone varies ~5% between runs.
- The first session of a run costs more than its repeat in all three runs;
  the runner does not yet warm the cache or randomise which arm goes first.
- Cost is Claude Code's list-price estimate.

Raw output is retained under the gitignored
`tokenMonitor/data/claude-amp-ab/opus-5-5-xhigh-b2-2026-09-23/`.
