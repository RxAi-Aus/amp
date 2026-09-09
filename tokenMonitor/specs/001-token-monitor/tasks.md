# Tasks: AMP Token Monitor

**Input**: Design documents from `/specs/001-token-monitor/`

**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Running tests uses the Node 22 native test runner (`node:test`). Tests are incorporated in each development step.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and configuration structure

- [ ] T001 [P] Create the directory structure for the subproject under `tokenMonitor/` (including `data/`, `public/`, `src/`, `tests/`) and configure `tokenMonitor/data/.gitignore` to ignore the snapshot output `snapshots.ndjson` (CS-1, CS-5)
- [ ] T002 Configure subproject settings and scripts in `tokenMonitor/package.json` with dev dependencies `typescript`, `@types/node` and runtime dependency `gpt-tokenizer` (CS-1, CS-2)
- [ ] T003 [P] Configure compile target `ES2022` and ESM settings in `tokenMonitor/tsconfig.json` (CS-3)
- [ ] T004 Implement configuration file parser, loader, and fallback generator in `tokenMonitor/src/config.ts` (FR-7)
- [ ] T005 [P] Implement configuration unit tests validating default values and parsing errors in `tokenMonitor/tests/config.test.ts`
- [ ] T006 Verify Phase 1 Setup by executing the configuration module tests via `node:test`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core tokenization, directory scanning, and snapshot file writing infrastructure

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T007 Implement multi-model tokenizer calibration wrapper using `gpt-tokenizer` (`o200k_base`) in `tokenMonitor/src/tokenize.ts` (CS-7, FR-1)
- [ ] T008 [P] Implement tokenizer unit tests verifying calibrated token estimation for Claude/Gemini and raw token counts for GPT models in `tokenMonitor/tests/tokenize.test.ts` (SC-001)
- [ ] T009 Implement repository directory walking and filter logic for standard memory documents and local issue caches in `tokenMonitor/src/artifacts.ts` (FR-1)
- [ ] T010 [P] Implement artifacts crawling unit tests under mock filesystems in `tokenMonitor/tests/artifacts.test.ts`
- [ ] T011 Implement append and read utilities for the Newline Delimited JSON snapshots file in `tokenMonitor/src/snapshots.ts` (FR-1, CS-6)
- [ ] T012 Verify Foundational phase components by executing the tokenizer, crawler, and snapshot tests in combination

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Artifact Token Scan & Recall Budget Check CLI (Priority: P1) 🎯 MVP

**Goal**: Run CLI scans of memory artifacts, count tokens per model, compare injection costs against budget limits, and output formatted tables or JSON data.

**Independent Test**: Execute the `scan` command against a mock directory and verify it exits with `0` (or `2` when the budget is exceeded).

### Implementation for User Story 1

- [ ] T013 Implement the CLI text table formatter and delta trend computer in `tokenMonitor/src/report.ts` (FR-2)
- [ ] T014 Implement the primary CLI entrypoint routing commands for `scan` and `report` subcommands in `tokenMonitor/src/cli.ts` (FR-1, FR-2, FR-6)
- [ ] T015 Verify User Story 1 scan behavior by running CLI executions against fixture configurations representing budget verdicts "OK", "WARN", and "OVER" (SC-001, SC-002)

**Checkpoint**: At this point, User Story 1 is fully functional and can act as a CI check or build gatekeeper

---

## Phase 4: User Story 2 - Claude Code Transcript Parsing & Live Session Attribution (Priority: P2)

**Goal**: Parse project `.jsonl` transcript logs to extract session input, output, cache-read, and cache-creation counts, attributing spend to AMP activities.

**Independent Test**: Run `sessions` against a mock project directory containing transcript files and verify efficiency ratios and costs are aggregated correctly.

### Implementation for User Story 2

