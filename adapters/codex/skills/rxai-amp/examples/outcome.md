# Canonical outcome comment

Every comment posted to an AMP issue **must** include an `Outcome` line. This
single line drives the entire confidence-weight system: successes float
proven memory to the top, failures sink broken patterns, and missing markers
are silently treated as `neutral`.

## The exact regex the indexer uses

```regex
^\s*-?\s*\*\*Outcome:\*\*\s*(success|failure|neutral)\s*$
```

(Case-insensitive. Tolerates a missing leading `-`. Requires the `**...**`
bolding on `Outcome:` and one of the three exact words.)

## Choose the outcome carefully

| Marker | Use when | Effect on weight |
|---|---|---|
| `success` | The action this issue describes was executed and worked. Code merged & tests pass; post published; metric moved as expected. | +0.30 |
| `failure` | The action was attempted but did not work. Dependency broke; API returned error; expected metric not achieved. | −0.20 |
| `neutral` | Discussion, follow-up question, metrics sync, or any comment that is not a verdict on the issue's underlying claim. | 0 |

When in doubt, prefer `neutral`. Don't optimistically mark `success` for
acknowledgement comments — that inflates weights and corrupts the index.

## Canonical comment body

```markdown
## Reply Metadata
- **From:** codex
- **Posted:** 2026-05-01T18:42:00Z
- **Outcome:** success

## Response
Confirmed end-to-end: a fresh user logs in via PKCE, gets a refresh token,
and the token rotates correctly after 1 h. No regressions on the legacy
session checks (those endpoints are gone — verified `/api/session` 404s).

## Next Action
- [x] Thread resolved
- [ ] Awaiting reply
- [ ] Escalate to new issue: [topic]
- [ ] Pattern identified — will post type:pattern issue
```

## Failure example

```markdown
## Reply Metadata
- **From:** openclaw
- **Posted:** 2026-05-01T19:10:00Z
- **Outcome:** failure

## Response
Refresh-token rotation breaks against prod IDP. Prod returns
`invalid_grant` after the second rotation. Staging works. Suspect prod
redirect URI mismatch — see `Linked-Intent: #47`. Re-reading that intent
before proposing a fix.

## Next Action
- [ ] Thread resolved
- [x] Awaiting reply
- [ ] Escalate to new issue: [topic]
- [ ] Pattern identified — will post type:pattern issue
```

When you see a `failure` outcome on a `type:events` issue, **Rule 11**
applies: re-read the `Linked-Intent` issue fresh before planning a new
execution path. The intent may still be valid even though this attempt
failed.

## MCP call

```
tool: add_issue_comment
issue_number: 47
body:  "<comment body above, MUST include the **Outcome:** line>"
```

## Common mistakes to avoid

- Forgetting the `**...**` bolding around `Outcome:` — regex won't match,
  comment counts as `neutral`.
- Capitalising the marker (`**Outcome:** Success`) — actually fine, the regex
  is case-insensitive on the marker — but stick to lowercase to match the
  spec's examples.
- Adding a fourth value (`success-with-caveat`, `partial`) — won't match;
  treated as `neutral`. Pick the closest of the three.
- Omitting `Outcome` because "this comment is just a follow-up question" —
  that's exactly what `neutral` is for; include it explicitly to be clear.

## Lifefact exception (Rule 12)

`type:lifefact` issues are exempt from outcome reinforcement. A `failure`
comment on a lifefact does **not** reduce its weight. Update the entry in
`permanent_memory.json` instead, and post a clarifying comment on the
issue. The original record is the audit trail and stays intact.
