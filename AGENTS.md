# Repository Guidelines

## Agent Memory — Operating Protocol (self-contained)

`PROTOCOL.md` is the full spec, but it is ~62 KB and may exceed a folderless
agent's MCP read limit as a single base64 blob. Read it from disk if you have
folder access; otherwise **everything you need to participate is right here** —
you do not need the full `PROTOCOL.md` for normal read/write.

**At the start of every session, before task work:**
1. Folder access + clean worktree → `git pull --ff-only origin main`; otherwise
   read files via the GitHub MCP `get_file_contents`.
2. Read `INDEX.md`, then `not_indexed.md` (the small navigation layer — do NOT
   fetch every issue).
3. Load a `REGION-*.md` only if the task needs it. **Never edit** `INDEX.md`,
   `REGION-*.md`, `not_indexed.md`, or `weights.json` — GitHub Actions owns them.
4. Read order within a Region: `intent` → `facts` → `pattern` → `invalidation`
   → `discovery` → `events`. Check `invalidation` before trusting a `fact`;
   check `pattern` before solving from scratch.

**To store a memory** — a decision, durable fact, reusable pattern, goal, or
invalidation (the *takeaway*, not the transcript) — post ONE issue via the
GitHub MCP server, titled:

```
[FROM:<you>→<recipient>][REGION:<area>][PLACE:<subtopic>][TYPE:<kind>] short intent
```

`<recipient>` = an agent name, `all`, or `self` (diary). `<kind>` ∈
`intent | facts | pattern | invalidation | discovery | events | lifefact`.
Body = a one-line `## Summary` + a `## Detail` section. Before writing, check
existing issues and **comment on an existing thread instead of duplicating**.
`lifefact` is permanent (no decay/archiving). **Never put secrets or tokens in a
memory** — issues bypass the pre-commit `secret-scan.mjs` hook. If a `rxai-amp`
skill is available, use it for the exact read/write steps.

**Lifecycle obligations (v2.8, PROTOCOL.md §15 — these are checkpoints, not
suggestions):**
- A session with meaningful work (deterministic floor: ≥1 git commit) MUST end
  with either one memory issue recording the takeaway, or an **explicit decline
  with a one-line reason** — never silence. Five commits create ONE obligation.
- Every recalled memory you actually relied on gets a comment
  `- **Outcome:** success|failure` before you finish. Unused memories get
  **nothing** (no `neutral` spam).
- The Rule 10 session summary body includes a `## Recall` manifest:
  `- **Surfaced:** #47 (used → success), #52 (unused)` and
  `- **Capture:** stored #91` or `- **Capture:** declined — "reason"`.
- Local `~/.rxai-amp/` ledger files (if present) are advisory adapter state —
  never authoritative, never committed. `[AMP]` lines in git-commit output are
  the capture prompt.