- [ ] T016 Implement the `.jsonl` stream reader and session filter using AMP memory markers or skill invocations in `tokenMonitor/src/transcripts.ts` (FR-3, A-1)
- [ ] T017 [P] Implement transcript parsing tests validating request aggregation and math efficiency counts in `tokenMonitor/tests/transcripts.test.ts`
- [ ] T018 Integrate the `sessions` command handler into the router in `tokenMonitor/src/cli.ts` (FR-3)
- [ ] T019 Verify User Story 2 sessions output formats, daily grouping aggregations, and model pricing lookups using CLI dry runs (SC-003)

**Checkpoint**: At this point, User Stories 1 and 2 are fully integrated in the CLI utility

---

## Phase 5: User Story 3 - Interactive localhost Dashboard with Watch Mode (Priority: P3)

**Goal**: Serve an offline-first visual cockpit showing metrics, budget, growth trends, session spend, and cache efficiency panels with file watching auto-reload.

**Independent Test**: Launch the server locally and view the five functional panels on port 4173 completely offline.

### Implementation for User Story 3

- [ ] T020 Design and implement a single-file dashboard template with HTML, inline CSS styles, reactive JS, and hand-rolled SVG canvas graphics in `tokenMonitor/public/index.html` (CS-4, FR-5)
- [ ] T021 Implement a native Node.js HTTP server including a file-system watcher (on changes and 5-minute intervals) and Server-Sent Events (SSE) notification logic in `tokenMonitor/src/server.ts` (FR-5)
- [ ] T022 Integrate the `serve` command handler and routing details in `tokenMonitor/src/cli.ts` (FR-5)
- [ ] T023 Verify User Story 3 browser-based dashboard loading, offline state checks, watch mode re-scans, and CSS light/dark transitions (SC-005)

**Checkpoint**: Visual cockpit panels and automatic live refreshing are operational

---

## Phase 6: User Story 4 - Git-History Backfill Time Series (Priority: P4)

**Goal**: Reconstruct token usage timelines by crawling Git commit logs for previous configurations of the memory repository files.

**Independent Test**: Execute the `backfill` command and verify that multiple snapshot data points are added to `data/snapshots.ndjson`.

### Implementation for User Story 4

- [ ] T024 Implement the Git commit walker using `child_process` checkouts and historical date extractions in `tokenMonitor/src/backfill.ts` (FR-4)
- [ ] T025 Integrate the `backfill` command options and since-date filter parsing inside `tokenMonitor/src/cli.ts` (FR-4)
- [ ] T026 Verify User Story 4 backfill walkthrough loops, validation checks on shallow clones, and formatting correctness of output snapshots (SC-004)

**Checkpoint**: All core features are implemented and integrated into the subproject CLI router

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Edge-case validation, documentation updates, and performance checks

- [ ] T027 [P] Create user instructions, configuration guide, and command-line execution parameters in `tokenMonitor/README.md`
- [ ] T028 Implement file lock checks or write-stream guards for `data/snapshots.ndjson` to manage concurrent CLI and watch-mode runs (Edge Cases: Concurrent Writes)
- [ ] T029 Implement error boundary filters to ignore corrupted transcript lines or missing cache directories gracefully (Edge Cases)
- [ ] T030 Perform validation checks to verify that the entire suite runs offline and satisfies SC-001..SC-006 (SC-006)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Base structures must be ready first (T001 - T006).
- **Foundational (Phase 2)**: Core libraries and crawler components depend on Phase 1 setup (T007 - T012).
- **User Stories (Phases 3..6)**:
  - User Story 1 (P1 MVP) implements core scanning command (T013 - T015).
  - User Story 2 (P2 Sessions) requires Foundational logic, parses transcripts (T016 - T019).
  - User Story 3 (P3 Dashboard) feeds on snapshot datasets created in US1 and US2 (T020 - T023).
  - User Story 4 (P4 Backfill) checks out past files to feed the snapshot data model (T024 - T026).
- **Polish (Phase 7)**: Executed after all story modules are complete to harden edge cases and documentation.

### Parallel Opportunities

- Configuration, compilation, and structure setups (`T001`, `T002`, `T003`) can run in parallel.
- Validation unit tests (`T008`, `T010`, `T017`) can be created in parallel with their core implementation modules.
- User documentation (`T027`) can be written alongside implementation.
