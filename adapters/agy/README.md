# agy adapter — L2 (lifecycle hooks)

`agy` is Google's Antigravity CLI. It has a customization system (skills,
rules, plugins, hooks) and a lifecycle-hook runtime, so it participates at
conformance **L2** (PROTOCOL.md §15.3) — the same level as Claude Code, with
two differences that shape this adapter:

1. **No GitHub MCP server.** agy reaches GitHub through the **`gh` CLI**
   (credential in the OS keychain, not the environment). PROTOCOL.md §2 makes
   the transport non-normative; the write path — GitHub Issues, canonical
   title/body — is unchanged.
2. **No SessionStart event.** The closest trigger is `PreInvocation`, which
   fires before *every* model call, so the recall injection dedupes itself on
   the session ledger.

## Install

```bash
npm run hooks:install:agy            # add -- --dry-run to preview
```

That writes three things:

| Target | What |
|---|---|
| `~/.rxai-amp/config.json` | memory repo owner/name/clone (existing keys win) |
| `~/.gemini/config/skills/rxai-amp/` | the agy-flavoured skill mirror in `skills/` here |
| `~/.gemini/config/hooks.json` | `PreInvocation` + `Stop` under the single key `rxai-amp` |

`~/.gemini/config/` is agy's **global customization root** (workspace-level is
`.agents/` in a project — which is why this repo's own `.agents/skills/rxai-amp`
is already visible to agy when it works inside the memory repo). `~/.agy/` is
*not* a customization root; it only holds a hook script for gemini-cli, a
different product with a different hook format.

Then install the commit floor in each repo agy commits from — it is what makes
a session "meaningful" (see below):

```bash
npm run hooks:install:capture -- /path/to/working/repo
```

Verify:

```bash
agy --print-timeout 90s -p "/skills" | grep rxai-amp
```

## Mechanisms

| Obligation (§15.1) | Hook | Behavior |
|---|---|---|
| RECALL | `PreInvocation` | First invocation of a conversation only (the ledger is the flag): `git pull --ff-only` when the clone is clean, then inject INDEX.md + not_indexed.md (8 KB cap each), stale-session reminders, and the ledger commands as an `ephemeralMessage`. Every later invocation returns `{}` — otherwise the whole index would be re-injected on every turn. |
| CAPTURE | `Stop` | Blocks the stop **once** with `{"decision":"continue","reason":…}` when the session did meaningful work and no memory was written; always offers the decline path. `ledger.capture.nagged` is the re-entry guard (agy has no `stop_hook_active` flag). |
| OUTCOME | `Stop` checklist | Lists recalled issues with no outcome yet, with the `gh issue comment` form. |

**Identity.** The hook commands export `RXAI_AMP_AGENT=agy`, so ledger entries
and the Stop hook's remote verify look for `[FROM:agy`. The machine-wide
`agent_name_default` in `~/.rxai-amp/config.json` belongs to whichever agent
installed first (usually `claudecowork`) and is deliberately left alone — one
machine, several agents, one shared brain.

**Remote verify.** The Stop hook re-checks GitHub before nagging: issues
updated since session start, first via `gh api` (keychain auth), falling back
to `GH_TOKEN`/`GITHUB_TOKEN` from the environment. A `[FROM:agy` title found
there discharges the obligation — the agent posted without telling the ledger.

## Diagnosing hook-contract drift

```bash
RXAI_AMP_DEBUG=1 agy -p "hello"
tail -1 ~/.rxai-amp/agy-hook-debug.jsonl
```

Every payload agy sends is appended verbatim (plus the hook's `cwd`/`PWD`).
Off by default; the recorder never influences a hook's decision.

## Deliberate non-goals

- **No `PreToolUse` observer.** Detecting `gh issue create` / `git commit` from
  the tool stream would mean registering a `PreToolUse` hook on `run_command`,
  and that contract *requires* a permission decision (`allow` / `deny` / `ask`)
  for every shell command agy runs. An observer must not sit in the permission
  path, so boundaries come from the git floor instead. (agy's `PostToolUse`
  payload carries only `stepIdx` and `error` — no tool arguments — so the
  passive route Claude Code uses is not available here.)
- **No autonomous writes.** As everywhere in `adapters/`, hooks inject, detect,
  prompt and gate; only the agent composes and posts memory (§15.5).

## Failure modes

| Failure | Behavior |
|---|---|
| No `conversationId` in the hook payload | recall/checkpoint skip silently (nothing to dedupe or key on) |
| No `workspacePaths` in the payload | agy sends `workspacePaths: []` in print mode and runs hooks with cwd set to the hooks.json directory, so the user's project can be invisible. Config discovery falls back to `~/.rxai-amp/config.json` / `RXAI_AMP_*` (both written by the installer); only self-detection is lost, and the ledger records the project as `(workspace not reported by agy)` |
| GitHub unreachable at PreInvocation | inject the local copy with a `source: local (possibly stale)` banner |
| `gh` missing / unauthenticated at Stop | remote verify falls back to an env token, then to prompting; never blocks on network |
| Stop hook throws | `{}` — agy stops normally; a broken checkpoint must never trap the user |
| Memory checkout moved | hook commands hold absolute paths; node exits non-zero, agy proceeds — rerun the installer to repair |
| `AMP_DISABLE=1` | every hook is a no-op |

## Skill mirror

`skills/rxai-amp/` is the third mirror of the skill (after `.claude/skills/`
and `.agents/skills/`). It is byte-identical to `.agents/skills/rxai-amp`
except for the agy delta, which is intentional and must be preserved when the
source skill changes:

- frontmatter: "Teaches the agy CLI … `gh` CLI" instead of "Teaches Codex … MCP"
- an "agy specifics" section: identity `agy`, repo resolution order, `gh`
  instead of MCP, no §15 hook signals to wait for
- both MCP tool tables restated as `gh` command tables
- examples use `agy` as the sender (`agy-diary`, `from:agy`)

The `from:agy` label must exist in the memory repo before the first write:

```bash
gh label create from:agy -R <owner>/<repo> --description "Issue posted by agy (Antigravity CLI)"
```
