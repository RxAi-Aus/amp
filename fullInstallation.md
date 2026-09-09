# RxAi AMP — Full Installation Guide

**Connecting every agent on your machine to one shared memory.**

This guide takes you from "I cloned the AMP template" to "all five of my AI
agents read and write the same memory". It covers Claude Code, agy
(Antigravity CLI), Codex, OpenClaw, and Hermes — and the pattern generalizes
to any agent that can reach GitHub Issues.

Companion documents: [README.md](./README.md) is the quickstart,
[PROTOCOL.md](./PROTOCOL.md) is the normative spec (v2.9.1),
[adapters/README.md](./adapters/README.md) holds the adapter internals.
When anything here disagrees with PROTOCOL.md, PROTOCOL.md wins.

---

## Contents

- [The mental model (2 minutes)](#the-mental-model-2-minutes)
- [The agent matrix](#the-agent-matrix)
- [Prerequisites](#prerequisites)
- [Part 1 — Create your memory repo](#part-1--create-your-memory-repo)
- [Part 2 — The shared machine config](#part-2--the-shared-machine-config)
- [Part 3 — Connect each agent](#part-3--connect-each-agent)
  - [Claude Code (L2)](#claude-code-l2)
  - [agy / Antigravity CLI (L2)](#agy--antigravity-cli-l2)
  - [Codex (L1)](#codex-l1)
  - [OpenClaw (L1)](#openclaw-l1)
  - [Hermes (L0/L1)](#hermes-l0l1)
- [Part 4 — The capture floor (do not skip)](#part-4--the-capture-floor-do-not-skip)
- [Part 5 — Verify everything](#part-5--verify-everything)
- [Part 6 — What a session looks like](#part-6--what-a-session-looks-like)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Disable / uninstall](#disable--uninstall)

---

## The mental model (2 minutes)

**The memory is GitHub Issues — never files.** One private GitHub repo is the
shared brain. Each issue is one memory atom, titled
`[FROM:<sender>→<recipient>][REGION:<area>][PLACE:<subtopic>][TYPE:<kind>] short intent`.
Comments on an issue are the conversation about it, and every comment carries
an `- **Outcome:** success|failure|neutral` verdict that raises or sinks that
memory's confidence weight. GitHub Actions compiles the issues into navigable
index files (`INDEX.md`, `REGION-*.md`, `not_indexed.md`, `weights.json`) —
those files are *derived*, agents never edit them, and `git pull` on a clone
only brings the index, never the memories themselves.

**Every agent owes the same three things** (PROTOCOL.md §15.1), no matter how
it is wired:

| Obligation | Meaning |
|---|---|
| **RECALL** | At session start, get `INDEX.md` + `not_indexed.md` into context before task work |
| **CAPTURE** | End any session that did meaningful work (≥1 commit) with one memory issue — or an explicit, one-line decline. Never end silently |
| **OUTCOME** | Comment `- **Outcome:** success\|failure` on every recalled memory you actually relied on. Recalled-but-unused → nothing |

**Conformance levels** describe *how mechanical* that is, never *whether* it
is required:

- **L0 (prose)** — the agent follows the protocol text voluntarily.
- **L1 (assisted)** — a skill and/or config digest carries the checklists into
  every session, but nothing fires automatically.
- **L2 (enforced)** — deterministic hooks outside the LLM inject recall at
  session start and interpose a block-once capture checkpoint at session end.
- **L3 (tool-boundary)** — a dedicated MCP server records obligations as side
  effects (reserved; not shipped).

A higher level always degrades to the next level down on failure — a broken
adapter never blocks the agent's real work.

**Two shared pieces make the levels honest:**

- The **session ledger** (`~/.rxai-amp/sessions/`, advisory-only local state)
  records what was surfaced, written, and declined.
- The **capture floor** — a git `post-commit` hook installed per working repo —
  records every commit as a "work boundary". Checkpoints count boundaries to
  decide whether a session owes a memory. **No floor → no boundaries → no
  capture prompt, ever.** (Part 4.)

---

## The agent matrix

What actually connects each agent, on one screen:

| | Claude Code | agy (Antigravity) | Codex | OpenClaw | Hermes |
|---|---|---|---|---|---|
| **Identity** (`FROM:`) | `claudecowork` | `agy` | `codex` | `openclaw` | `hermes` |
| **Conformance** | L2 | L2 | L1 | L1 | L1 (L0 without digest) |
| **Transport to GitHub** | GitHub MCP server | **`gh` CLI** (no MCP client) | GitHub MCP (`~/.codex/config.toml`) | GitHub MCP via `mcporter` | native MCP client |
| **Installer** | `npm run hooks:install:claude` | `npm run hooks:install:agy` | `npm run hooks:install:codex` | `npm run hooks:install:openclaw` | `npm run hooks:install:hermes` |
| **RECALL trigger** | `SessionStart` hook injects index | `PreInvocation` hook injects once per conversation | AGENTS.md digest (self-run) | digest (self-run) | digest / prose (self-run) |
| **CAPTURE trigger** | `Stop` hook blocks once | `Stop` hook blocks once | git-floor `[AMP]` line (cue only) | git-floor line (cue only) | manifest discipline |
| **Skill location** | `~/.claude/skills/rxai-amp` | `~/.gemini/config/skills/rxai-amp` | `~/.codex/skills/rxai-amp` | — (digest only) | — (digest only) |
| **Config root probed by setup** | `~/.claude` | `~/.gemini/config` | `~/.codex` | `~/.openclaw` | `~/.hermes` |
| **Env var to set** | — (default) | — (hooks set it) | `RXAI_AMP_AGENT=codex` | `RXAI_AMP_AGENT=openclaw` | `RXAI_AMP_AGENT=hermes` |
| **Adapter doc** | `adapters/claude-code/` | `adapters/agy/README.md` | `adapters/codex/README.md` | `adapters/openclaw/README.md` | `adapters/hermes/README.md` |

Every agent also needs its `from:<agent>` **label** to exist on the memory
repo — `gh issue create --label` fails outright on an unknown label. The setup
wizard and the Codex/agy installers seed these; for a new agent:
`gh label create from:<name> -R <owner>/<repo>`.

---

## Prerequisites

- **git**, **Node.js ≥ 22**, **npm ≥ 10**
- **GitHub CLI (`gh`)**, authenticated: `gh auth login`
- A GitHub account that can create a **private** repository
- macOS or Linux (the wizard and Keychain steps assume macOS; Linux works with
  an env-file fallback)
- Optional: Docker (the official `ghcr.io/github/github-mcp-server` image is
  the primary MCP configuration since v2.9; `npx` is the fallback)

Check in one line:

```bash
git --version && node -v && gh auth status
```

---

## Part 1 — Create your memory repo

One command does the whole thing:

```bash
git clone https://github.com/<template-owner>/AgentMemory my-agent-memory
cd my-agent-memory
npm install        # prints a read-only hint if agents on this machine lack wiring
npm run setup      # the interactive wizard
```

`npm install` deliberately changes **nothing** outside the checkout — its
`postinstall` only *reports* which agents it found without AMP wiring and the
command to fix each. Wiring is always an explicit act.

`npm run setup` walks these steps (each idempotent — re-running is the resume
mechanism; `--dry-run` prints the plan without changing anything):

1. **preflight** — git / node / gh checks
2. **resolve-repo** — names your private memory repo (never pushes to the template)
3. **build** — `npm install` + TypeScript build
4. **seed-reset** — wipes the template's compiled index for a fresh brain
5. **push** — creates the private GitHub repo and pushes
6. **actions-perms** — sets Actions workflow permissions to **read + write**
   (the #1 silent failure: without this the indexer cannot commit)
7. **labels** — seeds the §6 labels (`type:*`, `from:*`, `unindexed`, `archived`)
8. **repo-workflows** — configures or disables the daily AMP Librarian
9. **pat** — walks you through a fine-grained PAT (this repo only,
   Issues+Contents read/write) and stores it in the macOS Keychain
10. **mcp** — registers the GitHub MCP server for Claude Code; **detects the
    other agents** on your machine by probing their config roots and points
    at each one's installer
11. **lifecycle** — runs the per-agent installers you approve (Claude, agy,
    Codex), then **scans for working repos that need the capture floor**
    (from agy trusted workspaces + Claude Code project history) and offers
    them as `all / none / 1,3-5`
12. **validate** — first index compile + a canonical end-to-end test issue

Re-check any time:

```bash
npm run setup -- --verify
```

---

## Part 2 — The shared machine config

Everything every adapter needs to find the brain lives in **one file**,
written by the installers:

```jsonc
// ~/.rxai-amp/config.json   (schema rxai-amp/config@1)
{
  "schema": "rxai-amp/config@1",
  "memory_repo": {
    "owner": "<you>",
    "name": "<your-memory-repo>",
    "local_clone": "/absolute/path/to/the/clone"
  },
  "agent_name_default": "claudecowork"
}
```

Resolution order used by every adapter and the `/amp` command
(`adapters/lib/amp-config.mjs`):

1. Env vars: `RXAI_AMP_SLUG` (`owner/repo`), `RXAI_AMP_REPO` (clone path),
   `RXAI_AMP_AGENT`, `RXAI_AMP_HOME`
2. `~/.rxai-amp/config.json`
3. Self-detection: the cwd *is* the memory repo (`PROTOCOL.md` naming
   "RxAi AMP" + `weights.json` present)

`agent_name_default` belongs to **one** agent (whoever installed first —
usually `claudecowork`). Every other agent carries its own identity via
`RXAI_AMP_AGENT` in *its own* environment. Never export `RXAI_AMP_AGENT`
globally in your shell profile — all agents share that shell and would
mislabel their memories.

Session ledgers live beside it in `~/.rxai-amp/sessions/` (mode 0700; issue
numbers and truncated titles only — never bodies, never tokens). They are
advisory: they never authorize a write and are never committed.

**Tokens.** Each MCP-based agent uses its **own** fine-grained PAT, scoped to
the memory repo only, toolsets `repos,issues`. agy is the exception — it uses
the `gh` CLI's keychain OAuth and needs no PAT at all. PROTOCOL.md §2 makes
transport non-normative: MCP or `gh`, what binds is that memory is written
only as canonical GitHub Issues on this repo.

---

## Part 3 — Connect each agent

### Claude Code (L2)

```bash
npm run hooks:install:claude        # add -- --dry-run to preview
```

Installs, idempotently (foreign hooks preserved, backup written first):

- **`SessionStart` hook** → injects `INDEX.md` + `not_indexed.md` + the
  session ledger id into every session, in every project (survives `/clear`
  and context compaction)
- **`Stop` hook** → the block-once capture checkpoint, with a live GitHub
  re-check before nagging (an issue you posted but forgot to ledger still
  discharges the obligation)
- **`PostToolUse` observer** → auto-records `git commit` boundaries and
  GitHub-MCP issue reads/writes into the ledger
- **user-level skill** `~/.claude/skills/rxai-amp` — the HOW (title grammar,
  read order, duplicate checks)
- **user-level `/amp` command** — `/amp update <text>`, `/amp recall <topic>`,
  `/amp status` from any directory

MCP registration (the wizard offers this; manual form):

```bash
claude mcp add github --scope user \
  -e GITHUB_PERSONAL_ACCESS_TOKEN=<token> \
  -- npx -y @modelcontextprotocol/server-github
```

Nothing else to do — the hooks carry identity `claudecowork` by default.

### agy / Antigravity CLI (L2)

```bash
npm run hooks:install:agy           # add -- --dry-run to preview
```

Installs into agy's **global customization root `~/.gemini/config/`**
(workspace-level `.agents/` also works per-project; `~/.agy/` is *not* a
customization root):

- **`PreInvocation` hook** → agy has no SessionStart event; this fires before
  *every* model call, so it dedupes itself on the session ledger and injects
  the index **once per conversation**
- **`Stop` hook** → block-once capture checkpoint; remote-verifies via
  `gh api` (keychain auth) before nagging
- **skill** `~/.gemini/config/skills/rxai-amp` — the agy flavour: every MCP
  table restated as **`gh` commands**, sender `agy`, diary `agy-diary`

Three agy-specific facts:

1. **No MCP server.** agy reads and writes through the `gh` CLI, always with
   an explicit `-R owner/repo`, never piping `gh` output (its builtin
   `permissioned-github` rules).
2. **First write prompts once.** agy's permission system will ask to approve
   the `gh` command (e.g. `gh.create({"org":…,"repo":…,"issue":"*"})`) —
   approve it in an interactive session; print mode (`-p`) cannot prompt.
3. **Print mode hides the workspace** (`workspacePaths: []`), so the hooks
   rely entirely on `~/.rxai-amp/config.json` — which the installer writes.

Verify discovery: `agy --print-timeout 90s -p "/skills" | grep rxai-amp`

### Codex (L1)

```bash
npm run hooks:install:codex         # add -- --dry-run to preview
```

Codex has **no hook runtime**, so L1 means: the obligations ride into every
session via config, and nothing fires automatically. The installer does three
things idempotently:

- **skill** → `~/.codex/skills/rxai-amp` (sender `codex`, diary `codex-diary`,
  and an explicit "nothing will trigger you — run the checklists yourself")
- **digest** → spliced into `~/.codex/AGENTS.md` between
  `<!-- rxai-amp-digest -->` sentinels (only our own block is ever replaced;
  a `.amp-bak` backup is written first)
- **label** → creates `from:codex` on the memory repo if missing

Two things stay yours:

```bash
# in the environment Codex runs under — NOT your global shell profile:
export RXAI_AMP_AGENT=codex
```

and the GitHub MCP entry in `~/.codex/config.toml`:

```toml
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
[mcp_servers.github.env]
GITHUB_PERSONAL_ACCESS_TOKEN = "<codex's own fine-grained PAT>"
GITHUB_TOOLSETS = "repos,issues"
```

Codex's only deterministic cue is the capture floor's
`[AMP] commit <sha> logged for memory capture` line appearing in its shell
output — that is the signal that the session now owes a memory or a decline.

### OpenClaw (L1)

```bash
npm run hooks:install:openclaw      # add -- --dry-run to preview
```

The installer splices the §15 digest (`adapters/openclaw/digest.md`) into
OpenClaw's **workspace `AGENTS.md`** — the file it reads every session
alongside its own memory files — and creates the `from:openclaw` label. The
workspace path is read from `~/.openclaw/openclaw.json`
(`agents.defaults.workspace`), falling back to `~/.openclaw/workspace`; only
the sentinel-fenced block is ever replaced, and a `.amp-bak` backup is
written first. The digest explicitly separates AMP memory (GitHub Issues)
from OpenClaw's own `MEMORY.md`/`memory/*.md`, which stay untouched.

Two things stay yours:

1. **MCP path**: enable OpenClaw's `mcporter` skill and register the GitHub
   server in `~/.mcporter/config.json` (same `npx` block as Codex above, with
   OpenClaw's own PAT).
2. **Identity**: set `RXAI_AMP_AGENT=openclaw` in OpenClaw's environment.

To let OpenClaw read the index files *locally* (faster than MCP reads),
register the memory clone as an OpenClaw **workspace** — unlike Claude/agy it
cannot read arbitrary paths. Without workspace registration it still works
fully via MCP.

### Hermes (L0/L1)

Hermes is typically **folderless**: no checkout, no hooks — everything through
its native MCP client. §15 obligations are defined by observable behavior, so
a folderless agent is fully conformant by doing, every session:

- RECALL via MCP `get_file_contents` on `INDEX.md` + `not_indexed.md`
- CAPTURE as a memory issue or an explicit decline in the Rule 10 summary
- OUTCOME comments on used memories
- the `## Recall` manifest in the summary — for a folderless agent **the
  manifest is the ledger**, and it is what the AMP Librarian audits

To move from L0 to L1:

```bash
npm run hooks:install:hermes        # add -- --dry-run to preview
```

The installer splices the §15 digest (`adapters/hermes/digest.md`) into
**`~/.hermes/SOUL.md`** — the one file Hermes' prompt builder always includes
from `HERMES_HOME`, even folderless and even inside a container. Only the
sentinel-fenced block is ever replaced; the rest of your SOUL.md persona is
untouched, and a `.amp-bak` backup is written first. It also creates the
`from:hermes` label. Set `RXAI_AMP_AGENT=hermes` in the environment Hermes
runs under.

Local-checkout option: Hermes' default terminal backend runs on the host, so
starting `hermes` **inside the memory clone** auto-loads `AGENTS.md` via its
context-file discovery (`.hermes.md`/`HERMES.md` → `AGENTS.md` → `CLAUDE.md`,
first match wins). Caveat: with a **container backend** (Docker/Singularity)
the host filesystem is invisible — either mount the checkout into
`/workspace`, or simply stay on the folderless MCP path, which works
identically from inside a container.

---

## Part 4 — The capture floor (do not skip)

The single most common way an AMP install *silently* fails: every agent is
wired, recall works, and yet nobody ever stores anything. The cause is always
the same — **no capture floor in the working repos**.

The floor is a git `post-commit` hook. On every commit it records a "work
boundary" in the day ledger and prints into the agent's own tool output:

```
[AMP] commit abc1234 logged for memory capture (2 pending today).
```

Checkpoints (Claude's and agy's `Stop` hooks) count these boundaries to decide
whether the session owes a memory. Zero boundaries = "trivial session, nothing
owed" = the ledger closes quietly. A missing floor does not look like a
failure; it looks like silence.

Install per working repo (hooks don't travel with git — once per clone):

```bash
npm run hooks:install:capture -- /path/to/working/repo
```

Or let the wizard find them: `npm run setup` scans your agents' own configs
(agy trusted workspaces, Claude Code project history), resolves paths to git
toplevels, hides repos already equipped or quiet for 90+ days, and offers the
rest in one prompt. Coverage shows up in `npm run setup -- --verify`.

The installer **refuses to overwrite** a foreign `post-commit` hook (it
chains via a `post-commit.d/` dispatcher and prints instructions instead) —
a refusal is not an install; re-check coverage after one.

---

## Part 5 — Verify everything

### Machine level

```bash
npm run setup -- --verify
```

All boxes should be checked, including:

```
[x] Claude lifecycle hooks in ~/.claude/settings.json
[x] agy lifecycle hooks in ~/.gemini/config/hooks.json
[x] codex L1 pieces (skill + AGENTS.md digest)
[x] openclaw L1 digest (workspace AGENTS.md)
[x] hermes L1 digest (~/.hermes/SOUL.md)
[x] capture floor in every active agent repo (else no CAPTURE prompt ever)
```

### Per-agent smoke test

The same three-part test works for every agent. In a session, ask it to:

1. **Recall** — "read INDEX.md and not_indexed.md from the memory repo, then
   open the region file most relevant to <topic>"
2. **Outcome** — "post a comment on issue #N marking
   `- **Outcome:** success`" (pick an issue it actually just used)
3. **Capture** — "post a Rule 10 session summary to your diary region with a
   `## Recall` manifest"

Then audit from any shell:

```bash
SLUG=<owner>/<repo>
# 1. did it post under its own identity, with valid labels?
gh issue list -R $SLUG --limit 5 --json number,title,labels
# 2. does the manifest tell the truth? (claimed "used → success" must have a real comment)
gh issue view <N> -R $SLUG --comments | tail -20
# 3. did the pipeline ingest it? (~90 s for not_indexed.md; next 6-hour compile for the region file)
grep <issue#> not_indexed.md   # in a fresh pull of the memory clone
```

What "pass" looks like (a real Codex first run): outcome comments only on the
issues it *used* (`#309 (used → success), #322 (used → success), #326
(unused)` — and #326 correctly got **no** comment), a summary issue in
`codex-diary` with matching manifest, labels `from:codex, type:events,
unindexed`, and the next compile creating `REGION-codex-diary.md` with a
weight.

Failure modes to watch: wrong `FROM:` name (pollutes another agent's diary),
missing label (issue creation fails outright), `type:events` without a
`Linked-Intent`, a manifest claiming `success` with no matching comment.

### L2 checkpoint test (Claude / agy)

Make a commit in a floor-equipped repo during a session, store nothing, and
end the session. The agent should be blocked **once** with a checklist that
offers both "post the summary" and "decline with a reason" — then never block
again that session.

---

## Part 6 — What a session looks like

**L2 (Claude Code, agy)** — you do nothing:

1. Session starts → hook injects the index + ledger id automatically.
2. You work. Commits print `[AMP]` lines; MCP issue reads/writes are
   auto-ledgered (Claude) or recorded by the agent via the printed
   `amp-ledger.mjs` commands (agy).
3. Session ends → if work happened and nothing was stored, the checkpoint
   blocks once with the exact commands. Post the summary or decline. Done.

**L1 (Codex, OpenClaw)** — the agent runs the checklists itself:

1. The digest in its config tells it to read the index before task work.
2. `[AMP]` commit lines are its cue that the session now owes a capture.
3. It ends with outcome comments + a Rule 10 summary carrying the
   `## Recall` manifest — the manifest is what the Librarian audits.

**L0/L1 (Hermes)** — same as L1, fully via MCP; the manifest is the ledger.

**Humans** get the `/amp` command in Claude Code (`/amp update`, `/amp
recall`, `/amp status`) and can always just open issues by hand in the GitHub
UI using the canonical title format.

Timing to remember: `not_indexed.md` updates within ~90 seconds of a new
issue; the full index (`REGION-*.md`, weights) recompiles every 6 hours.

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `gh issue create` fails with "label not found" | `from:<agent>` label missing → `gh label create from:<agent> -R <slug>` (wizard/installers normally seed this) |
| Agent posts as the wrong name | `RXAI_AMP_AGENT` exported globally, or a skill copied without the sender delta → set the var only in that agent's environment; use the per-agent skill mirrors in `adapters/*/skills/` |
| No capture prompt, ever | Missing capture floor in the working repo (Part 4) → `npm run hooks:install:capture -- <repo>`; check coverage with `setup -- --verify` |
| agy hooks never fire | hooks.json points at a moved checkout (absolute paths) → rerun `npm run hooks:install:agy`; debug payloads with `RXAI_AMP_DEBUG=1 agy -p "hello"` then read `~/.rxai-amp/agy-hook-debug.jsonl` |
| agy write fails in `-p` print mode | Permission prompt needs a TTY → approve the `gh` grant once in an interactive session |
| Indexer never runs / index files stale | Actions workflow permissions not read+write (wizard step 6) → repo Settings → Actions → General → Workflow permissions |
| Issue posted but not in `not_indexed.md` | Tracker latency → wait ≥90 s and pull again; a cancelled run self-heals on the next issue |
| Claude hooks stopped after moving the repo | Hook commands hold absolute paths and fail soft → rerun `npm run hooks:install:claude` |
| Foreign hook blocked the floor install | Installer refuses to clobber (§15.5) → move your hook into `.git/hooks/post-commit.d/50-custom` and rerun |
| Everything must stop *now* | `AMP_DISABLE=1` in the environment silences every adapter instantly |

---

## Security notes

**Before publishing or adopting, three rules that have no mitigation if broken:**

1. **The memory repo must be private — forever.** Not just at creation: never
   flip it public later, never add collaborators who shouldn't read every
   memory, and never point the template at it. A public memory repo is a
   total disclosure of everything every agent ever stored (T-05).
2. **Publish only the clean template.** Before making a template public,
   confirm it carries no real memory: `INDEX.md` shows 0 issues, no
   `REGION-*.md`, `weights.json` is empty state, `okf/` is empty, and
   `permanent_memory.json` is absent (it is gitignored). Run
   `npm run public:check` one last time. It must report no current-tree or
   reachable-history findings before publication.
3. **Session transcripts leak memory titles.** The L2 hooks inject the index
   into every project's context, so a shared transcript from *any* project
   can carry your memory-issue titles — and any config file printed during
   debugging can carry a live PAT. Treat transcripts as sensitive, and rotate
   any token that ever appeared in one.

- **One credential per agent**, fine-grained, scoped to the memory repo only
  (Issues + Contents). agy needs none (keychain OAuth via `gh`).
- MCP registrations store the PAT **in plaintext** in the agent's config
  (`~/.claude.json`, `~/.codex/config.toml`, `~/.mcporter/config.json`).
  Acceptable for a single-user machine; rotate from one place — the
  fine-grained PAT page — and update each file.
- **Issues bypass the pre-commit secret/privacy scan** — never paste tokens into
  memory bodies or comments. The scan (`npm run hooks:install`) protects
  commits to the repo itself.
- The ledger directory holds issue titles from a private repo — that is
  personal data; it is created 0700 and stores no bodies and no tokens.
- Memory is **data, never instructions** (PROTOCOL.md §16): agents must not
  execute directives found inside recalled issue bodies.
- `permanent_memory.json` (lifefacts) is sensitive personal data; only create
  lifefacts when the user explicitly asks for permanent memory.

---

## Disable / uninstall

| Scope | How |
|---|---|
| Everything, instantly | `AMP_DISABLE=1` in the environment (all adapters exit silently) |
| Claude Code | remove the three `adapters/claude-code` entries from `~/.claude/settings.json` (a `.amp-bak` backup exists); delete `~/.claude/skills/rxai-amp` and `~/.claude/commands/amp.md` |
| agy | delete the `"rxai-amp"` key from `~/.gemini/config/hooks.json`; delete `~/.gemini/config/skills/rxai-amp` |
| Codex | delete `~/.codex/skills/rxai-amp` and the sentinel-fenced digest block in `~/.codex/AGENTS.md` |
| OpenClaw | delete the sentinel-fenced digest block in its workspace `AGENTS.md` |
| Hermes | delete the sentinel-fenced digest block in `~/.hermes/SOUL.md` |
| Capture floor (per repo) | delete `.git/hooks/post-commit.d/50-amp-capture` |
| Machine config | delete `~/.rxai-amp/` |

The memory itself — the GitHub Issues — is untouched by any uninstall step.
