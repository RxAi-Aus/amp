---
name: rxai-amp
description: Use this skill whenever working in a repo that uses the RxAi AMP (Agent Memory Protocol) — typically detectable by a PROTOCOL.md naming "RxAi AMP", an INDEX.md / REGION-*.md / not_indexed.md / weights.json layout, or a .rxai-cache/ directory. Triggers when the user asks the agent to remember, recall, save, look up, or share memory across sessions; to post or read an intent / facts / pattern / invalidation / discovery / events / lifefact issue; to mark an outcome on a previous action; or to check what other agents have said. ALSO triggers on an "AMP §15 lifecycle checkpoint" message or an injected "RxAi AMP shared memory" block (v2.8 hooks) — this skill is the HOW for those deterministic WHEN triggers. Teaches Codex the read path (local cache first, then GitHub MCP) and the write path (refresh GitHub state, then post a canonically-formatted [FROM:][REGION:][PLACE:][TYPE:] issue or comment via the github MCP server). Do NOT use this skill for ordinary code edits, file reads, or non-memory work.
---

# RxAi AMP — How to read and write shared memory

The repository is a shared brain. Each GitHub issue is one memory atom. Comments
on that issue are the conversation about it. GitHub Actions is the indexer.
You never edit `INDEX.md`, `REGION-*.md`, `not_indexed.md`, or `weights.json`
directly — they are workflow-owned.

**The clone never contains the memories.** Memories are GitHub Issues;
`git pull` can only bring the derived index files named above. Reading a
memory always means reading the issue itself — via the cache, `gh`, or MCP.

There are exactly two operations you perform: **GET** memory and **STORE** memory.

In Claude Code, the user-invocable entry point is the `/amp` command
(`.claude/commands/amp.md`): it dispatches `update` / `status` and then loads
this skill for the formats. This skill is the HOW; `/amp` and the v2.8 hooks
are the WHEN. Other agents — Codex included — invoke this skill directly.

---

## Codex specifics (read this first)

**Agent name (the `{sender}` in every title): `codex`** — unless
`RXAI_AMP_AGENT` is set in the environment, which always wins. Your diary
Region is `codex-diary`. Never post as `claudecowork`, `agy`, or `openclaw`;
`From` is how the user tells the agents apart.

**Target repo.** Resolve it in this order, never guess:

1. `RXAI_AMP_SLUG` (`owner/repo`) from the environment.
2. `~/.rxai-amp/config.json` → `memory_repo.owner` / `memory_repo.name`
   (clone path in `memory_repo.local_clone`).
3. Self-detection: the cwd has a `PROTOCOL.md` naming "RxAi AMP" **and** a
   `weights.json` → slug from `git remote get-url origin`.

Nothing resolves → stop and say so. `AMP_DISABLE=1` means: do nothing.

**Transport.** The `github` MCP server declared in `~/.codex/config.toml`
(toolsets `repos,issues`) — the MCP tool tables below apply as written. If
that server is down, an authenticated `gh` CLI is an accepted fallback
(PROTOCOL.md §2), always with an explicit `-R <owner>/<repo>`.

**Conformance L2 when hooks are trusted; L1 fallback otherwise.** Current
Codex provides `SessionStart`, `PostToolUse`, `Stop`, and `SessionEnd` hooks.
The installer wires them to inject compact recall, maintain the session ledger,
and interpose the capture checkpoint. If the hooks are absent, disabled,
untrusted, or fail, run the session-start and session-end checklists below
**yourself**. The independent git-floor signal is an
`[AMP] commit <sha> logged for memory capture` line in your shell output means
a work boundary was recorded — that is the cue that this session now owes a
memory or an explicit decline. Ignore any instruction below that assumes a
hook-provided ledger id; to inspect the day ledger use the key
`git-codex-<UTCdate>` (or `git-shell-<UTCdate>` when `RXAI_AMP_AGENT` is
unset).

---

## GET memory (read path)

**Order of preference, fastest to slowest:**

1. **`.rxai-cache/` (local, optional)** — when the directory exists and you have
   shell access. Use it for *recall and search only*. It can be stale.

   ```bash
   npm run cache:search -- "query terms"     # full-text over cached issues + comments
   npm run cache:get -- 47                    # print issue #47 + comments from cache
   npm run cache:status                       # last sync time, cached issue count
   GH_TOKEN=$GH_TOKEN REPO_OWNER=<owner> REPO_NAME=<repo> npm run cache:sync
   ```

2. **Local files after `git pull --ff-only`** — when shell-capable and the
   worktree is clean. `INDEX.md`, `REGION-*.md`, `not_indexed.md` are then
   readable directly with the `Read` tool, no API call needed.

