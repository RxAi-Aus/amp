# Hermes adapter — L1 (SOUL.md digest, folderless-friendly)

Hermes ([hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com/docs))
is folderless in the typical setup: no repo checkout, no shell hooks —
everything through its native MCP client (PROTOCOL.md §2). With the digest
installed it conforms at L1; without it, L0 (prose) still works because the
§15 obligations are defined by observable behavior, not mechanism.

## Install

```bash
npm run hooks:install:hermes         # add -- --dry-run to preview
```

| Target | What |
|---|---|
| `~/.rxai-amp/config.json` | memory repo owner/name/clone (existing keys win) |
| `~/.hermes/SOUL.md` | the §15 digest (`digest.md` here), between `<!-- rxai-amp-digest -->` sentinels |
| memory repo | `from:hermes` label, created if missing |

`SOUL.md` is the injection point because it is the one file Hermes' prompt
builder **always** includes from `HERMES_HOME` — project context files
(`.hermes.md` → `AGENTS.md` → `CLAUDE.md`, first match wins) load only from
the cwd. Re-running is idempotent: only our sentinel-fenced block is ever
replaced, the rest of your SOUL.md persona is never touched, and a `.amp-bak`
backup is written first.

Then, per environment Hermes runs in: `RXAI_AMP_AGENT=hermes` (never
globally), and its own fine-grained PAT in the MCP server registration.

## The folderless contract

Every session, digest-driven:

- **RECALL** via MCP `get_file_contents` on `INDEX.md` + `not_indexed.md`
- **CAPTURE** as a memory issue or an explicit decline in the Rule 10 summary
- **OUTCOME** comments on used memories, nothing on unused ones
- the `## Recall` manifest (§15.2) in the summary — folderless, **the
  manifest IS the ledger**, and it is what the AMP Librarian audits

## Local checkout option (clone anywhere)

Hermes' default **local** terminal backend runs on the host, so a checkout in
any convenient directory works: start `hermes` inside the memory clone and
its context-file discovery auto-loads that repo's `AGENTS.md` on top of the
SOUL.md digest. With shell access the agent-agnostic capture floor applies to
Hermes' working repos too: `npm run hooks:install:capture -- /path/to/repo`.

## Container backends (Docker / Singularity)

If Hermes runs its terminal in a container backend, the host filesystem is
not visible: files live in the sandbox's `/workspace`, and with the default
`docker_mount_cwd_to_workspace: false` the cwd is not mounted in. The SOUL.md
digest still loads (it comes from HERMES_HOME, not the cwd) — so either mount
the checkout into the sandbox workspace, or simply stay on the folderless MCP
path, which works identically from inside a container.
