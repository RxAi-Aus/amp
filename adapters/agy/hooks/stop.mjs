#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * stop.mjs — agy Stop hook (Protocol v2.9.1 §15, CAPTURE + OUTCOME)
 *
 * The one enforcement point. agy blocks the stop when this hook prints
 * {"decision":"continue","reason":…}; any other payload lets it stop, so the
 * no-op answer is `{}`. Decision order (§15.5: block at most once, always
 * fail-soft, always offer decline):
 *
 *   1. background work still running / stopped on error → {}
 *   2. AMP disabled / no config / no conversationId      → {}
 *   3. no open ledger for this conversation              → {}  (L2 → L1)
 *   4. already nagged this session                       → {}  (block-once;
 *      agy has no stop_hook_active flag, the ledger IS the re-entry guard)
 *   5. capture discharged, or session not meaningful     → close ledger, {}
 *   6. remote verify: the agent may have posted without recording. One
 *      read of issues since session start via `gh api` (agy's credential
 *      lives in the OS keychain, not the environment), falling back to a
 *      token from the environment. [FROM:<agent> hit → record write, {}.
 *   7. block once: {"decision":"continue","reason":<checklist>}
 *
 * "Meaningful" needs commit boundaries. agy's PostToolUse payload carries no
 * tool arguments, so this adapter deliberately does NOT observe run_command
 * (a PreToolUse observer would have to return a permission decision for every
 * shell command — too invasive for an observer). Boundaries therefore come
 * from the agent-agnostic git floor, which writes them under the per-day key
 * `git-<agent>-<UTCdate>`; this hook merges those recorded after the session
 * started. Install it per working repo:
 *   npm run hooks:install:capture -- /path/to/working/repo
 *
 * Hook JSON shapes (camelCase, stdin→stdout) verified against agy's builtin
 * docs: ~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md
 * (agy v1.1.10, 2026-08-17).
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubToken, readStdinJson, resolveConfig } from "../../lib/amp-config.mjs";
import { closeLedger, loadLedger, markNagged, obligations, recordWrite } from "../../lib/amp-ledger.mjs";
import { debugDump } from "./debug.mjs";

const DEFAULT_AGENT = "agy";
const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../lib");

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(0);
}

/** Let agy stop: any payload without decision:"continue" allows termination. */
function allow() {
  emit({});
}

/** Commit boundaries logged by the git post-commit floor under the day key.
 *  A session can straddle UTC midnight, so both day keys are consulted; the
 *  timestamp filter keeps yesterday's unrelated commits out. */
function floorBoundaries(agent, startedAt) {
  const started = Date.parse(startedAt) || 0;
  const days = new Set(
    [started || Date.now(), Date.now()].map((ms) =>
      new Date(ms).toISOString().slice(0, 10).replace(/-/g, "")
    )
  );
  let count = 0;
  for (const day of days) {
    for (const key of [`git-${agent}-${day}`, `git-shell-${day}`]) {
      const ledger = loadLedger(key);
      if (!ledger) continue;
      count += ledger.capture.boundaries.filter((b) => (Date.parse(b.at) || 0) >= started).length;
    }
  }
  return count;
}

