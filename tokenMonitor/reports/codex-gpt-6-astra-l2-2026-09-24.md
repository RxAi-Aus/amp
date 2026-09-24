# Codex AMP L2 Benchmark — gpt-6-astra at medium and xhigh, isolated rerun — 2026-09-24

## Result

Two runs of the Codex L2 benchmark on `gpt-6-astra`, one at medium and one at
xhigh reasoning, four AMP-on/off pairs each (one per task), on the same pinned
memory snapshot (2026-09-06 18:09Z compile) and the same target-project commit
as every other 2026-09-23/24 run. Prompt rules v2; the runner passed
`--ignore-rules` and `--disable memories`, so AMP was the only memory in
either arm. Bodies were fetched live with `gh`.

| Model | Effort | Pairs | Input tokens Δ | Uncached input Δ | Tool output Δ | Command calls Δ | Time Δ | Output tokens Δ | Input lower | Cited (model) | Control none | Injected ledgers exact | Signal coverage on/off |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `gpt-6-astra` | medium | 4 | +9.9% | +7.3% | −4.5% | −12.5% | −1.7% | −11.7% | 2/4 | 2/3 | 1/1 | 4/4 | 17/17 vs 17/17 |
| `gpt-6-astra` | xhigh | 4 | −3.4% | −9.6% | −13.6% | −5.4% | −10.7% | −18.3% | 2/4 | 3/3 | 1/1 | 4/4 | 17/17 vs 17/17 |

Negative percentages mean the AMP-on arm used less than its disabled pair.
No price row exists for this model in `config/prices.json`, so the report
carries no cost column.

| Totals over 4 pairs | medium: AMP on / off | xhigh: AMP on / off |
|---|---:|---:|
| Input tokens | 834k / 759k | 1.24M / 1.28M |
| Uncached input | 154k / 143k | 210k / 232k |
| Tool output before the answer | 488 / 511 KB | 827 / 957 KB |
| Command calls | 21 / 24 | 53 / 56 |
| Wall time | 217 / 221 s | 434 / 486 s |
| Output tokens (reasoning included) | 4.1k / 4.7k | 11.0k / 13.5k |

## Per task

| Task | medium: input on / off | medium: tool output on / off | medium `Recall used:` | xhigh: input on / off | xhigh: tool output on / off | xhigh `Recall used:` |
|---|---:|---:|---|---:|---:|---|
| Image pipeline (#373) | 122k / 90k | 32 / 29 KB | #373 | 168k / 137k | 89 / 66 KB | #373 |
| Invitation email (#368) | 127k / 158k | 40 / 43 KB | #368 | 145k / 198k | 55 / 93 KB | #368 |
| Spec scope (#355) | 402k / 315k | 300 / 332 KB | none | 646k / 689k | 499 / 494 KB | #355, #373 |
| Payments (control) | 184k / 196k | 117 / 107 KB | none | 280k / 258k | 184 / 304 KB | none |

Every AMP-on ledger recorded #355, #373 and #368 injected at the summary tier
at session start (Codex has no prompt-stage hook), the control session
included. Every AMP-off answer said `none`.

## Reading

This is the model whose delivery comparison anchors §15.3: at medium on
2026-09-10/11 it went from +46.2% input at L1 to −5.6% at L2. Re-run at L2 on
the pinned snapshot with Codex's own memory switched off, it is +9.9% at
medium and −3.4% at xhigh. The two runs sit on the same line as the Claude
Code series — the harder the model reasons, the more it reads without memory
(128 KB per task at medium, 239 KB at xhigh), and the more there is for memory
to replace: at xhigh the AMP-on arm dug up 13.6% less, made fewer calls,
wrote 18% less and finished 10.7% sooner; at medium it broke even on reading
and paid for the injection in input tokens.

The spec task is the whole medium-run gap: 402k against 315k input, with a
`Recall used: none` although the ledger shows the spec intent's summary in
context — the attribution pattern seen on Claude Code. At xhigh the same task
cited #355 (and #373) and read less than its pair. Citations 5/6 overall under
the v2 wording, the first Codex rows where the Cited column is meaningful.

## Method

As in `codex-amp-l2-2026-09-11.md`, with the additions since: `--hooks` with
the v2 prompt rules shared with the Claude Code runner (`src/prompt_rules.ts`),
`--memory-repo` pointing at the pinned snapshot with its remote removed, an
isolated `CODEX_HOME` with the AMP hooks trusted, and the Codex flags
`--json --ephemeral --dangerously-bypass-hook-trust --ignore-rules --disable memories`.
Usage is read from Codex `turn.completed` events; `cached_input_tokens` is a
subset of `input_tokens` and uncached input is their difference.

## Limitations

- Four pairs per run, one per task: a single session moves a total by several
  points, and the medium/xhigh difference rests on eight sessions.
- No verified price table for this model, so no cost estimate.
- Codex's `additionalContextLimit` for the SessionStart hook is 2,500
  characters and the summary-tier block is about 3,400; the last record's
  summary may be truncated. Both invitation-email answers still cited it.
- Tool output is command-output bytes, not the same quantity as Claude Code's
  `tool_result` bytes; compare direction across runtimes, not magnitude.

Raw JSONL, answers, ledgers, `results.ndjson`, `summary.json` and `report.md`
are retained under the gitignored
`tokenMonitor/data/codex-amp-ab/2026-09-24-astra-{medium,xhigh}-l2-8/`.
