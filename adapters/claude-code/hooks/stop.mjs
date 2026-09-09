#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * stop.mjs — Claude Code Stop hook (Protocol v2.9.1 §15, CAPTURE + OUTCOME)
 *
 * The one enforcement point. Decision order (§15.5: block at most once,
 * always fail-soft, always offer decline):
 *
 *   1. stop_hook_active true          → exit 0  (runtime re-entry guard)
 *   2. AMP disabled / no config       → exit 0
 *   3. no ledger for this session     → exit 0  (L2 not initialised → L1)
 *   4. already nagged this session    → exit 0  (block-once)
 *   5. capture discharged (write/decline) or session not meaningful
 *      (no boundaries)                → close ledger, exit 0
 *   6. remote verify: agent may have posted without recording — one
 *      GET /repos/<slug>/issues?since=<started>. [FROM:<agent> title hit
 *      → record write, close, exit 0. Network failure → fall through.
 *   7. block once: {"decision":"block","reason":<checklist>}
 *
 * Hook JSON shapes verified against code.claude.com/docs/en/hooks (2026-08-01).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubToken, readStdinJson, resolveConfig } from "../../lib/amp-config.mjs";
import { closeLedger, loadLedger, markNagged, obligations, recordWrite, saveLedger } from "../../lib/amp-ledger.mjs";

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../lib");

const input = await readStdinJson();
if (input.stop_hook_active === true) process.exit(0);

const config = resolveConfig();
if (!config) process.exit(0);

const sessionId = input.session_id;
if (!sessionId) process.exit(0);

const ledger = loadLedger(sessionId);
if (!ledger || ledger.status !== "open") process.exit(0);
if (ledger.capture.nagged) process.exit(0);

let { discharged, unmarked, injected, trivial } = obligations(ledger);

if (trivial) {
  // Trivial session: no boundaries and nothing the agent fetched itself —
  // nothing owed (§15.2), close quietly. Memories auto-injected at session
  // start do not count: surfaced-but-unused memories get nothing (§15.1),
  // and only the agent can tell whether it relied on one.
  closeLedger(sessionId);
  process.exit(0);
}

// Remote verify — the agent may have posted a memory without telling the
// ledger. Live GitHub is the only authority (Rule 13); the ledger alone
// cannot prove or disprove a write.
if (!discharged && config.repoSlug && githubToken()) {
  try {
    const since = encodeURIComponent(ledger.started_at);
    const res = await fetch(
      `https://api.github.com/repos/${config.repoSlug}/issues?state=all&since=${since}&per_page=50`,
      {
        headers: {
          Authorization: `Bearer ${githubToken()}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "rxai-amp-stop-hook",
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (res.ok) {
      const issues = await res.json();
      const mine = Array.isArray(issues)
        ? issues.find((i) => !i.pull_request && typeof i.title === "string" && i.title.startsWith(`[FROM:${config.agent}`))
        : null;
      if (mine) {
        recordWrite(sessionId, mine.number);
        discharged = true;
      }
    }
  } catch {
    /* offline → fall through to the prompt; never block on network */
  }
}

if (discharged) {
  // OUTCOME reminders ride along in the manifest; capture is satisfied.
  closeLedger(sessionId);
  process.exit(0);
}

// Block once with an actionable checklist.
markNagged(sessionId);

const listOf = (entries) => entries.map((s) => `#${s.issue}${s.title ? ` (${s.title})` : ""}`).join(", ");
const commits = ledger.capture.boundaries.length;

const steps = [];
steps.push(
  `AMP §15 lifecycle checkpoint: this session recorded ${commits} work boundar${commits === 1 ? "y" : "ies"} but no memory write.`
);
if (unmarked.length > 0) {
  steps.push(
    `Recalled this session: ${listOf(unmarked)}. For each one you actually relied on, post a comment "- **Outcome:** success|failure" on that issue (§15.1 OUTCOME; unused ones get nothing).`
  );
}
if (injected.length > 0) {
  steps.push(
    `Injected at session start: ${listOf(injected)}. Same rule — an Outcome comment only on the ones you actually relied on; nothing on the rest.`
  );
}
steps.push(
  `If meaningful work occurred: use the rxai-amp skill to post a Rule 10 session summary with a "## Recall" manifest (§15.2), then run: node ${path.join(LIB, "amp-ledger.mjs")} write ${sessionId} <issue-number>`
);
steps.push(
  `If nothing is worth storing: run node ${path.join(LIB, "amp-ledger.mjs")} decline ${sessionId} "<one-line reason>" — then stop. This is a valid outcome; do not invent a memory.`
);

process.stdout.write(JSON.stringify({ decision: "block", reason: steps.join("\n") }) + "\n");
