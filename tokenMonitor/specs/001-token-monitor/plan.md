# Implementation Plan: AMP Token Monitor

**Branch**: `001-token-monitor` | **Date**: 2026-08-08 | **Spec**: [specs/001-token-monitor/spec.md](./spec.md)

**Input**: Feature specification from `specs/001-token-monitor/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

The primary requirement of the AMP Token Monitor is to monitor context token usage across five critical cost centers (C1-C5) in the Agent Memory Protocol (AMP). It offers a command-line interface to scan markdown memory artifacts, calculate and budget token sizes using the `gpt-tokenizer` library (using the `o200k_base` model) with model-specific calibration multipliers, parse local Claude project transcripts (`.jsonl`) to attribute actual session spend and cache ratios, backfill historical snapshot entries from Git history, and host an offline-first visual HTML dashboard. 

The technical approach implements a self-contained TypeScript subproject at `tokenMonitor/` running on Node 22 (ESM). It has zero runtime dependencies besides `gpt-tokenizer`. It exposes subcommands (`scan`, `report`, `sessions`, `backfill`, `serve`) from a single CLI entrypoint (`src/cli.ts`), records historical snapshot trends in a local Git-ignored `data/snapshots.ndjson` file, and hosts a Native Node `http` server serving a single-file visual HTML dashboard with hand-rolled responsive SVG charts and a light/dark mode theme.

## Technical Context

**Language/Version**: Node 22 (ESM), TypeScript (`tsc` target `ES2022`).

**Primary Dependencies**: Runtime: `gpt-tokenizer` (`o200k_base` pure JS vocabulary). Dev: `typescript` compiler, Node native test runner (`node:test`). No external web frameworks, libraries, CDNs, or bundlers are used.

**Storage**: Persistent local configuration is stored in `tokmon.config.json` (auto-generated if missing). Metrics are logged in Newline Delimited JSON format inside `data/snapshots.ndjson` (Git-ignored). The tool operates as read-only toward the memory system.

**Testing**: Node 22 built-in test runner (`node:test` and `node:assert`).

**Target Platform**: Node.js 22 LTS environment, modern web browsers for offline dashboard loading.

**Project Type**: Self-contained CLI subproject with built-in HTTP server.

**Performance Goals**: File scanning completes in < 5 seconds; live file-system watch triggers immediate recalculations and Server-Sent Events (SSE) updates to the dashboard; stream-based reading handles large transcript files efficiently.

**Constraints**:
* **CS-1 (Subproject Isolation)**: Located in the `tokenMonitor/` subdirectory with its own `package.json` and `tsconfig.json`.
* **CS-2 (Zero-Dependency Runtime)**: Limited to `gpt-tokenizer` at runtime.
* **CS-4 (Dashboard Architecture)**: One self-contained `public/index.html` file (inline styles, vanilla JS, custom SVGs for plotting, no third-party CDNs).
* **CS-5 (Data Privacy)**: Read-only toward the memory repository. The `data/` subdirectory is added to `.gitignore`.
* **CS-6 (Standard Timestamps)**: All computed or written timestamps must use UTC ISO 8601 `Z` format.
* **CS-7 (Token Calibration)**: Estimates for Gemini/Claude models are adjusted using a `calibrationRatio` parameter applied to the base `gpt-tokenizer` count.

**Scale/Scope**: Handles repositories with up to thousands of markdown memory documents and large `.jsonl` transcript logs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

No local project constitution is currently defined in the repository. In its absence, this implementation plan aligns with the Spec Kit General Principles:
* **Simplicity**: No nested layers, ORMs, or framework boilerplate. Files are read directly from the filesystem, parsed, and logged to NDJSON.
* **Testability**: Business logic (token count calibration, config loading, and transcript log parsing) is decoupled from CLI IO and HTTP server listeners, allowing direct validation via Node's native test suite.
* **No Speculative Abstraction**: Native Node modules (`node:fs`, `node:path`, `node:http`, `node:child_process`) are used directly rather than introducing generic wrapper packages or complex plugin architectures.

## Project Structure

### Documentation (this feature)

```text
specs/001-token-monitor/
├── plan.md              # This file
├── research.md          # Phase 0 context research and technical feasibility analysis
├── data-model.md        # Data contract schemas for Config, Snapshots, and Sessions
└── quickstart.md        # Developer setup, configuration guide, and command references
```

### Source Code (repository root)

```text
tokenMonitor/
├── data/
│   └── .gitignore           # Prevents committing snapshots.ndjson
├── public/
│   └── index.html           # Unified offline-capable dashboard HTML (styles/scripts/SVGs inline)
├── src/
│   ├── cli.ts               # Subcommand parser & router (scan|report|sessions|backfill|serve)
│   ├── config.ts            # Configuration manager (reads/writes tokmon.config.json defaults)
│   ├── tokenize.ts          # Multi-model token count & calibration engine
│   ├── artifacts.ts         # Walking and counting logic for memory documents and issue caches
│   ├── transcripts.ts       # Claude .jsonl transcript parser & memory marker identifier
│   ├── snapshots.ts         # NDJSON append & lookup reader
│   ├── backfill.ts          # Git history checker using child_process checkout
│   ├── report.ts            # Output table printing and delta trend compiler
│   └── server.ts            # Native node:http server with file-watching/live-reload SSE
├── package.json             # ESM configuration, scripts, and package dependencies
├── tsconfig.json            # ESM compiler directives for tsc
└── tests/                   # Unit and integration test suite using node:test
    ├── artifacts.test.ts    # Tests for local memory repo crawling
    ├── config.test.ts       # Tests for tokmon.config.json validation/generation
    ├── tokenize.test.ts     # Tests for token counts & calibration offsets
    └── transcripts.test.ts  # Tests for .jsonl session logs parsing & attribution
```

**Structure Decision**:
The implementation uses a single, self-contained subproject layout rooted at `tokenMonitor/`. This fulfills the Subproject Isolation constraint (CS-1). The source code is organized within `src/` to house domain modules, and tests are placed in `tests/` leveraging the native Node test runner. The dashboard relies on a single HTML document located at `public/index.html` to prevent external dependency fetches and adhere to CS-4.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*(No violations. No project constitution exists, and the architecture strictly respects the Spec Kit general principles of simplicity and standard libraries.)*
