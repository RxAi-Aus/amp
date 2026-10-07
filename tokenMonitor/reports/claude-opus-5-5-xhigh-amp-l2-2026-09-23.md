# Claude Code AMP L2 Benchmark — Opus 5.5 at xhigh — 2026-09-23

## Result

A repeat of the same day's Opus 5.5 run with the effort pinned:
`--effort xhigh`. The first run passed no effort flag, and Claude Code does not
report the level it resolved. Everything else is identical: the same pinned
memory snapshot, the same detached worktree of the target project, the same
four tasks, two pairs per task, and the same allowlist and prompt.

| Model | Effort | Pairs | Context Δ | Uncached input Δ | Tool output Δ | Tool calls Δ | Time Δ | Cost Δ | Cost lower | Start ctx on/off | Stop blocked | Memory hits | Control correct | Signal coverage on/off |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `claude-opus-5-5` | xhigh | 8 | +27.9% | +46.8% | +19.2% | +7.4% | +7.1% | +27.1% | 1/8 | 31.7k / 29.6k | 0/8 | 6/6 | 2/2 | 34/34 vs 34/34 |

| Totals over 8 pairs | Unpinned: AMP on / off | xhigh: AMP on / off |
|---|---:|---:|
| Tool output before the answer | 156 / 118 KB | 381 / 320 KB |
| Tool calls | 54 / 48 | 87 / 81 |
| Thinking tokens | 1,005 / 897 | 3,952 / 4,429 |
| Wall time | 219 / 203 s | 327 / 305 s |
| List-price cost | $1.91 / $1.35 | $3.35 / $2.63 |

Thinking roughly quadrupled, which confirms the unpinned run was not at xhigh.
At xhigh the AMP-off arm read 40 KB per task, up from 15 KB. That puts it
between Sonnet 5 (29 KB) and Opus 5 (52 KB) on the same tasks.

## Per task

| Task | Tool output on / off | Cost on / off |
|---|---:|---:|
| Image pipeline (#373) | 56 / 56 KB | $0.56 / $0.52 |
| Invitation email (#368) | 71 / 74 KB | $0.67 / $0.63 |
| Spec scope (#355) | 141 / 70 KB | $1.25 / $0.65 |
| Payments (control) | 113 / 119 KB | $0.87 / $0.83 |

Without the spec task, AMP-on read 4% less (240 vs 250 KB) and cost 6% more
($2.10 vs $1.98). That difference is about the per-session price of the
injection. The spec task accounts for the whole remaining gap.

## Reading

The injected #355 is an intent record. Its body lists the user's clarified MVP
decisions: sharing in the MVP, a 20-item free wall, points rules, a points
charge for AI transcription, and browser-side upload compaction. At xhigh, both
AMP-on spec sessions treated that list as things to verify. They ran 17–21 tool
calls and searched the code for child PINs, sharing, credit packs, App Check,
backups and Apple sign-in. Both AMP-off sessions answered from the spec files
and the `tasks.md` checkbox counts in 10–13 calls. The unpinned run showed no
such effect. The memory was correct; its content widened the question. An
injected intent should carry the goal and the current state, and leave
decision lists in the issue body for an on-demand fetch.

Recall delivery held at xhigh as it did unpinned. All 6 memory-backed sessions
cited the expected issue, both controls answered `none`, no AMP-off session
produced an issue number, and all 8 AMP-on ledgers recorded the same three
injected records.

## Method

As in `claude-opus-5-5-amp-l2-2026-09-23.md`, plus `--effort xhigh`. The runner
now requires `--models` and records the effort in `results.ndjson`,
`summary.json` and the report. The 2026-09-06 Opus 5 run it is compared with
did not record its effort either.

## Limitations

- Two pairs per task. The spec-task finding rests on two pairs, but both show
  it strongly (22→68 KB and 47→73 KB).
- Cost is Claude Code's list-price estimate.
- Both arms had a few denied compound shell commands, the same as in the
  unpinned run. None were AMP-related.

Raw output is retained under the gitignored
`tokenMonitor/data/claude-amp-ab/opus-5-5-xhigh-2026-09-23/`.
