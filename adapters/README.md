# AMP Lifecycle Adapters (Protocol v2.9.1, §15)

Reference implementations of the Agent Lifecycle Contract. `PROTOCOL.md` §15
is the normative spec; this file holds the operational detail deliberately
kept out of the 71 KB protocol document.

**Division of labor:** hooks are the deterministic **when** (inject, detect,
prompt, gate). The `rxai-amp` skill is the **how** (title grammar, duplicate
checks, read order). The session ledger is the connective state between them.

## Contract → mechanism map

| Obligation (§15.1) | Claude Code (L2) | agy (L2) | Git floor (any shell agent) | Folderless (L0/L1) |
|---|---|---|---|---|
| RECALL | `SessionStart` hook injects INDEX.md + not_indexed.md, then the bodies of the top open issues whose Region matches the cwd repo (`lib/amp-recall.mjs`, #442), ledgered as surfaced `via: "inject"`. With a matched Region, INDEX.md is rendered around it (matched Regions verbatim, every other Region as one item with its active thread numbers) and an empty not_indexed.md collapses to one line — the block is re-read on every turn, so it is kept near 4–5 KB | `PreInvocation` injects the same, once per conversation (ledger-gated) | — (pair with an L1 digest) | read via MCP per digest |
| CAPTURE | `Stop` hook blocks once with checklist; decline always offered | `Stop` hook returns `decision: "continue"` once, same checklist | `post-commit` prints reminder into the agent's tool output + records boundary | Rule 10 summary or decline |
| OUTCOME | `Stop` checklist lists unmarked recalled issues; `PostToolUse` auto-records | `Stop` checklist lists them with the `gh issue comment` form (no tool-arg observer available) | manifest audited remotely by Librarian | manifest in summary |

## Conformance matrix (declared in PROTOCOL.md §2)

| Agent | Level | Mechanisms |
|---|---|---|
| claudecowork | L2 | user-level hooks (`session-start`, `stop`, `post-tool-use`) + user-level skill + git floor |
| agy | L2 | global hooks (`pre-invocation`, `stop`) + global skill mirror + git floor (`adapters/agy/README.md`) |
| codex | L1 | skill mirror + `AGENTS.md` digest + git floor, installed by `npm run hooks:install:codex` (`adapters/codex/README.md`) |
| openclaw | L1 | workspace `AGENTS.md` digest + git floor, installed by `npm run hooks:install:openclaw` (`adapters/openclaw/README.md`) |
| hermes | L1 | `~/.hermes/SOUL.md` digest (always loaded from HERMES_HOME), manifest-as-ledger, installed by `npm run hooks:install:hermes` (`adapters/hermes/README.md`) |

## Install

> `npm run setup` (repo root) wraps all of these installers during full onboarding.

```bash
# Claude Code (hooks into ~/.claude/settings.json + skill into ~/.claude/skills):
npm run hooks:install:claude          # add -- --dry-run to preview

# agy / Antigravity CLI (hooks + skill into ~/.gemini/config/):
npm run hooks:install:agy             # add -- --dry-run to preview

# Codex (L1: skill into ~/.codex/skills + §15 digest into ~/.codex/AGENTS.md):
npm run hooks:install:codex           # add -- --dry-run to preview

# OpenClaw (L1: §15 digest into its workspace AGENTS.md):
npm run hooks:install:openclaw        # add -- --dry-run to preview

# Hermes (L1: §15 digest into ~/.hermes/SOUL.md — always loaded, even folderless):
npm run hooks:install:hermes          # add -- --dry-run to preview

# Capture floor into any working repo (agent-agnostic):
npm run hooks:install:capture -- /path/to/working/repo

# This repo's own pre-commit secret/privacy scan (unchanged entry point):
npm run hooks:install
```

`npm install` deliberately does **not** wire anything up — an install that
wrote into `~/.codex` or `~/.claude` would fire in CI, in image builds and on
every dependency bump. Its `postinstall` only *reads*: it names the agents
present on this machine that are missing their AMP wiring and prints the
command for each (silent under `CI` or `AMP_DISABLE=1`, and when everything is
already installed). `npm run setup` does the same detection by probing config
roots — `~/.claude`, `~/.gemini/config`, `~/.codex`, `~/.openclaw`,
`~/.hermes`, not `PATH`, because `codex` is often a shell function and `agy`
lives outside `PATH` — then offers each detected agent's installer.

**The capture floor is not optional in practice.** A checkpoint decides
whether a session was meaningful by counting work boundaries, and boundaries
come from this hook — a repo without it produces sessions that always look
trivial, so the agent is never asked to store anything. `npm run setup`
therefore scans the agents' own configs (agy `trustedWorkspaces`, Claude Code
project history), resolves each path to its git toplevel, hides repos with no
commit in 90 days or that already have the hook, and offers the rest as
`all / none / 1,3-5`. Non-interactive runs (`--yes`, `--dry-run`) only list
them — the wizard never writes into repos outside this one unanswered.
`npm run setup -- --verify` reports the same coverage as a checklist box.

Uninstall / disable: `AMP_DISABLE=1` in the environment silences every
adapter instantly; rerun the installer after moving this checkout (hook
commands use absolute paths and fail soft — silently — when orphaned).

