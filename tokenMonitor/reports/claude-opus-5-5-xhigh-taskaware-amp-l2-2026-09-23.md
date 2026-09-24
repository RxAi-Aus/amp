# Claude Code AMP L2 Benchmark — Opus 5.5 at xhigh, task-aware recall (v2.11) — 2026-09-23

## Result

A repeat of the same day's Opus 5.5 `xhigh` run with the v2.11 adapter
installed: the same pinned memory snapshot (2026-09-06 compile), the same
detached worktree of the target project, the same four tasks, two pairs per
task, the same allowlist and prompt. Only the hooks changed. `SessionStart`
now injects the three matching records as pointer lines (title only, no
network); a new `UserPromptSubmit` hook expands to the summary tier — a
record's `## Now` section, else the opening prose of its `## Message` before
the first list, ≤ 240 characters — just the records whose title or Place
lexically overlap the prompt, each once per session. Bodies were fetched
live with `gh`.

| Model | Effort | Pairs | Context Δ | Uncached input Δ | Tool output Δ | Tool calls Δ | Time Δ | Cost Δ | Cost lower | Start ctx on/off | Stop blocked | Memory hits | Control correct | Signal coverage on/off |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `claude-opus-5-5` | xhigh | 8 | −13.6% | +21.2% | −14.9% | −11.1% | −9.0% | +4.9% | 4/8 | 31.2k / 29.5k | 0/8 | 4/6 | 2/2 | 34/34 vs 34/34 |

| Totals over 8 pairs | xhigh, v2.10 hooks: AMP on / off | xhigh, v2.11 hooks: AMP on / off |
|---|---:|---:|
| Tool output before the answer | 381 / 320 KB | 272 / 320 KB |
| Tool calls | 87 / 81 | 80 / 90 |
| Context processed (Σ input + cache creation + cache read) | 7.17M / 5.61M | 5.27M / 6.10M |
| Uncached input (input + cache creation) | 575k / 392k | 491k / 405k |
| Wall time | 327 / 305 s | 300 / 329 s |
| List-price cost | $3.35 / $2.63 | $2.90 / $2.76 |

The AMP-on arm went from reading 19% more than its disabled pair to reading
15% less, and from costing 27% more to 5% more. Time flipped from +7% to −9%.

## Per task

| Task | Tool output on / off (v2.10 hooks) | Tool output on / off (v2.11) | Cost on / off (v2.11) | Prompt-stage expansion (ledger) | `Recall used:` (on) |
|---|---:|---:|---:|---|---|
| Image pipeline (#373) | 28 / 28 KB | 26 / 33 KB | $0.38 / $0.26 | #373, #368 | #373, #373 |
| Invitation email (#368) | 35 / 37 KB | 31 / 33 KB | $0.31 / $0.29 | #368 | #368, none |
| Spec scope (#355) | 70 / 35 KB | 22 / 34 KB | $0.33 / $0.40 | #355, #368 | none, #355 |
| Payments (control) | 57 / 60 KB | 57 / 60 KB | $0.43 / $0.43 | #368 | none, none |

The spec task, which the previous run singled out — its injected intent
listed the user's decisions and both AMP-on sessions went to verify them —
now reads 22 KB against 34 KB off and costs less than its pair. The summary
tier of #355 is one sentence of goal and state; the decision list stays in
the body. The image pair's cost gap is one session: the first session of the
run cost $0.48 for the same 26 KB and 9 calls its repeat cost $0.29.

The control task is flat. #368 was expanded in every session, including both
control sessions, because its title ("… on Cloud Functions v2") shares
"function" and "cloud" with every question about this Firebase app. Injecting
it cost the control task nothing measurable here (57 vs 60 KB, $0.43 vs
$0.43), but it is noise, and the matcher in the template now weighs a Place
token or a store-rare term at 2, generic software vocabulary at 0.5, and
expands at 2 or above: on this snapshot the four tasks then expand exactly
#373, #368, #355 and nothing. That change was not installed for this run;
`claude-opus-5-5-xhigh-b2-amp-l2-2026-09-23.md` measures it.

## Reading

Recall citations fell from 6/6 to 4/6. Two sessions (one email, one spec)
answered `Recall used: none` although the ledger shows the matching summary
was expanded for them; both still covered every answer signal. The prompt
tells the model that memory "is already injected into your context at
session start", and the summaries now arrive with the prompt instead, so
part of this may be attribution rather than use. The v2.10 evidence that
memory content reached the answers — the SMTP `535 BadCredentials` gotcha in
#368, present in both AMP-on email answers before — is absent from both now:
that detail is a list item deep in the body, and the summary tier deliberately
stops at the first list. The model is told to fetch a body before acting on
its details; the benchmark prompt forbids fetching. That is the trade the
summary tier makes, and this run shows its price on a fact that lives below
the fold.

No AMP-off session produced an issue number. No session was blocked by the
Stop hook. Thinking tokens: 5,580 on / 4,825 off (the earlier xhigh run:
3,952 / 4,429), so both runs sat at the same effort.

## Method

As in `claude-opus-5-5-xhigh-amp-l2-2026-09-23.md`. The installed hooks are
the v2.11 adapter (`session-start.mjs` at the pointer tier,
`user-prompt-submit.mjs`, unchanged `post-tool-use.mjs` and `stop.mjs`),
registered by `hooks:install:claude`. `UserPromptSubmit` output is not
recorded in the `stream-json` events, so the ledger each AMP-on session wrote
(`tier: "summary"` on the expanded records) is the evidence that the stage
fired. It is not evidence that the bodies were fetched: the v2.11 ledger
keeps the pointer's title when it upgrades an entry to `summary`, so every
expanded record shows the index's untagged title whether or not `gh`
returned the body (fixed in the template after this run — the ledger now
records the fetched title). That the fetch works under this runner was
verified separately: the installed hook, run by hand under the real
`~/.rxai-amp/config.json` with a fresh session id and the email question,
emits the tagged title and the summary text; a probe hook registered through
`--settings` inside a `claude -p` session spawned with the runner's exact
arguments fetched the same issue; and an identically spawned session running
the template's hook with diagnostics on logged the fetched title. The runner
recorded the effort as `xhigh`.

## Limitations

- Two pairs per task; the per-task differences rest on two sessions each.
- The matcher installed for this run expanded #368 on every task; the
  weighting that prevents this exists only in the template as of this report.
- The citation drop (4/6) is consistent with attribution wording as much as
  with non-use; the prompt was not changed between runs.
- Cost is Claude Code's list-price estimate.

Raw output is retained under the gitignored
`tokenMonitor/data/claude-amp-ab/opus-5-5-xhigh-taskaware-2026-09-23/`.
