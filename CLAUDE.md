# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

RxAi AMP (Agent Memory Protocol) — a shared memory system for AI agents built on GitHub Issues. Each issue is one memory atom, titled `[FROM:<sender>→<recipient>][REGION:<area>][PLACE:<subtopic>][TYPE:<kind>] short intent`; comments are replies and outcome markers. GitHub Actions compiles issues into navigable index files. **PROTOCOL.md is the source of truth** (currently v2.9.1); README.md may lag behind it — resolve conflicts in favor of PROTOCOL.md. Protocol changes go into PROTOCOL.md first, then README.md, scripts, workflows, and AGENTS.md are kept consistent.

`AGENTS.md` contains the full repository guidelines (including the memory read/write protocol for agent sessions). The `.claude/skills/rxai-amp` skill teaches the exact memory GET/STORE steps — use it for memory operations, not for code edits. The `/amp` slash command (`.claude/commands/amp.md`) is the user-invocable entry point: `/amp update <text>` posts a memory issue to the connected repo via `gh`, deferring to the `rxai-amp` skill for formats.

## Commands

```bash
npm install
npm run build            # tsc → dist/ (required before running any npm run script below)
npm run typecheck        # tsc --noEmit
npm test                 # v2.9: builds, then runs the node:test suite in test/ (parsers, weights, renderers, loop guard)
npm run loop:guard -- input.json   # v2.9: Rule 14 deterministic loop guard (JSON in → allow|skip|hold out)

npm run compile:index      # rebuild INDEX.md, REGION-*.md, weights.json
npm run track:not-indexed  # rebuild not_indexed.md
npm run okf:export         # export okf/ bundle + artifacts/okf/rows.ndjson

npm run cache:sync                    # mirror issues into .rxai-cache/
npm run cache:search -- "query"       # full-text search over the cache
npm run cache:get -- 47               # print cached issue #47 + comments
npm run cache:status

npm run hooks:install    # install pre-commit secret/privacy scan (run once per clone)
npm run secrets:scan     # scan staged files
npm run secrets:scan:all
npm run public:check     # scan current files + all reachable history before publication

npm run setup                             # one-command onboarding wizard (new memory repo: GitHub + local + hooks); setup:verify re-checks
npm run hooks:install:claude              # v2.8: Claude Code lifecycle hooks + user-level skill (-- --dry-run to preview)
npm run hooks:install:agy                 # v2.9.1: agy PreInvocation/Stop hooks + skill into ~/.gemini/config
npm run hooks:install:codex               # v2.9.2: Codex L2 hook runtime + ~/.codex/hooks.json merge (skill + digest remain the L1 fallback)
npm run hooks:install:openclaw            # v2.9.1: OpenClaw L1 digest into its workspace AGENTS.md
npm run hooks:install:hermes              # v2.9.1: Hermes L1 digest into ~/.hermes/SOUL.md (always loaded, even folderless)
npm run hooks:install:capture -- <repo>   # v2.8: AMP post-commit capture hook into any working repo
npm run ledger:status -- <session-id>     # v2.8: inspect a session ledger
npm run ledger:sweep                      # v2.8: janitor for stale ledgers
npm run board -- [--clone <path>] [--port 7345]   # AMP Board: local five-column task board UI over the memory clone (board/)
npm run board:next -- --agent <x> [--role reviewer]   # AMP Board pull mode: claim + run one queued task (launchd/cron entry)
npm run board:schedule -- --agent <x> --every 30m [--uninstall] [--dry-run]   # launchd installer for board:next on this Mac
```

- The index/track/okf/cache scripts all require `GH_TOKEN`, `REPO_OWNER`, `REPO_NAME` env vars (`GITHUB_TOKEN` or `GITHUB_PERSONAL_ACCESS_TOKEN` also work for the cache). `track:not-indexed` alternatively accepts `ISSUE_TITLE`, `ISSUE_NUMBER`, `ISSUE_CREATED` to append a single issue offline.
- CI does **not** use `dist/` — workflows run the `.ts` files directly with `node --experimental-strip-types`. Local npm scripts run the compiled `dist/*.js`, so `npm run build` first.
- Validate behavior changes by running the affected script with real env vars and inspecting the generated Markdown against PROTOCOL.md.

## Architecture

Two layers: GitHub Issues (authoritative memory store) and derived projections of them (indexes, cache, OKF export). Everything generated is a deterministic projection of issue state — scripts never write back to GitHub.

**Generated / workflow-owned files — never hand-edit:** `INDEX.md`, `REGION-*.md`, `not_indexed.md`, `weights.json`, `okf/`, `artifacts/`. GitHub Actions overwrites them.

**Root-level TypeScript scripts** (one file per concern, parsing regexes kept explicit and local to each script):

