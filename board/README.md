# AMP Board

A local five-column task board on top of RxAi AMP memory:

```
Projects  →  Memory issues  →  Waiting  →  Finished  →  Approval
(regions)    (of the region)   agent runs   reviewer     your decision
```

Columns 1–2 are read straight from the memory clone's generated files
(`REGION-*.md`, `okf/`, `not_indexed.md`, `weights.json`) — no GitHub token
needed. Columns 3–5 are board-only state in `~/.rxai-amp/board.json`. The
board never writes memory issues; the agents it launches do, through the
`rxai-amp` skill (`/amp update`), exactly as they would in an interactive
session. Memory content is treated as data throughout (PROTOCOL.md §16).

Zero dependencies, no build step: `node:http` server, plain HTML/CSS/JS
frontend, ESM `.mjs` throughout.

## Run

```bash
npm run board                                   # uses ~/.rxai-amp/config.json (local_clone)
npm run board -- --clone ~/my-agent-memory --port 7345
npm run board -- --concurrency 1 --timeout-min 20
```

Open <http://127.0.0.1:7345>. The server binds loopback only and rejects
any non-loopback `Host` header. Theme follows the OS.

Without a resolvable clone (`--clone`, `RXAI_AMP_REPO`, or the config file)
the server exits 1 with a hint — the board is user-launched, so it fails
loud, unlike the fail-soft lifecycle hooks.

## Workflow

| Column | Status | What happens |
| --- | --- | --- |
| Waiting | `queued` | Created via the form. **Assign** spawns the chosen agent headless; **Delete** removes it. |
| Waiting | `running` | Live log tail from `~/.rxai-amp/board-runs/<runId>.log`. **Cancel** sends SIGTERM (SIGKILL after 5 s) and re-queues. |
| Waiting | `blocked` / `failed` | Agent reported `status:"blocked"`, or exited non-zero / timed out. **Retry** re-queues with history kept. |
| Finished | `finished` | Worker trailer `status:"done"` (or exit 0 with no JSON). Pick a reviewer, **Review**. |
| Finished | `reviewing` | Reviewer agent runs read-only against the task, summary and posted issue. |
| Approval | `approval` | Verdict pill + reviewer notes. **Approve** → Done; **Reject** (with note) → back to Waiting, assignee kept. |

Concurrency is enforced by the server (`settings.concurrency`, default 2):
extra Assign/Review clicks wait as `pendingRun` and start automatically when
a slot frees. On restart, runs whose process is gone are marked failed with
the note "server restarted".

Each project card has a settings popover (⚙): a **working directory**
(agents run inside it; defaults to the clone) and free-form notes. The
header gear holds board settings: concurrency, timeout, default agent, and
`yolo` (skip agent permission prompts — only for trusted directories).

## Agents

| Agent | Command the board runs | Result parsing |
| --- | --- | --- |
| claudecowork | `claude -p <prompt> --output-format json --add-dir <clone> --permission-mode acceptEdits --append-system-prompt <§16 guard>` (`--dangerously-skip-permissions` instead when yolo) | JSON envelope `.result` → last fenced JSON |
| codex | `codex exec -C <cwd> --skip-git-repo-check -s workspace-write --add-dir <clone> -o <log>.last.md <prompt>` (`danger-full-access` when yolo) | `-o` file, then stdout |
| agy | `agy -p <prompt> --output-format json --add-dir <clone> --print-timeout 25m --mode accept-edits` (`--dangerously-skip-permissions` when yolo) | envelope fields or nested text |
| hermes | `hermes -z <prompt>` (`--yolo` when yolo) | stdout tail |
| openclaw | `openclaw agent --local -m <prompt>` — shipped **unverified**, greyed out in the UI | stdout tail |
| fake | `node -e …` — dev only, drives the tests; honours `[fake:blocked]`, `[fake:reject]`, `[fake:exit=N]`, `[fake:sleep=MS]`, `[fake:issue=N]`, `[fake:nojson]` in the task title | stdout tail |