## Configuration discovery

Every adapter resolves the memory repo through `lib/amp-config.mjs`:

1. Env: `RXAI_AMP_REPO` (clone path), `RXAI_AMP_SLUG` (`owner/repo`),
   `RXAI_AMP_AGENT`, `RXAI_AMP_HOME`
2. `~/.rxai-amp/config.json` — schema `rxai-amp/config@1`:

   ```json
   {
     "schema": "rxai-amp/config@1",
     "memory_repo": { "owner": "you", "name": "your-memory-repo", "local_clone": "/abs/path" },
     "agent_name_default": "claudecowork"
   }
   ```

3. Self-detection: cwd contains a `PROTOCOL.md` naming "RxAi AMP" plus
   `weights.json` (i.e. you are working inside the memory repo itself).

Nothing resolvable → every adapter exits 0 silently (§15.5 fail-soft).
`npm run hooks:install:claude` writes the config file for you.

## Session ledger — normative schema (`rxai-amp/ledger@1`)

One file per session: `~/.rxai-amp/sessions/<sanitized-session-id>.json`,
directory mode 0700, file mode 0600. Issue numbers and truncated titles only —
**never** token values, never issue bodies. Advisory state (Rules 3A/13
analogue): never committed, never authoritative, cannot authorize a write.

```json
{
  "schema": "rxai-amp/ledger@1",
  "session_id": "…",
  "agent": "claudecowork",
  "project": "/path/of/working/dir",
  "started_at": "2026-08-01T10:22:13Z",
  "closed_at": null,
  "status": "open",
  "recall": {
    "surfaced": [
      { "issue": 47, "title": "[…][TYPE:pattern] …", "via": "agent", "disposition": "unknown", "outcome_posted": null }
    ]
  },
  "capture": {
    "boundaries": [ { "kind": "commit", "repo": "someRepo", "ref": "abc1234", "subject": "…", "at": "…" } ],
    "writes":     [ { "issue": 91, "at": "…" } ],
    "declined":   null,
    "nagged": false
  }
}
```

- `status`: `open → closed` (capture discharged) or `open → stale` (48 h
  janitor) — stale ledgers with undischarged obligations are surfaced once at
  the next session start, then deleted after 7 further days.
- `via`: how the issue reached the agent — `agent` (the agent fetched it:
  CLI `surface`, MCP `issue_read` observer; entries without the field, written
  before it existed, read as `agent`) or `inject` (an adapter pushed it at
  session start — repo-aware recall, #442). Only `agent` entries count
  toward the Stop checkpoint: a session with no boundaries and nothing fetched
  is trivial even when memories were injected, because surfaced-but-unused
  memories owe nothing (§15.1 OUTCOME). An injected issue the agent later
  fetches itself flips to `agent`.
- `nagged`: the Stop checkpoint blocked once already; it never blocks twice.
- Concurrency: one file per session id; two agents on one machine differ by
  `RXAI_AMP_AGENT` and session id — no locking needed.
- Shell agents without a session id use a per-day key
  (`git-<agent>-<YYYYMMDD>`), which is also what makes "five commits = one
  obligation" hold at the git floor.
- CLI: `node adapters/lib/amp-ledger.mjs <open|surface|boundary|write|decline|nagged|close|status|sweep> …`

## Failure modes (all degrade, none block)

| Failure | Behavior |
|---|---|
| GitHub unreachable at session start | inject local copy with `source: local (possibly stale)` banner; never block |
| GitHub unreachable at Stop | remote verify is skipped; the checklist still offers decline; unposted obligations carry to next session via the ledger — writes are never queued for replay (Rule 3A) |
| No config anywhere | every adapter exits 0 silently (drops to L0/L1 prose) |
| Memory repo checkout moved/deleted | hooks fail soft (absolute paths gone → exit 0); rerun installer to repair |
| Working repo IS the memory repo | self-detection path resolves it; Rule 3A unchanged |
| Crashed session | ledger goes stale at 48 h; surfaced once at next session start; never auto-posted |
| Hook runtime API drift (Claude Code) | shapes quarantined in `claude-code/hooks/*` + installer; dated verification comment in each file |
| Hook runtime API drift (agy) | same quarantine in `agy/hooks/*` + `agy/hooks.json`; agy's own contract doc is `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md` |

## Security notes

- The ledger directory holds issue **titles** from a private memory repo —
  that is personal data. Hence 0700/0600 and the no-bodies/no-tokens rule.
- Tokens stay in the OS keychain / agent config (PROTOCOL.md §2). Adapters
  read `GH_TOKEN`/`GITHUB_TOKEN`/`GITHUB_PERSONAL_ACCESS_TOKEN` from the
  environment for the Stop hook's read-only remote verify; they never write
  or persist them.
- Adapters never post memory content autonomously (§15.5) — composing a
  memory requires judgment; only the agent writes, via GitHub Issues.
- Triggers are local session/git events only — never GitHub events
  (anti-loop stance; see `AgentLoop/AgentLoop.md` for the event-driven
  guard, which is a separate, reserved layer: PROTOCOL.md Rule 14).
