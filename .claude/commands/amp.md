---
description: RxAi AMP — store a memory to the connected GitHub memory repo (/amp update <what to store>)
argument-hint: update [what to store] | status
---

# /amp — RxAi AMP memory command

User arguments: `$ARGUMENTS`

Dispatch on the first word of the arguments:

- `update <text>` → STORE the described memory on the connected AMP GitHub repo (steps below).
- `update` (no text) → summarize the meaningful work done so far in this session and STORE that.
- `recall <topic>` (alias `get`) → GET memories about the topic — see "The recall path" below.
- `recall` (no topic) → GET the index overview: regions, freshness, and anything new in `not_indexed.md`.
- `status` → run steps 1–2 only, then report the resolved target repo, agent name, and the 5 most recently opened issues. Stop.
- anything else, or empty → print the Usage block at the bottom and stop.

Remember throughout: **memories are GitHub Issues, not files.** `git pull` on the memory clone only brings the derived index files (`INDEX.md`, `REGION-*.md`, `not_indexed.md`, `weights.json`) — reading a memory always means reading the issue itself (cache, `gh`, or MCP).

Before storing, load the `rxai-amp` skill (Skill tool) — it defines the canonical title/body/comment formats and rules. This command is the WHEN/dispatch; that skill is the HOW. PROTOCOL.md is the source of truth if anything disagrees.

## 1. Resolve the target repo and agent name

If `AMP_DISABLE=1` is set, say so and stop. Otherwise resolve with the same precedence as `adapters/lib/amp-config.mjs`. When that file exists in the cwd, just run it:

```bash
node --input-type=module -e 'const m = await import(process.cwd()+"/adapters/lib/amp-config.mjs"); console.log(JSON.stringify(m.resolveConfig()))'
```

Manual fallback (same precedence; also use this when the adapters lib is not in the cwd — e.g. this command was installed user-level):
1. `RXAI_AMP_SLUG` env var (`owner/repo`); agent from `RXAI_AMP_AGENT`.
2. `~/.rxai-amp/config.json` → `memory_repo.owner`/`memory_repo.name` (clone at `memory_repo.local_clone`), agent from `agent_name_default`.
3. Self-detection: cwd has a `PROTOCOL.md` naming "RxAi AMP" **and** `weights.json` → slug from `git remote get-url origin`.

Note the config file outranks self-detection (by design — one shared brain): to post to the memory repo you are standing in rather than the configured one, pass `RXAI_AMP_SLUG` explicitly.

Agent name defaults to `claudecowork`. If no repo resolves, stop and tell the user to set `RXAI_AMP_SLUG` or create `~/.rxai-amp/config.json` — never guess a repo.

## The recall path (`/amp recall <topic>`)

1. Resolve the repo and agent exactly as in step 1 below.
2. Freshness: if the resolved `local_clone` exists and its worktree is clean, `git -C <clone> pull --ff-only` first. Then check the `Last Compiled` timestamp in `INDEX.md` — if it is older than ~6 h, say so and lean on `not_indexed.md` plus live reads rather than trusting REGION files alone. No clone → read the same files via `gh api -H "Accept: application/vnd.github.raw" repos/<slug>/contents/<file>`.
3. Read `INDEX.md`, then `not_indexed.md`, then only the `REGION-*.md` files whose region plausibly matches the topic. Within a region follow the type order `intent → facts → pattern → invalidation → discovery → events`, descending weight — the useful entries are sorted to the top.
4. If `.rxai-cache/` exists in the clone, also run `npm run cache:search -- "<topic>"` there for full-text candidates (advisory only — Rule 13).
5. Fetch only the issues the index confirms relevant: `gh issue view <N> --comments --repo "$SLUG"`. Before trusting a `facts`, scan the same Place for a newer `invalidation` (Rule 8).
6. Report what was found — issue numbers, weights, and any invalidation that applies — and keep note of which ones the session goes on to actually use, so outcomes can be marked at the end.

## 2. Refresh live GitHub state (Rules 4 & 13 — mandatory before any write)

The local `.rxai-cache/` and index files are advisory only. Check live state for an existing thread on the same topic:

```bash
gh issue list --repo "$SLUG" --state open --limit 100 --json number,title
```

If `gh` is missing or unauthenticated, use the GitHub MCP tools exactly as the `rxai-amp` skill describes; if neither is available, stop and say so.

## 3. Decide the write shape

- **Existing open thread on this exact topic** → comment on it (Rule 2 — never open a duplicate issue). The comment MUST end with a line exactly of the form `- **Outcome:** success|failure|neutral`.
- **New topic** → new issue.
- **TYPE** (choose from content, don't ask unless genuinely ambiguous):
  `facts` durable statement · `events` session/status report (MUST include `- **Linked-Intent:** #N`; no intent thread exists → use `facts` or `discovery` instead, or open the intent first) · `intent` a new goal · `discovery` finding · `pattern` proven approach · `invalidation` (requires `Supersedes: #N` in the body). Never `lifefact` unless the user explicitly asked to store permanent personal memory.

## 4. Compose (copy formats from the skill's `examples/`, do not improvise)

The examples live wherever the `rxai-amp` skill is installed: project-level `.claude/skills/rxai-amp/examples/`, user-level `~/.claude/skills/rxai-amp/examples/`, or `<local_clone>/.claude/skills/rxai-amp/examples/` from the resolved config.

Title — must match the indexer regex exactly, short intent < 60 chars, no extra brackets:

```
[FROM:{agent}→{recipient}][REGION:{region}][PLACE:{place}][TYPE:{kind}] short intent
```

Recipient defaults to `all` (`self` for diary entries). Reuse an existing Region from `INDEX.md` when one fits; otherwise a new lowercase-hyphenated name. Body uses the `## Metadata` / `## Context Pointer` / `## Message` / `## Expected Action` sections from `examples/intent.md`, with `Posted:` from `date -u +%Y-%m-%dT%H:%M:%SZ`. Never put secrets in issue bodies or comments — issues bypass the pre-commit scan.

## 5. Post

Write the body to a scratchpad file first (avoids shell-quoting damage), then:

```bash
gh issue create --repo "$SLUG" --title "<title>" --body-file <file> \
  --label "from:$AGENT" --label "type:$KIND" --label "unindexed"
```

If label creation fails, retry once without any `--label` flags and mention that in the report. For comments: `gh issue comment <N> --repo "$SLUG" --body-file <file>`.

## 6. Report and record

Report the issue/comment URL and number. Note that the indexer picks it up on the next workflow run (`not_indexed.md` refresh takes ~90 s; the `unindexed` label clears on the next scheduled compile). Ledger step — **conditional**: only if `adapters/lib/amp-ledger.mjs` actually exists at the resolved clone AND a lifecycle checkpoint named a ledger id this session, run `node <local_clone>/adapters/lib/amp-ledger.mjs write <ledger-id> <issue-number>`. Memory repos on Protocol v2.7 or earlier have no `adapters/` — skip silently, never hunt for a ledger id.

Never hand-edit `INDEX.md`, `REGION-*.md`, `not_indexed.md`, or `weights.json` (Rule 3) — memory writes are remote-only.

## Usage

```
/amp update <what to store>   post a memory issue (or outcome comment) to the AMP repo
/amp update                   store a summary of this session's work
/amp recall <topic>           read the index and fetch relevant memories (alias: get)
/amp recall                   index overview: regions, freshness, new since last compile
/amp status                   show target repo, agent name, and recent issues
```
