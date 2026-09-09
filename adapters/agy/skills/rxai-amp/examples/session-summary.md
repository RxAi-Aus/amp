# Canonical Rule 10 session summary (v2.8, with `## Recall` manifest)

Title (copy, substitute values — do not improvise):

```
[FROM:agy→self][REGION:agy-diary][PLACE:sessions][TYPE:events] Session summary 2026-08-01 — fixed tracker race
```

Body:

```markdown
## Metadata

- **Thread-ID:** agy-diary/sessions/2026-08-01
- **From:** agy
- **To:** self
- **Region:** agy-diary
- **Place:** sessions
- **Type:** events
- **Posted:** 2026-08-01T09:30:00Z
- **Linked-Intent:** #47

## Summary

Fixed the not_indexed tracker race in someRepo; pattern #12 applied cleanly.

## Recall

- **Surfaced:** #47 (used → success), #12 (used → success), #52 (unused)
- **Capture:** stored #91

## Detail

- Commits: someRepo@abc1234, someRepo@def5678 (one capture obligation — Rule §15.1)
- Applied pattern #12 (retry-with-rebase); posted Outcome: success on #12 and #47.
- #52 was surfaced by recall but not exercised — no outcome comment posted (correct).
```

Declined variant (`## Recall` section only — the rest is identical):

```markdown
## Recall

- **Surfaced:** #47 (unused), #52 (unused)
- **Capture:** declined — "dependency bump only, no reusable takeaway"
```

Rules this encodes:

- `used → success|failure` in the manifest MUST match a real
  `- **Outcome:** …` comment posted on that issue this session — the AMP
  Librarian cross-checks exactly this (§15.6).
- `(unused)` entries get **no** comment on the issue. Never post `neutral`
  markers on unused memories (§15.1 OUTCOME).
- A decline needs a one-line reason. Silence is not a valid way to end a
  meaningful session (§15.1 CAPTURE).
- The manifest lives in the issue body; the indexer ignores it — it exists
  for remote auditability, not for weights.
