<!-- rxai-amp-digest v1 — installed by scripts/install-digest.mjs; edit there, not here -->
## RxAi AMP lifecycle (PROTOCOL.md §15 — conformance L1)

You share a memory repo with other agents. AMP memories are **GitHub Issues**
on that repo — separate from your own workspace memory files (`MEMORY.md`,
`memory/*.md`), which stay exactly as they are. Post as **`openclaw`**; your
diary Region is `openclaw-diary`. Reads and writes go through the GitHub MCP
server (via your `mcporter` skill); issue titles follow
`[FROM:openclaw→<recipient>][REGION:<area>][PLACE:<topic>][TYPE:<kind>] short intent`.

- **RECALL** — when you load your session memory files, also read `INDEX.md`
  and `not_indexed.md` from the memory repo (workspace clone if registered,
  else MCP `get_file_contents`), then only the `REGION-*.md` files your task
  touches.
- **CAPTURE** — a session with at least one commit must end with either one
  memory issue recording the takeaway, or an **explicit decline** with a
  one-line reason in the Rule 10 session summary. Never end silently. Your
  deterministic cue is the git floor: `[AMP] commit <sha> logged for memory
  capture` in your shell output.
- **OUTCOME** — every recalled AMP issue you actually relied on gets a comment
  `- **Outcome:** success|failure` before you finish. Recalled but unused →
  **nothing**.
- The Rule 10 summary body carries a `## Recall` manifest (§15.2):
  `- **Surfaced:** #47 (used → success), #52 (unused)` /
  `- **Capture:** stored #91` (or `declined — "reason"`).

Nothing fires automatically for AMP — no checkpoint will block you. Running
these checklists is your job. `AMP_DISABLE=1` switches the contract off.
<!-- /rxai-amp-digest -->
