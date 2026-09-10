# Codex AMP A/B Benchmark — 2026-09-10

## Result

This run found no token or time saving from the Codex L1 AMP workflow. AMP-on
used more total input, uncached input, tool output, and wall time for both
models. Every one of the ten paired comparisons had higher AMP-on input and
wall time.

| Model | Pairs | Input tokens on/off | Input Δ | Uncached input on/off | Uncached Δ | Tool output Δ | Time Δ | Memory hits | Control correct |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `gpt-6-astra` medium | 5 | 1,247,860 / 853,651 | +46.2% | 200,308 / 154,131 | +30.0% | +34.2% | +35.4% | 0/4 | 1/1 |
| `gpt-5.6-sol` medium | 5 | 2,345,491 / 1,412,006 | +66.1% | 320,915 / 260,646 | +23.1% | +44.4% | +31.5% | 2/4 | 1/1 |

`cached_input_tokens` is a subset of Codex's `input_tokens`; uncached input is
their difference. The benchmark does not estimate prices because no verified
price table was supplied for these two model IDs.

## Method

- 20 successful fresh, ephemeral, read-only Codex sessions: 10 per model, five
  AMP-on/off pairs per model.
- Medium reasoning for both models.
- Same four investigation tasks on the target project as the earlier Claude
  benchmark:
  image derivation, invitation email, spec-kit scope, and payments.
- The fifth pair rotates back through the task list with a model offset.
- Prompts within each pair are identical. Only `AMP_DISABLE=1` differs.
- Arm order alternates and is offset between models. The overall schedule is
  deterministic rather than randomized.
- User-configured MCP connectors are excluded with `--ignore-user-config`.
- AMP issue bodies are available through a freshly synchronized local cache;
  benchmark agents have no need for live GitHub access.
- Target snapshot: a private application repository pinned to one branch and
  commit for the whole run, so the same tree served both arms. Three
  pre-existing untracked Markdown files were present and left untouched.

## Recall And Answer Signals

- Astra did AMP navigation in all enabled runs but cited none of the four
  relevant memories. It correctly returned `none` for the payment control.
- Sol cited the expected email memory `#368` once and the spec intent `#355`
  once. It missed the image memory `#373` and did not reproduce the email hit
  on the repeated email case. It correctly returned `none` for the control.
- Deterministic answer-signal coverage was 21/21 AMP-on versus 21/21 AMP-off
  for Astra, and 21/22 versus 22/22 for Sol. This is a keyword coverage check,
  not independent grading of correctness or usefulness.

The main measured cost is Codex L1's manual recall path: checking the disable
flag, loading the full AMP skill, reading the index and Region, then fetching
or searching for an issue before inspecting the project. Astra often stopped
at navigation and did not read the issue body, so it paid recall overhead
without a memory hit. Sol fetched useful issue bodies in two runs, but the
extra work still exceeded any saved repository exploration.

## Limitations

- Five pairs per model is exploratory rather than a stable performance study.
- Task allocation is not perfectly balanced within each model because five
  pairs cover four tasks.
- The schedule is counterbalanced but not randomized.
- A Codex account usage cap interrupted the run after case 12. Cases 13–20
  resumed after the stated reset time; all final cases succeeded.
- Wall time can be affected by service load. No concurrency was used.
- The target worktree was dirty before the benchmark, although benchmark
  sessions were read-only and the same snapshot served both arms.
- No independent blind answer-quality review was performed.

## Reproduction

From `tokenMonitor/`, after syncing the configured AMP cache:

```bash
npm run benchmark:codex -- --cases 20 \
  --models gpt-6-astra,gpt-5.6-sol \
  --reasoning medium \
  --project /path/to/target-project \
  --memory-repo /path/to/AgentMemory
```

Raw JSONL, answers, stderr, `summary.json`, and the generated `report.md` stay
under the gitignored `tokenMonitor/data/codex-amp-ab/` output directory.