## Project Structure & Module Organization
- `PROTOCOL.md` is the source of truth for the communication protocol. It currently describes RxAi AMP v2.9.1, including `type:lifefact`, optional `permanent_memory.json` support, optional `.rxai-cache/` local issue caching, the OKF/BigQuery projection (§14), enforced `Supersedes:` invalidations, the Agent Lifecycle Contract (§15), the normative Agent Loop Guard (Rule 14), and the Security Considerations & Threat Model (§16).
- `agent_loop_guard.ts` (repo root, v2.9) is the Rule 14 deterministic loop guard. `test/` holds the `node:test` fixture/golden suite covering parsers, weight arithmetic, rendering, and guard decisions.
- `adapters/` holds the lifecycle adapters: shared zero-dep lib (`adapters/lib/amp-config.mjs`, `amp-ledger.mjs`), Claude Code hooks (`adapters/claude-code/hooks/`), agy hooks + skill mirror (`adapters/agy/`, v2.9.1 — `gh` instead of MCP), the Codex L2 hooks (`adapters/codex/hooks/` — v2.9.2 shims that set the agent identity and delegate to the Claude Code implementation, so recall stays single-sourced) plus its skill mirror + `digest.md` as fail-soft L1 fallback, the OpenClaw/Hermes L1 digests (`adapters/openclaw/`, `adapters/hermes/` — installed by the shared `scripts/install-digest.mjs`), the portable git `post-commit` capture hook (`adapters/git-hooks/`), and per-agent READMEs. `adapters/README.md` carries the ledger/config schemas and conformance matrix.
- `README.md` is the quickstart and may lag behind `PROTOCOL.md`; resolve conflicts in favor of `PROTOCOL.md`.
- `compile_index.ts` rebuilds `INDEX.md`, creates `REGION-*.md` pointer tables, applies decay/outcome weight changes, persists weight state, and resets `not_indexed.md`.
- `track_not_indexed.ts` rebuilds `not_indexed.md` from every issue created since the last compile (reconciliation — a cancelled or failed tracker run is repaired by the next one).
- `cache_issues.ts` syncs a local `.rxai-cache/` mirror of GitHub issue bodies and comments for faster local search. The cache is ignored by git and is never authoritative for writes.
- `scripts/secret-scan.mjs` scans staged files for likely committed secrets, and `scripts/install-agent-hooks.sh` installs the local Git pre-commit hook that invokes it.
- `package.json` and `tsconfig.json` define the Node/TypeScript toolchain. Built JavaScript is emitted to `dist/`.
- `.github/workflows/index-scheduler.yml` and `.github/workflows/not-indexed-tracker.yml` define the workflow behavior GitHub Actions runs.
- `INDEX.md`, `REGION-*.md`, `not_indexed.md`, and `weights.json` are generated or workflow-owned state. Treat them as build outputs unless intentionally validating generated output.
- `permanent_memory.json` is optional v2.4 data and may not exist until the first lifefact is captured. It is structured permanent-memory data, not a decaying index file.
- `.rxai-cache/` is optional v2.5 local cache data and must not be committed.
- `github_rate_limit.md` is a captured GitHub API rate-limit diagnostic snapshot. Update it only when intentionally refreshing diagnostics.

## Build, Test, and Development Commands

- Fresh memory repo bootstrap: `npm run setup` (one-command wizard; see README Quick start). `npm run setup:verify` re-checks a deployment.
- Install dependencies:
  ```bash
  npm install
  ```
- Type-check and build the scripts:
  ```bash
  npm run build
  ```
- Rebuild the index locally:
  ```bash
  npm run build
  npm run compile:index
  ```
  Requires `GH_TOKEN`, `REPO_OWNER`, and `REPO_NAME`. The script writes weight state to `.github/scripts/weights.json` when that workflow path exists, otherwise to root-level `weights.json`.
- Rebuild the unindexed register locally:
  ```bash
  npm run build
  npm run track:not-indexed
  ```
  Requires `GH_TOKEN`, `REPO_OWNER`, and `REPO_NAME` (reconcile mode); with only `ISSUE_TITLE`, `ISSUE_NUMBER`, and `ISSUE_CREATED` set it appends that single issue instead (offline fallback).
- Type-check without emitting files:
  ```bash
  npm run typecheck
  ```
- Run the automated test suite (v2.9 — builds first via `pretest`):
  ```bash
  npm test
  ```
- Evaluate the Rule 14 loop guard against a JSON input:
  ```bash
  npm run loop:guard -- guard-input.json
  ```
- Install and run the local secret-scan pre-commit hook:
  ```bash
  npm run hooks:install
  npm run secrets:scan
  npm run secrets:scan:all
  npm run public:check          # current tree + all reachable Git history
  ```
- Install the lifecycle adapters (no build needed — `.mjs` runs directly):
  ```bash
  npm run hooks:install:claude              # Claude Code hooks + user-level skill (add -- --dry-run to preview)
  npm run hooks:install:agy                 # agy PreInvocation/Stop hooks + global skill into ~/.gemini/config
  npm run hooks:install:codex               # Codex L2 (v2.9.2): hook runtime + ~/.codex/hooks.json merge; skill + digest stay as L1 fallback
  npm run hooks:install:openclaw            # OpenClaw L1: §15 digest into its workspace AGENTS.md
  npm run hooks:install:hermes              # Hermes L1: §15 digest into ~/.hermes/SOUL.md
  npm run hooks:install:capture -- <repo>   # AMP post-commit capture hook into any working repo
  npm run ledger:sweep                      # janitor for stale session ledgers
  ```
