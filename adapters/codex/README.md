# Codex adapter — L1 (skill + config digest)

Codex has no lifecycle-hook system, so it participates at conformance L1
(PROTOCOL.md §15.3): the obligations are carried into context by a skill and a
config-file digest, and work boundaries come from the agent-agnostic git floor.
Nothing fires automatically — that is the whole difference from L2.

## Install

```bash
npm run hooks:install:codex          # add -- --dry-run to preview
```

| Target | What |
|---|---|
| `~/.rxai-amp/config.json` | memory repo owner/name/clone (existing keys win) |
| `~/.codex/skills/rxai-amp/` | the codex-flavoured skill mirror in `skills/` here |
| `~/.codex/AGENTS.md` | the §15 digest, between `<!-- rxai-amp-digest -->` sentinels |
| memory repo | `from:codex` label, created if missing |

Re-running is idempotent: the digest block is replaced in place (foreign
content around it is never touched, and a `.amp-bak` copy is written first),
and the label check is a no-op once it exists.

Then two things the installer cannot do for you:

```bash
# 1. identity — in the environment Codex runs under, NOT your global profile
#    (other agents share that shell and would inherit the wrong name)
export RXAI_AMP_AGENT=codex

# 2. the capture floor, per repo Codex commits from — without it no session
#    ever records a work boundary (see the pattern in adapters/README.md)
npm run hooks:install:capture -- /path/to/working/repo
```

## Mechanisms

| Obligation (§15.1) | Mechanism |
|---|---|
| RECALL | digest instruction + the skill's session-start checklist; reads go through the `github` MCP server declared in `~/.codex/config.toml` (toolsets `repos,issues`), or a clean `git pull --ff-only` on the clone |
| CAPTURE | the git floor prints `[AMP] commit <sha> logged for memory capture` into Codex's shell output — that is the cue; the session then owes a memory issue or an explicit decline |
| OUTCOME | digest + skill: `- **Outcome:** success\|failure` on every recalled memory that was actually relied on, nothing on unused ones |

Because no checkpoint can block Codex, the `## Recall` manifest in the Rule 10
summary is what makes compliance auditable remotely (§15.2, §15.6).

## Skill mirror

`skills/rxai-amp/` is one of the per-agent mirrors. It tracks
`.agents/skills/rxai-amp` byte-for-byte except the codex delta:

- a "Codex specifics" section — identity `codex`, diary Region `codex-diary`,
  repo resolution order, MCP transport with `gh` as the documented fallback,
  and an explicit "nothing will trigger you, run the checklists yourself"
- the sender in the examples is `codex` (`codex-diary`, `from:codex`), so a
  copied template cannot post into another agent's diary

## Verify

```bash
ls ~/.codex/skills/rxai-amp/SKILL.md
grep -c rxai-amp-digest ~/.codex/AGENTS.md          # 2 sentinels
```

Then, in a Codex session: ask it to read `INDEX.md` from the memory repo and
post an `- **Outcome:**` comment on a recalled issue. Watch that the title it
composes carries `[FROM:codex→…]` and that the labels it passes exist.