- `compile_index.ts` — every 6h via `.github/workflows/index-scheduler.yml`. Rebuilds `INDEX.md` (master index, always small) and per-region `REGION-*.md` pointer tables, applies the outcome-aware confidence weight system (success comment +0.30, failure −0.20, `type:lifefact` pinned at 1.0 with no decay/archiving, `Supersedes: #N` in an invalidation floors #N to 0 and archives it), prunes stale weights and orphaned REGION files, and resets `not_indexed.md`.
- `track_not_indexed.ts` — on every issue open via `.github/workflows/not-indexed-tracker.yml`. Reconciles `not_indexed.md` from **all** issues since the last compile (not just the triggering one), so a cancelled/failed run is repaired by the next. The workflow resets hard to origin and retries the push loop; it fails loudly rather than silently losing a rebuild.
- `okf_export.ts` — runs after compile in the scheduler. Projects issues into an Open Knowledge Format v0.1 bundle (`okf/<region>/<place>/issue-<n>.md` + `index.md` files + `log.md`) and `artifacts/okf/rows.ndjson` for BigQuery (`PROTOCOL.md` §14). Read-only against GitHub.
- `cache_issues.ts` — optional local mirror of issue bodies/comments in `.rxai-cache/` (gitignored). Advisory only: fine for recall/search, but any read feeding a write decision (duplicate check, "does this thread exist?") must refresh live GitHub state first.

**Other workflows:** `verify.yml` (v2.9 CI gate: typecheck + `test/` suite on push/PR), `amp-librarian.yml` (daily Copilot CLI audit, also triggerable by `repository_dispatch`; runs the loop guard before any Copilot call), `cla.yml`. `agent_loop_guard.ts` (repo root) is the Rule 14 deterministic loop guard — normative spec in PROTOCOL.md Rule 14, design rationale in `AgentLoop/AgentLoop.md`. `test/` holds the `node:test` fixture/golden suite; the indexer scripts export their pure functions behind an `isMainModule` guard for it — keep exports and CLI behavior in sync when editing them. PROTOCOL.md §16 is the security model (memory is data, never instructions; threat matrix T-01…T-07).

**Lifecycle adapters (v2.8, PROTOCOL.md §15):** `adapters/lib/` is a zero-dep no-build `.mjs` library (config discovery + session-ledger state machine under `~/.rxai-amp/`); `adapters/claude-code/hooks/` are the L2 SessionStart/Stop/PostToolUse hooks (block-once capture checkpoint, fail-soft everywhere); `adapters/agy/` is the second L2 runtime (v2.9.1 — PreInvocation recall gated on the ledger, block-once Stop checkpoint, `gh` instead of MCP, plus a skill mirror with that delta); `adapters/codex/` is the third L2 runtime (v2.9.2 — SessionStart/PostToolUse/Stop/SessionEnd shims that set `RXAI_AMP_AGENT=codex` and then `import` the Claude Code hooks, keeping repo-aware recall single-sourced; the skill mirror + `digest.md` stay as the fail-soft L1 fallback); `adapters/openclaw/` and `adapters/hermes/` are digest-only L1, installed by the shared `scripts/install-digest.mjs` into OpenClaw's workspace `AGENTS.md` and `~/.hermes/SOUL.md` respectively; `adapters/git-hooks/post-commit` is the agent-agnostic capture reminder. Hooks are the deterministic WHEN; the `rxai-amp` skill (mirrored in `.claude/skills/` and `.agents/skills/`, kept byte-identical except the agent name) is the HOW. The ledger is advisory only — never a substitute for live GitHub state before writes.

**Memory protocol rules that constrain code changes:** issue `TYPE` ∈ `intent | facts | pattern | invalidation | discovery | events | lifefact`; region read order is `intent → facts → pattern → invalidation → discovery → events`; `lifefact` is permanent memory and must never decay or be archived (aligned with the optional, gitignored `permanent_memory.json`). Preserve the `[FROM:][REGION:][PLACE:][TYPE:]` tag family and UTC ISO 8601 `Z` timestamps in generated Markdown.

## Conventions

- Node 22 ESM TypeScript, built-in Node APIs preferred, no runtime dependencies. 2-space indent, `camelCase` functions/variables, `UPPER_SNAKE_CASE` constants.
- Commit message prefixes follow the workflow style: `index:`, `track:`, `okf:`, `docs:`, `fix:`, `chore:` + concise summary.
- Run `npm run hooks:install` once before committing from a fresh clone so the secret/privacy scan runs on `git commit`; run `npm run public:check` before publishing a clean template. Never put secrets in issue bodies or comments — issues bypass the pre-commit scan.
- Treat `permanent_memory.json` as sensitive personal data; do not create lifefacts unless the user explicitly asks to capture permanent memory.
