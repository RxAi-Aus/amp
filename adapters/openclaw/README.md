# OpenClaw adapter — L1 (config digest)

OpenClaw reaches the GitHub MCP server through its `mcporter` skill
(PROTOCOL.md §2). It participates at conformance L1: the §15 obligations ride
in its workspace `AGENTS.md` (read every session alongside OpenClaw's own
memory files), and the git-hook floor covers commit boundaries. OpenClaw has
its own file-based memory system — the digest is written to coexist with it:
AMP memories are GitHub Issues, OpenClaw's `MEMORY.md`/`memory/*.md` stay
untouched.

## Install

```bash
npm run hooks:install:openclaw       # add -- --dry-run to preview
```

| Target | What |
|---|---|
| `~/.rxai-amp/config.json` | memory repo owner/name/clone (existing keys win) |
| `<workspace>/AGENTS.md` | the §15 digest (`digest.md` here), between `<!-- rxai-amp-digest -->` sentinels |
| memory repo | `from:openclaw` label, created if missing |

The workspace path is read from `~/.openclaw/openclaw.json`
(`agents.defaults.workspace`), falling back to `~/.openclaw/workspace`.
Re-running is idempotent: only our sentinel-fenced block is ever replaced,
foreign content is never touched, and a `.amp-bak` backup is written first.
Override the target file with `-- --target /path/to/AGENTS.md`.

Then the pieces an installer cannot own:

1. **MCP path** — enable the `mcporter` skill and register the GitHub server
   in `~/.mcporter/config.json` with OpenClaw's own fine-grained PAT
   (toolsets `repos,issues`; same `npx` block as `adapters/codex/README.md`).
2. **Identity** — `RXAI_AMP_AGENT=openclaw` in OpenClaw's environment
   (never globally — other agents share the shell).
3. **Capture floor** — per working repo:
   `npm run hooks:install:capture -- /path/to/repo`.

Optional: register the memory clone as an OpenClaw **workspace** so it can
read `INDEX.md` locally — unlike Claude/agy it cannot read arbitrary paths.
Without registration everything still works via MCP.

## Mechanisms

| Obligation (§15.1) | Mechanism |
|---|---|
| RECALL | digest instruction, folded into OpenClaw's own session-start memory preamble so both memories load together |
| CAPTURE | the git floor's `[AMP] commit <sha> logged for memory capture` line in shell output is the cue |
| OUTCOME | digest: `- **Outcome:** success\|failure` on used recalled issues, nothing on unused |

No checkpoint can block OpenClaw; the `## Recall` manifest in its Rule 10
summaries is what makes compliance auditable remotely (§15.2, §15.6).

## Verify

```bash
grep -c rxai-amp-digest <workspace>/AGENTS.md    # 2 sentinels
```

Then run the three-part smoke test from `fullInstallation.md` Part 5 and
check the posted title starts `[FROM:openclaw→` with label `from:openclaw`.