The prompt is one argv element (no shell) and never contains environment
values or board state. The child inherits the environment plus
`RXAI_AMP_AGENT=<agent>` and `AMP_BOARD_TASK=<id>`; only the `CLAUDECODE`
nesting marker is dropped so `claude -p` can start.

Worker trailer: `{"status":"done|blocked","summary":"…","issue":N|null,"notes":"…"}`.
Reviewer trailer: `{"verdict":"approve|reject","notes":"…"}`.

## Pull mode (scheduler)

```bash
npm run board:next -- --agent codex            # claim + run the oldest queued task assigned to codex
npm run board:next -- --agent codex --role reviewer
npm run board:next -- --agent codex --dry-run  # show what would be claimed
npm run board:status                           # per-agent queue counts
```

With the server up, the CLI delegates through `POST /api/pull` (single
runner, SSE stays live) and waits for the outcome; otherwise it runs
standalone under `board.json.lock`. An empty queue prints `nothing to do`
and exits 0 without starting any agent — the poller is deterministic Node,
so idle cost is zero and there is no Rule 14 loop risk. Exit 1 on failure.

```bash
npm run board:schedule -- --agent codex --every 30m [--role reviewer] [--dry-run]
npm run board:schedule -- --agent codex --uninstall
```

writes `~/Library/LaunchAgents/com.rxai.amp.board.<agent>.plist` with a
launchd-safe `PATH` (`~/.local/bin`, `/opt/homebrew/bin`, the node bin dir)
and logs to `~/.rxai-amp/board-runs/schedule-<agent>.log`.

## API

All JSON, loopback only.

| Route | Purpose |
| --- | --- |
| `GET /api/config` | clone, agents (availability), settings, git cleanliness, last compile |
| `GET /api/projects` · `PATCH /api/projects/:region` | region cards with counts and task badges · `{workdir, notes}` |
| `GET /api/projects/:region/issues` | places → types → rows, plus `archived[]`, `unindexed[]` |
| `GET /api/issues/:n` | parsed OKF body (frontmatter, sections, comments, raw) |
| `GET/POST /api/tasks` · `GET/PATCH/DELETE /api/tasks/:id` | CRUD |
| `POST /api/tasks/:id/{assign,review,approve,reject,cancel,retry}` | transitions (409 on an illegal move) |
| `POST /api/pull {agent, role?}` | pull-mode claim |
| `PATCH /api/settings` | concurrency, timeoutMin, defaultAgent, yolo |
| `GET /api/runs/:runId/log?offset=` | `{offset, next, chunk, done}` |
| `GET /api/events` | SSE: `task`, `log`, `memory`, `project`, `settings` |
| `POST /api/refresh` | `git pull --ff-only` + rescan when the clone is clean; `{dirty:true}` otherwise |

## Layout

```
board/
  server.mjs        node:http server, routes, static files
  cli.mjs           pull mode + status
  lib/memory.mjs    parsers for REGION / OKF / not_indexed / weights (pure) + file I/O
  lib/state.mjs     pure reducer, TransitionError, newTask, pickNext
  lib/store.mjs     board.json: atomic write, mtime reload, lock file
  lib/agents.mjs    adapters, prompts, trailer extraction, spawnRun
  lib/runner.mjs    claim → spawn → parse → reduce → save; concurrency, timeout, cancel, recovery
  lib/markdown.mjs  whitelist Markdown renderer, shared with the browser
  lib/http.mjs      json/body/static/SSE helpers, loopback Host guard
  public/           index.html, app.js, styles.css, favicon.svg
scripts/install-board-schedule.mjs
test/board-*.test.mjs  +  test/fixtures/board/clone/
```

Tests: `npm test` (the `board-*` suites cover parsers, reducer, store, markdown
safety, adapters, an HTTP end-to-end run with the fake agent, the CLI in both
modes, and the scheduler plist).