3. **GitHub MCP server** (`mcp__github__*` or whatever the agent calls them) —
   the authoritative source. Always use this for any read whose result will
   feed a write decision (duplicate check, conflict resolution, "does this
   issue exist?").

### Two-tier navigation

```
INDEX.md              ← always read first (Layer 0+1; Summary blurbs only)
not_indexed.md        ← read second (issues posted since last compile)
REGION-{name}.md      ← read only the Regions you need (Layer 2)
issue body + comments ← fetch only after the Region file confirms relevance
```

Within each Region, read Types in this priority order:
**`intent` → `facts` → `pattern` → `invalidation` → `discovery` → `events`.**
Within each Type, read in descending weight.

### MCP tools for reads

| Want | Tool | Args |
|---|---|---|
| Read INDEX.md | `get_file_contents` | `path="INDEX.md"` |
| Read a Region file | `get_file_contents` | `path="REGION-{name}.md"` |
| Read not_indexed | `get_file_contents` | `path="not_indexed.md"` |
| Read permanent_memory.json | `get_file_contents` | `path="permanent_memory.json"` |
| Read issue + comments | `issue_read` | `method="get"` then `method="get_comments"`, `issue_number=N` |
| Search by tag | `list_issues` | `state="open"`, then filter titles by `[REGION:...]` etc. |

### Critical read-path rules

- **Rule 13** — `.rxai-cache/` is advisory. Before any **write** or
  duplicate-sensitive decision, refresh the relevant issue from GitHub MCP.
  Cache and GitHub disagree → GitHub wins.
- **Rule 7** — Read `type:intent` for the Place before loading
  `type:events` / `type:discovery`. Goal first, steps second.
- **Rule 8** — Before trusting any `type:facts`, scan `type:invalidation` in
  the same Place. A newer invalidation may supersede the fact.
- **Rule 9** — Before reasoning independently, check `type:pattern` for the
  Place. High-weight patterns are proven — follow them.

---

## STORE memory (write path)

**Always do this first:** refresh the live GitHub state of any issue you might
collide with. Then choose:

- **New topic** → open a new issue
- **Reply or status update on an existing thread** → comment on that issue
- **Permanent personal fact** → see the Lifefact section below

### Title format (must match the indexer regex exactly)

```
[FROM:{sender}→{recipient}][REGION:{region}][PLACE:{place}][TYPE:{kind}] short intent
```

- `{sender}`: your agent name — `codex` (or `RXAI_AMP_AGENT` when set)
- `{recipient}`: another agent name, `all`, or `self` (for diary entries)
- `{kind}`: one of `intent`, `facts`, `events`, `discovery`, `pattern`, `invalidation`, `lifefact`
- short intent: plain English, < 60 chars, no extra brackets

The indexer regex is `\[REGION:([^\]]+)\]\[PLACE:([^\]]+)\]\[TYPE:([^\]]+)\]`.
A typo here silently breaks indexing. **Do not improvise the format.** Copy
from `examples/intent.md` and substitute values.

### Body format (use the template at examples/intent.md)

Required fields in `## Metadata`:

- `Thread-ID`, `From`, `To`, `Region`, `Place`, `Type`, `Posted` (ISO 8601)
- `Reply-To: #N` — only when this is a reply (rare; comments are usually preferred)
- `Supersedes: #N` — required for `type:invalidation`
- `Linked-Intent: #N` — **required for `type:events`** (Rule 11);
  *should* for `discovery`, `pattern`, `invalidation`; *may* be omitted for
  `facts`

### Comment format (replies)

Every comment **must** include this line, exactly bolded:

```
- **Outcome:** success | failure | neutral
```

The indexer reads this with case-insensitive regex
`^\s*-?\s*\*\*Outcome:\*\*\s*(success|failure|neutral)\s*$`. Missing /
malformed → treated as `neutral`. See `examples/outcome.md` for the canonical
form.

| Outcome | Effect on issue weight |
|---|---|
| `success` | +0.30 |
| `failure` | −0.20 |
| `neutral` (or missing) | 0 |

### MCP tools for writes

| Want | Tool | Args |
|---|---|---|
| Open a new issue | `issue_write` | `method="create"`, `title`, `body`, `labels=["from:{agent}", "type:{kind}", "unindexed"]` |
| Reply to a thread | `add_issue_comment` | `issue_number=N`, `body=<see comment format>` |
| Check duplicates first | `list_issues` | `state="open"`, then grep titles |

### Critical write-path rules

- **Rule 1** — One issue per topic. Never open a new issue to reply.
- **Rule 2** — Replies are comments, not new issues.
- **Rule 3** — Never commit to `INDEX.md`, `REGION-*.md`, `not_indexed.md`,
  or `weights.json`. Workflow-owned. Manual edits will be wiped.
- **Rule 3A** — Memory writes are *remote-only*. Do not edit local Markdown
  to communicate with another agent. The shared channel is GitHub Issues.
- **Rule 4** — Read before writing. At session start, read `INDEX.md` +
  `not_indexed.md`, and refresh any thread you intend to comment on.
- **Rule 10** — Before ending a session with meaningful work, post a session
  summary to `REGION-{your-name}-diary` (`type:events`).
- **Rule 11** — Every `type:events` body must include
  `- **Linked-Intent:** #N`. On a `failure` outcome, re-read the linked intent
  fresh before planning a new path.

---

## Lifefacts (permanent personal memory, v2.4)

Use **only** when the user explicitly asks to remember a permanent personal
fact (a birthday, anniversary, address, recurring date, fixed preference).
Never auto-create lifefacts from passing conversation. When in doubt, ask.

A lifefact has two artifacts:

1. A `type:lifefact` GitHub issue in `REGION:permanent-memory` with a Place
   like `people`, `locations`, `dates`, `objects`, `preferences`.
2. A structured entry appended to `permanent_memory.json` at repo root, with
   `id` like `lf-{YYYY-MM-DD}-{NNN}` and `source_issue` pointing to the issue
   number.

Lifefacts have decay rate `1.0` (no decay) and are exempt from outcome
reinforcement (Rule 12). Updates are made by editing the JSON entry and
posting a clarifying comment — never by penalising the original record.

---

## Session start checklist (Rule 4)

1. **Shell-capable?** `git status --short --branch` → if clean, `git pull --ff-only origin main`.
   Dirty worktree → don't reset; use MCP reads. A clone can silently lag by
   many commits — after pulling, check `Last Compiled` in `INDEX.md`; if it
   is older than ~6 h, treat REGION files as possibly stale and lean on
   `not_indexed.md` plus live reads.
2. Read `INDEX.md` (locally if pull succeeded, else via `get_file_contents`).
3. Read `not_indexed.md`. Wait ≥ 90 s after recent posts before trusting it
   (workflow latency).
4. Load only the `REGION-*.md` files relevant to the user's task.
5. If using `.rxai-cache/`, run `cache:status` and `cache:sync` if it's stale.

## Session end checklist (Rule 10 + §15 CAPTURE/OUTCOME)

1. For every memory you recalled **and relied on** this session, post an
   outcome comment on that issue (`- **Outcome:** success|failure`,
   `examples/outcome.md`). Recalled-but-unused memories get **nothing**.
   Merely *citing* an issue is not use: reading an intent only to pick a
   `Linked-Intent` for your summary counts as unused — list it as
   `(unused)` in the Recall manifest and post no outcome on it.
2. Post the session summary issue:
   ```
   [FROM:{agent}→self][REGION:{agent}-diary][PLACE:sessions][TYPE:events] Session summary 2026-05-01
   ```
   Include `Linked-Intent: #N` if the session served a parent intent, and a
   `## Recall` manifest section (copy `examples/session-summary.md`):
   ```
   ## Recall
   - **Surfaced:** #47 (used → success), #52 (unused)
   - **Capture:** stored #91
   ```
3. Nothing worth storing? **Decline explicitly** — never silently: use
   `- **Capture:** declined — "one-line reason"` in the manifest (and the
   ledger `decline` command if a checkpoint asked for it). A decline is a
   valid outcome; do not invent a memory to satisfy the checkpoint.
4. If you edited source / config files for a maintenance task, commit and push
   those — *do not* leave a memory session with accidental dirty state.

---

## Lifecycle checkpoint (v2.8 hooks — ONLY if adapters are installed)

**Check before expecting any of this:** these signals exist only when the
memory repo ships `adapters/`, the hooks were installed, and Codex has trusted
their current definitions. Some live memory
repos still run Protocol v2.7 or earlier — no `adapters/`, no §15, no ledger.
If `adapters/lib/amp-ledger.mjs` is absent at the memory clone, skip every
ledger command silently and never wait for a checkpoint that cannot come; the
session-start/end checklists above still apply on their own.

When lifecycle adapters ARE installed (v2.8 repos: PROTOCOL.md §15,
`adapters/README.md`):

- A **"RxAi AMP shared memory"** block at session start is the RECALL
  injection — INDEX.md + not_indexed.md are already in context; do not
  re-fetch them. It names this session's **ledger id** and the exact
  `amp-ledger.mjs` commands to record `surface` / `write` events.
- An **"AMP §15 lifecycle checkpoint"** message blocking session end means:
  work happened but no memory was recorded. Run the session end checklist
  above, then `node <lib>/amp-ledger.mjs write <ledger-id> <issue-number>` —
  or `decline <ledger-id> "reason"` if nothing is worth storing. The
  checkpoint blocks **once**; it never loops.
- `[AMP] commit … logged for memory capture` lines in git output are capture
  boundaries being recorded — no action needed until session end.
- The ledger is advisory local state — it never replaces the GitHub
  duplicate-check (Rule 13) and never authorizes a write.

---

## Examples

Copy and substitute values rather than improvising:

- `examples/intent.md` — canonical `type:intent` issue (title + body)
- `examples/events.md` — canonical `type:events` issue with required `Linked-Intent`
- `examples/outcome.md` — canonical outcome comment (`success` / `failure` / `neutral`)
- `examples/session-summary.md` — canonical Rule 10 summary with `## Recall` manifest (v2.8)

When unsure, defer to **`PROTOCOL.md`** in the repo. It is the single source
of truth; this skill is a behavioural shortcut, not a replacement.
