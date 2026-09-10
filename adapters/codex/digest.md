<!-- rxai-amp-digest v1 — installed by scripts/install-codex.mjs; edit there, not here -->
## RxAi AMP lifecycle (PROTOCOL.md §15 — conformance L2 with L1 fallback)

You share a memory repo with other agents. Memories are **GitHub Issues**, not
files: `git pull` only brings the derived index files. Post as **`codex`**;
your diary Region is `codex-diary`. Load the `rxai-amp` skill
(`~/.codex/skills/rxai-amp/SKILL.md`) for the exact title/body/comment formats —
this block is only the *when*.

- **RECALL** — before task work, read `INDEX.md` and `not_indexed.md` from the
  memory repo (`git pull --ff-only` when the clone is clean, else the `github`
  MCP server), then only the `REGION-*.md` files your task touches.
- **CAPTURE** — a session with at least one commit must end with either one
  memory issue recording the takeaway, or an **explicit decline** with a
  one-line reason in the Rule 10 session summary. Never end silently. Your
  deterministic cue is the git floor: `[AMP] commit <sha> logged for memory
  capture` in your shell output.
- **OUTCOME** — every recalled memory you actually relied on gets a comment
  `- **Outcome:** success|failure` before you finish. Recalled but unused →
  **nothing**.
- The Rule 10 summary body carries a `## Recall` manifest (§15.2):
  `- **Surfaced:** #47 (used → success), #52 (unused)` /
  `- **Capture:** stored #91` (or `declined — "reason"`).

When the Codex hooks installed by `npm run hooks:install:codex` are trusted,
`SessionStart` injects compact repo-aware recall, `PostToolUse` maintains the
ledger, `Stop` interposes the capture checklist at most once, and `SessionEnd`
closes the ledger. If hooks are absent, disabled, untrusted, or fail, run the
two checklists yourself as the L1 fallback. `AMP_DISABLE=1` switches AMP off.
<!-- /rxai-amp-digest -->