/** Issues touched since `since`, via gh (keychain auth) then a env token. */
async function issuesSince(slug, since) {
  const query = `repos/${slug}/issues?state=all&since=${encodeURIComponent(since)}&per_page=50`;
  try {
    return JSON.parse(execFileSync("gh", ["api", query], { encoding: "utf8", timeout: 8000 }));
  } catch {
    /* gh missing, unauthenticated, or offline → try a token from the env */
  }
  const token = githubToken();
  if (!token) return null;
  const res = await fetch(`https://api.github.com/${query}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "rxai-amp-agy-stop-hook",
    },
    signal: AbortSignal.timeout(8000),
  });
  return res.ok ? await res.json() : null;
}

try {
  const input = await readStdinJson();
  debugDump("Stop", input);

  // Never interrupt a stop the user did not choose, and never nag while
  // background tasks are still producing output.
  if (input.fullyIdle === false) allow();
  if (input.terminationReason === "error" || input.error) allow();

  // See pre-invocation.mjs: agy may report no workspace, so config discovery
  // rests on ~/.rxai-amp/config.json or RXAI_AMP_*.
  const workspace = (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) || process.cwd();
  const config = resolveConfig(workspace);
  if (!config) allow();

  const sessionId = input.conversationId;
  if (!sessionId) allow();

  const ledger = loadLedger(sessionId);
  if (!ledger || ledger.status !== "open") allow();
  if (ledger.capture.nagged) allow();

  const agent = process.env.RXAI_AMP_AGENT || ledger.agent || DEFAULT_AGENT;
  let { discharged, unmarked, fetched, injected } = obligations(ledger);
  const commits = ledger.capture.boundaries.length + floorBoundaries(agent, ledger.started_at);

  if (commits === 0 && fetched.length === 0) {
    // Trivial session: no boundaries and nothing the agent fetched itself —
    // nothing owed (§15.2), close quietly. Memories auto-injected at session
    // start do not count: surfaced-but-unused memories get nothing (§15.1),
    // and only the agent can tell whether it relied on one.
    closeLedger(sessionId);
    allow();
  }

  // Remote verify — the agent may have posted a memory without telling the
  // ledger. Live GitHub is the only authority (Rule 13); the ledger alone
  // cannot prove or disprove a write.
  if (!discharged && config.repoSlug) {
    try {
      const issues = await issuesSince(config.repoSlug, ledger.started_at);
      const mine = Array.isArray(issues)
        ? issues.find(
            (i) => !i.pull_request && typeof i.title === "string" && i.title.startsWith(`[FROM:${agent}`)
          )
        : null;
      if (mine) {
        recordWrite(sessionId, mine.number);
        discharged = true;
      }
    } catch {
      /* offline → fall through to the prompt; never block on network */
    }
  }

  if (discharged) {
    // OUTCOME reminders ride along in the manifest; capture is satisfied.
    closeLedger(sessionId);
    allow();
  }

  // Block once with an actionable checklist.
  markNagged(sessionId);

  const listOf = (entries) => entries.map((s) => `#${s.issue}${s.title ? ` (${s.title})` : ""}`).join(", ");
  const slug = config.repoSlug || config.repoPath;

  const steps = [];
  steps.push(
    `AMP §15 lifecycle checkpoint: this session recorded ${commits} work boundar${commits === 1 ? "y" : "ies"} but no memory write.`
  );
  if (unmarked.length > 0) {
    steps.push(
      `Recalled this session: ${listOf(unmarked)}. For each one you actually relied on, post a comment "- **Outcome:** success|failure" on that issue with: gh issue comment <N> -R ${slug} --body-file <file> (§15.1 OUTCOME; unused ones get nothing).`
    );
  }
  if (injected.length > 0) {
    steps.push(
      `Injected at session start: ${listOf(injected)}. Same rule — an Outcome comment only on the ones you actually relied on; nothing on the rest.`
    );
  }
  steps.push(
    `If meaningful work occurred: use the rxai-amp skill to post a Rule 10 session summary (gh issue create -R ${slug} …) with a "## Recall" manifest (§15.2), then run: node ${path.join(LIB, "amp-ledger.mjs")} write ${sessionId} <issue-number>`
  );
  steps.push(
    `If nothing is worth storing: run node ${path.join(LIB, "amp-ledger.mjs")} decline ${sessionId} "<one-line reason>" — then stop. This is a valid outcome; do not invent a memory.`
  );

  emit({ decision: "continue", reason: steps.join("\n") });
} catch {
  // §15.5 fail-soft: a broken checkpoint must never trap the user in a loop.
  allow();
}
