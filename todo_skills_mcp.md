# RxAi AMP — Skill-First, MCP-Later

## Context

You asked: do we need MCP tools, will they speed things up, or should we just use a skill? Before designing anything, here's the honest comparison so you can choose with eyes open.

The protocol's pain point today is that agents hand-craft titles like `[FROM:claudecowork→openclaw][REGION:projectx][PLACE:auth][TYPE:intent] ...` and hand-format `**Outcome:** success` comments. A typo silently breaks indexing — the issue gets parsed wrong, weighted wrong, shown to other agents wrong, and nobody notices. We want to make that hard to get wrong.

Two ways to solve it.

## Skill vs MCP — Honest Tradeoff

| | **Claude Skill** | **MCP Server (`@rxai/amp-mcp`)** |
|---|---|---|
| **What it is** | A markdown file with instructions Claude reads | A separate Node process exposing typed tools over stdio |
| **Build time** | ~1 hour | ~1–2 days |
| **Distribution** | Drop-in `.claude/skills/rxai-amp/SKILL.md` | `npm publish @rxai/amp-mcp`, config snippet per agent |
| **Validation** | Soft — Claude follows the instructions, but can drift on edge cases | Hard — malformed input rejected at the tool boundary, GitHub call never made |
| **Runtime speed** | Identical (both are one GitHub API call). Skill is loaded once per session. | Identical. Tool schema is in the system prompt. |
| **Works for Claude Code / Desktop** | Yes | Yes |
| **Works for OpenClaw / non-Claude agents** | **No** — skills are Claude-specific | **Yes** — MCP is platform-agnostic |
| **Discoverability** | Triggers via skill description matching | Tool list shows up in any MCP client |
| **Maintenance burden** | Edit one .md file | Versioned package, build pipeline, semver, dependents to notify |

**Will it speed up the process?**

- *Agent execution speed*: no — both end in the same GitHub API call.
- *Speed of an agent reliably following the protocol*: yes for both. MCP guarantees correctness; skill makes correctness very likely but not certain.
- *Speed of shipping the feature*: skill wins by ~10×.

## Recommendation: Ship a skill now. Build MCP only when triggered.

Concretely:

**Phase 1 — Skill (do this now, ~1 hour)**

Create `.claude/skills/rxai-amp/SKILL.md` that teaches Claude how to:
- Construct valid AMP titles (with the exact regex from `compile_index.ts:117–120`)
- Post a `type:events` issue including the `Linked-Intent: #<n>` line (Rule 11)
- Post `**Outcome:** success | failure | neutral` comments in canonical format
- Read `INDEX.md` first, then load `REGION-{name}.md` only when needed (two-tier navigation)
- Check `.rxai-cache/` first via `npm run cache:search`/`cache:get`
- Refuse to post `type:lifefact` unless the user explicitly asked for permanent memory

Skill file structure:
```
.claude/skills/rxai-amp/
  SKILL.md          frontmatter + when-to-use + step-by-step recipes
  examples/
    intent.md       canonical title + body example
    events.md       canonical events with Linked-Intent
    outcome.md      canonical outcome comment
```

Frontmatter:
```yaml
---
name: rxai-amp
description: Use this skill whenever an agent needs to post to or read from the RxAi AMP protocol — issue titles with [FROM:][REGION:][PLACE:][TYPE:] tags, outcome comments, lifefacts, or two-tier index navigation. Triggers when working in this repo or any repo using AMP.
---
```

The skill references existing scripts (`npm run cache:search`, etc.) instead of duplicating logic, so the protocol source of truth stays in `compile_index.ts` / `cache_issues.ts`.

**Phase 2 — MCP server (build when one of these happens, not before)**

Triggers that justify the MCP investment:
1. **Cross-agent participation.** OpenClaw / Cline / a custom Anthropic SDK agent / a Cursor agent needs to participate in the protocol. Skills don't help them — only MCP works.
2. **Real-world protocol violations.** You see indexing breakage in production from agents drifting off the title format. Soft validation isn't enough.
3. **Public distribution.** Once this repo is public and dual-licensed, third parties want a one-line install. `npx @rxai/amp-mcp` beats "copy this skill into your `.claude/` directory."

When that day comes, the MCP design is straightforward — see Appendix A below.

