# Agent Loop Guard

## Purpose

Agent Loop Guard is the AMP control layer that prevents remote agents from
reading and responding to each other forever. Proposed in v2.6, it is
normative since v2.9 as **PROTOCOL.md Rule 14**; this document is the design
rationale, and Rule 14 is the specification that binds.

The guard protects workflows that run an LLM agent through GitHub Actions:
today `.github/workflows/amp-librarian.yml` (daily Copilot CLI audit, also
triggerable by `repository_dispatch`), and any future worker driven by
Telegram or issue comments. The AMP index workflows do not need the guard
because they do not invoke an LLM and do not post agent conversation replies.

## Problem

Once AMP has remote agents that can react to GitHub issue comments, several
loop patterns become possible:

| Loop | Description | Risk |
|------|-------------|------|
| Self-reply loop | An agent posts a comment, then the same workflow treats that comment as a new request. | Wastes Actions minutes and premium requests. |
| Agent ping-pong | Agent A replies to Agent B, then Agent B replies to Agent A, repeatedly. | Creates noisy memory and hides the human request. |
| Retry spiral | A failed run posts a failure comment that triggers another failed run. | Burns compute while reinforcing a bad path. |
| Attention loop | Agents keep re-reading and re-summarising the same thread because it remains high weight. | Pollutes retrieval order and context. |
| Status loop | A progress/status update is interpreted as a fresh user instruction. | Produces useless replies. |

## Design Principle

Loop prevention should be deterministic first and LLM-assisted second.

The workflow should run this order:

```text
incoming event
  -> deterministic loop guard
  -> optional Copilot CLI semantic classifier
  -> agent execution
  -> result comment with loop metadata
```

The deterministic guard must be able to stop obvious loops without calling an
LLM. Copilot CLI can help only when the event is semantically ambiguous, for
example deciding whether a Telegram message is a real new request or only an
acknowledgement.

## Required Comment Metadata

Every automatic agent reply MUST include a hidden AMP metadata block
(normative form and field semantics: PROTOCOL.md Rule 14 — human-driven
session writes are exempt under the §2 write-path rule):

```markdown
<!-- amp-agent
agent: copilot
run_id: 123456789
trigger_comment_id: 98765
responds_to_comment_id: 98765
hop: 1
max_hops: 2
idempotency_key: issue-12:comment-98765:copilot
requires_response: false
-->
```

Field meanings:

| Field | Meaning |
|-------|---------|
| `agent` | Agent identity that wrote the comment. |
| `run_id` | Workflow run id or other execution id. |
| `trigger_comment_id` | Comment id that caused this run. |
| `responds_to_comment_id` | Comment id this reply addresses. |
| `hop` | Automatic reply depth. Humans and Telegram users start at `0`; every automatic reply increments it. |
| `max_hops` | Maximum automatic reply depth before holding for a human. |
| `idempotency_key` | Stable key for one agent response to one trigger. |
| `requires_response` | `false` means other agents must not treat this comment as a fresh request. |

The block is hidden from normal GitHub rendering but remains visible to tools.

## Deterministic Guard Rules

The guard returns one of three decisions:

| Decision | Meaning |
|----------|---------|
| `allow` | Safe to run the agent. |
| `skip` | Do not run; this event is already handled or not addressed to this agent. |
| `hold` | Do not run automatically; a human or external controller should decide. |

Rules, in the evaluation order fixed by Rule 14 and implemented by
`agent_loop_guard.ts` (check id in brackets — the cheapest and most explicit
human signals are evaluated first, so an operator can always stop a runaway
agent with a label):

1. **Respect control labels** [`control-label`]. `agent:hold`, `agent:busy`, or `agent:needs-human` on the issue → hold.
2. **Status updates are not tasks** [`status-update`]. An event marked `StatusUpdate` must not call the LLM → skip.
3. **Honor AMP addressing** [`addressing`]. An issue title addressed to another specific agent → skip.
4. **Idempotency wins** [`idempotency`]. The trigger's `idempotency_key` already appears in a thread metadata block → skip.
5. **Respect `requires_response: false`** [`requires-response`]. Agent status comments are not new tasks → skip.
6. **Never respond to yourself** [`self-reply`]. The trigger comment was written by this same agent → skip.
7. **Cap automatic hops** [`hop-cap`]. `hop >= max_hops` (default 2) → hold for human review.
8. **Require new human input** [`new-human-input`]. No human or external-channel comment since this agent's last reply → skip.
9. **Stop agent streaks** [`agent-streak`]. The latest N comments are all agent/bot comments (default N=3) → hold.
10. **Avoid retry spirals** [`failure-spiral`]. Repeated recent agent `Outcome: failure` comments (default 2 of the last 6) → hold.

## Copilot CLI Role

Copilot CLI is useful after the deterministic guard passes but the intent is
unclear. It can classify the event into structured JSON:

```json
{
  "should_respond": false,
  "loop_risk": "high",
  "reason": "The latest comment is an agent status update, not a user request.",
  "recommended_action": "hold_for_human"
}
```

The workflow should treat this as advisory. It must still enforce hard limits
such as hop count, idempotency, and control labels.

## AMP Scoring Integration

Loop risk should not replace memory weight. It should become a separate
attention-control signal.

Suggested future state:

```json
{
  "weight": 0.82,
  "loop_risk": 0.7,
  "agent_chain_length": 4,
  "last_human_comment": "2026-05-09T00:00:00Z",
  "attention_status": "hold_for_human"
}
```

This keeps historically useful memory visible while preventing noisy automated
threads from dominating the active reading order.

## Workflow Placement

The first AMP workflow implementation is `.github/workflows/amp-librarian.yml`.
It calls the guard before invoking the model:

```text
Checkout branch
Fetch issue/comments
Build guard input JSON
Run agent_loop_guard.ts (repo root)
If allow: run Copilot CLI
If skip/hold: write status and exit without calling Copilot
```

Since v2.9 the guard lives at the repo root as `agent_loop_guard.ts`
(compiled to `dist/agent_loop_guard.js`, runnable via `npm run loop:guard`),
and PROTOCOL.md Rule 14 is its normative specification. This document remains
the design rationale.

## Adoption Plan (completed in v2.9)

1. ~~Add this design document and starter guard utility.~~ Done (v2.6).
2. ~~Fill in `Rule 14 - Agent Loop Guard` in `PROTOCOL.md`.~~ Done — Rule 14
   is normative since v2.9 (metadata block, decisions, ten checks).
3. ~~Add a workflow-only JSON adapter that gathers issue title, labels,
   comments, trigger comment id, and event type.~~ Done — see the
   "Build guard input" step in `.github/workflows/amp-librarian.yml`.
4. ~~Run the guard before any Copilot CLI call.~~ Done — `amp-librarian.yml`
   exits without calling Copilot unless the guard returns `allow`.
5. Partially done — the Librarian's Copilot audit already reports `loop_risk`
   in its JSON output (advisory, and only after the guard returns `allow`). A
   per-event semantic classifier that feeds its verdict back into the decision
   (tightening only, never loosening) remains future work.

## Non-Goals

- Do not replace the AMP confidence score with LLM judgement.
- Do not let Copilot directly edit `INDEX.md`, `REGION-*.md`,
  `not_indexed.md`, or `weights.json`.
- Do not make GitHub issue comments less authoritative. The guard controls
  execution; it does not rewrite memory.
- Do not require every local CLI agent to use GitHub Actions. This guard is
  mainly for event-driven remote agents.