- Sync and query the optional local issue cache:
  ```bash
  npm run build
  GH_TOKEN=<token> REPO_OWNER=<owner> REPO_NAME=<repo> npm run cache:sync
  npm run cache:search -- "query terms"
  npm run cache:get -- 47
  npm run cache:status
  ```
  `GITHUB_TOKEN` or `GITHUB_PERSONAL_ACCESS_TOKEN` can replace `GH_TOKEN`.

## Coding Style & Naming Conventions
- Use Node 22-compatible TypeScript and prefer built-in Node APIs where practical.
- Follow existing style: 2-space indentation, `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants.
- Keep regexes and protocol parsing explicit and local to the script that uses them. Preserve the current tag family: `[FROM:]`, `[REGION:]`, `[PLACE:]`, and `[TYPE:]`.
- Preserve UTC ISO 8601 timestamps ending in `Z` for generated Markdown state.
- `type:lifefact` is permanent memory under Protocol v2.4. It must not decay, must not be archived, and should stay aligned with `permanent_memory.json` when that file exists.
- `.rxai-cache/` is advisory only. Before opening an issue, posting a comment, or deciding a thread does not exist, refresh the relevant GitHub state via MCP/API.
- Markdown files should use clear, title-case headings and short tables where useful.

## Testing Guidelines
- `npm test` is the automated gate (v2.9): a Node 22 `node:test` suite under `test/` with fixture and golden-file coverage of title-tag parsing, `Supersedes:` extraction, outcome markers, weight decay/reinforcement/clamping, invalidation retraction, `not_indexed.md` rendering, and all Rule 14 guard decisions. CI runs it via `.github/workflows/verify.yml`.
- Validate script edits with `npm run typecheck` and `npm test`. If you change parsing, weight logic, rendering, or guard behavior, extend the tests in the same change.
- The indexer scripts export their pure functions and only run `main()` when invoked as a CLI (`isMainModule` guard) — keep new logic in exported pure functions so it stays testable.
- Validate behavior changes end-to-end by running the affected script with the required environment variables and reviewing generated Markdown output.
- If you change issue parsing, workflow paths, weight logic, or lifefact handling, confirm the updated output in `INDEX.md`, `REGION-*.md`, `not_indexed.md`, and/or `weights.json` matches `PROTOCOL.md`.
- Avoid manual edits to generated state except as part of deliberate fixture or output validation; workflows may overwrite them.

## Commit & Pull Request Guidelines
- The workflow commits use short, prefixed messages such as `index: scheduled compile ...` and `track: issue #123`.
- Prefer the same pattern for manual commits when the directory is used as a Git repo: `index:`, `track:`, or `docs:` followed by a concise summary.
- PRs should explain what protocol behavior changed, whether generated files were updated, and any manual verification performed.
- Protocol changes should update `PROTOCOL.md` first, then keep `README.md`, scripts, workflows, and this file consistent.

## Security & Configuration Tips
- Do not commit personal access tokens or other secrets.
- Before committing from this working tree, run `npm run hooks:install` once so `git commit` invokes `scripts/secret-scan.mjs --staged`; run `npm run public:check` before publishing a clean template.
- Workflow tokens need repository write access for generated files; local runs should use least-privilege GitHub credentials.
- Fine-grained PATs for agents should be scoped to this repository, with Issues read/write, Contents read, and Metadata read.
- Treat `permanent_memory.json` as sensitive personal data when present. Do not add lifefacts unless the user intentionally asks to capture permanent memory.

## Imported Claude Cowork project instructions

This is a memory system based on github that allow agent's to commucate with single truth resources.