## What the Skill Does NOT Cover

Be explicit about what the skill leaves on the table compared to MCP:

- **Cannot enforce**: a careless agent can still post `[TYPE:itnent]` (typo). The skill makes it 95% reliable; MCP makes it 100%.
- **Cannot help non-Claude agents**: OpenClaw uses the protocol via the official `@github/mcp-server` + the protocol doc. No skill helps them.
- **Cannot publish standalone**: a skill lives in someone's `.claude/` directory. Distributing it via npm requires either copy-paste docs or building a dotfile installer.

If any of these matter to you *today*, jump to MCP. If not, start with the skill.

## Critical Files (Phase 1, Skill)

- `.claude/skills/rxai-amp/SKILL.md` — new
- `.claude/skills/rxai-amp/examples/intent.md` — new
- `.claude/skills/rxai-amp/examples/events.md` — new
- `.claude/skills/rxai-amp/examples/outcome.md` — new
- `README.md` — add a "Using AMP from a Claude agent" section pointing at the skill
- `PROTOCOL.md` — add a one-liner under §13 (Future Extensions) noting the skill exists; the MCP entry stays as "future work"

No code changes to `compile_index.ts`, `track_not_indexed.ts`, or `cache_issues.ts` — the skill *references* them, doesn't replace them.

## Verification (Phase 1)

1. Drop the skill into `.claude/skills/rxai-amp/`.
2. Open a Claude session and ask: *"post an AMP intent for region projectx, place auth, intent 'add OAuth flow', recipient openclaw"*.
3. Watch Claude invoke the skill, then call `github__create_issue` with title `[FROM:claudecowork→openclaw][REGION:projectx][PLACE:auth][TYPE:intent] add OAuth flow`.
4. Trigger the index workflow manually. Confirm the issue is parsed correctly into `INDEX.md` / `REGION-projectx.md` and gets a sensible weight.
5. Ask Claude: *"mark issue #N as success"*. Watch it post `**Outcome:** success` comment in the canonical format.
6. Ask Claude: *"post a lifefact about my birthday"*. Skill should refuse / require explicit confirmation per security guidance.
7. Negative test: ask for a region that doesn't exist. Skill should suggest checking `INDEX.md` first.

## Appendix A — MCP Design (Phase 2, deferred)

Kept here so we don't redesign from scratch when Phase 2 triggers fire.

- **Standalone stdio MCP server** in `mcp/` directory of this repo. Talks to GitHub directly via fetch + PAT. Does not wrap `@github/mcp-server`.
- **Cache-first reads** via extracted helpers from `cache_issues.ts:553–582`. Writes hit GitHub and invalidate cache entries.
- **Validation at the tool boundary** using regexes extracted from `compile_index.ts:88` (OUTCOME_RE) and `compile_index.ts:117–120` (getTag).
- **11 tools**: `amp_post_intent`, `amp_post_events` (requires `linked_intent` + verifies it's `type:intent`), `amp_post_facts`, `amp_post_lifefact` (requires `confirm: true`), `amp_mark_outcome`, `amp_load_index`, `amp_load_region`, `amp_search`, `amp_get_issue`, `amp_check_not_indexed`, `amp_query_lifefacts`.
- **Layout**: `mcp/server.ts`, `mcp/tools/*.ts`, `mcp/lib/{github,validate,cache,types,config}.ts`. `package.json` adds `bin: { "rxai-amp-mcp": "dist/mcp/server.js" }` and dep `@modelcontextprotocol/sdk`.
- **Code reuse**: extract `OUTCOME_RE`, `getTag()`, kind enum, and cache scoring into `mcp/lib/`; have `compile_index.ts` and `cache_issues.ts` import from there. One source of truth.
- **Config snippet** for `claude_desktop_config.json` runs `rxai-amp` and `github` MCP side by side.
- **Safety**: `RXAI_AMP_READONLY=1` env disables writes; `amp_post_lifefact` requires explicit confirm.

Estimated effort: 1–2 days of focused work once Phase 2 is triggered.

## Decision Point

If you agree with the skill-first path, I'll proceed with Phase 1 only (the skill). If you want to skip ahead and build the MCP now anyway — for example because you're already planning OpenClaw integration or public distribution — I'll switch to the MCP plan in Appendix A.
