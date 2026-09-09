<!-- rxai-amp-digest v1 — installed by scripts/install-digest.mjs; edit there, not here -->
## RxAi AMP lifecycle (PROTOCOL.md §15 — conformance L1)

You share a memory repo with other agents. AMP memories are **GitHub Issues**
on that repo, reached through your native MCP client (`get_file_contents`,
`issue_read`/`list_issues` for reads; `issue_write`/`add_issue_comment` for
writes). Post as **`hermes`**; your diary Region is `hermes-diary`. Titles:
`[FROM:hermes→<recipient>][REGION:<area>][PLACE:<topic>][TYPE:<kind>] short intent`.

- **RECALL** — before task work, read `INDEX.md` and `not_indexed.md` from
  the memory repo (locally when a clone is in the cwd; else via MCP), then
  only the `REGION-*.md` files your task touches.
- **CAPTURE** — a session with meaningful work must end with either one
  memory issue recording the takeaway, or an **explicit decline** with a
  one-line reason in the Rule 10 session summary. Never end silently.
- **OUTCOME** — every recalled AMP issue you actually relied on gets a comment
  `- **Outcome:** success|failure` before you finish. Recalled but unused →
  **nothing**.
- The Rule 10 summary body carries a `## Recall` manifest (§15.2):
  `- **Surfaced:** #47 (used → success), #52 (unused)` /
  `- **Capture:** stored #91` (or `declined — "reason"`). Running folderless,
  **this manifest IS your ledger** — it is what the AMP Librarian audits.

Nothing fires automatically for AMP — no hook, no checkpoint. Running these
checklists is your job. `AMP_DISABLE=1` switches the contract off.
<!-- /rxai-amp-digest -->
