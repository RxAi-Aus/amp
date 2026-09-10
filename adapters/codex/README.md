# Codex adapter — L2 lifecycle hooks with L1 fallback

Current Codex releases provide lifecycle hooks. This adapter participates at
conformance L2 (PROTOCOL.md §15.3): hooks inject recall, maintain the ledger,
and interpose the capture checkpoint. The skill, config digest, and portable
git floor remain the fail-soft L1 fallback.

## Install

```bash
npm run hooks:install:codex          # add -- --dry-run to preview
```

| Target | What |
|---|---|
| `~/.rxai-amp/config.json` | memory repo owner/name/clone (existing keys win) |
| `~/.codex/rxai-amp/` | self-contained copy of the zero-dependency hook runtime |
| `~/.codex/hooks.json` | merged `SessionStart`, `PostToolUse`, `Stop`, and `SessionEnd` hooks; foreign hooks preserved |
| `~/.codex/skills/rxai-amp/` | the codex-flavoured skill mirror in `skills/` here |
| `~/.codex/AGENTS.md` | the §15 digest, between `<!-- rxai-amp-digest -->` sentinels |
| memory repo | `from:codex` label, created if missing |

Re-running is idempotent: AMP hook groups are replaced while foreign hook
groups are preserved, the digest block is replaced in place, backups are
written first, and the label check is a no-op once it exists. Open `/hooks` in
Codex after installation and trust the new or changed definitions; Codex skips
non-managed hooks until they are reviewed.

Then one thing the installer cannot do for you:

```bash
# The capture floor, per repo Codex commits from — without it no session
#    ever records a work boundary (see the pattern in adapters/README.md)
npm run hooks:install:capture -- /path/to/working/repo
```

## Mechanisms

| Obligation (§15.1) | Mechanism |
|---|---|
| RECALL | `SessionStart` injects compact INDEX/not-indexed navigation plus repo-matched issue excerpts as developer context; skill/digest is the L1 fallback |
| CAPTURE | `PostToolUse` and the portable git floor record commit boundaries; `Stop` continues once with the capture-or-decline checklist; `SessionEnd` closes the ledger |
| OUTCOME | `PostToolUse` observes issue reads and `Stop` lists recalled issues needing `- **Outcome:** success\|failure`; unused injected memories get nothing |

The `## Recall` manifest in the Rule 10 summary remains the remotely auditable
record (§15.2, §15.6); the local ledger is advisory and never writes memory.

## Skill mirror

`skills/rxai-amp/` is one of the per-agent mirrors. It tracks
`.agents/skills/rxai-amp` byte-for-byte except the codex delta:

- a "Codex specifics" section — identity `codex`, diary Region `codex-diary`,
  repo resolution order, MCP transport with `gh` as the documented fallback,
  and explicit L2-hook/L1-fallback behavior
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
