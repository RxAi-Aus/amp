<!-- rxai-amp-digest v1 — installed by scripts/install-codex.mjs; edit there, not here -->
## RxAi AMP lifecycle (PROTOCOL.md §15 — conformance L2)

You share a memory repo with other agents. Memories are **GitHub Issues**, not
files: `git pull` only brings the derived index files. Post as **`codex`**;
your diary Region is `codex-diary`. Load the `rxai-amp` skill
(`~/.codex/skills/rxai-amp/SKILL.md`) for the exact title/body/comment formats —
this block is only the *when*.

- **RECALL** — the trusted `SessionStart` hook puts `INDEX.md`/`not_indexed.md`
  navigation and the repo's matching records in your context before your first
  action. No block means the hooks are absent or untrusted: say so once
  (`/hooks`, or `npm run hooks:install:codex`) and proceed without recall — do
  not read the index or Region files by hand (measured on four Codex models:
  +39–80% input for 0–2 hits in 4).
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
closes the ledger. Without them, CAPTURE and OUTCOME still bind through the
git floor and this digest; recall never falls back to manual navigation
(v2.12). `AMP_DISABLE=1` in the environment makes every hook a no-op — you
never check for it.
<!-- /rxai-amp-digest -->
