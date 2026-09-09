#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * amp-ledger.mjs — Protocol v2.9.1 (§15.4)
 *
 * Session-ledger state machine shared by every adapter (and by the future
 * L3 MCP server). One JSON file per session under ~/.rxai-amp/sessions/,
 * schema rxai-amp/ledger@1. The ledger is advisory local state: never
 * committed, never authoritative, cannot authorize a write (Rules 3A/13
 * analogue). Stores issue numbers/titles only — never tokens, never bodies.
 *
 * CLI (session id = Claude Code session_id, or any stable per-session key):
 *   amp-ledger.mjs open     <session-id> [--agent <name>] [--project <path>]
 *   amp-ledger.mjs surface  <session-id> <issue-number> [--via agent|inject] [title...]
 *   amp-ledger.mjs boundary <session-id> <repo-name> <sha> [subject...]
 *   amp-ledger.mjs write    <session-id> <issue-number>
 *   amp-ledger.mjs decline  <session-id> <reason...>
 *   amp-ledger.mjs nagged   <session-id>
 *   amp-ledger.mjs close    <session-id>
 *   amp-ledger.mjs status   <session-id>
 *   amp-ledger.mjs sweep
 *
 * Every command is fail-soft for callers: unknown session ids create or
 * no-op rather than erroring, and exit codes are 0 unless the CLI itself
 * is misused. The sweep janitor runs opportunistically from hooks — no
 * daemon, no cron: `closed` > 7 days are deleted; `open` > 48 h become
 * `stale` (surfaced once at next session start, deleted 7 days later).
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LEDGER_SCHEMA, ensureHome, sessionsDir } from "./amp-config.mjs";

const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const DELETE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function ledgerPath(sessionId) {
  // The session id is used as-is in the filename; strip path separators.
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(sessionsDir(), `${safe}.json`);
}

export function loadLedger(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(sessionId), "utf8"));
    if (parsed && parsed.schema === LEDGER_SCHEMA) return parsed;
  } catch {
    /* missing/corrupt → null; callers degrade gracefully */
  }
  return null;
}

export function saveLedger(ledger) {
  ensureHome();
  writeFileSync(ledgerPath(ledger.session_id), JSON.stringify(ledger, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function openLedger(sessionId, { agent = "claudecowork", project = process.cwd() } = {}) {
  const existing = loadLedger(sessionId);
  if (existing) return existing; // idempotent: resume/compact reuse the ledger
  const ledger = {
    schema: LEDGER_SCHEMA,
    session_id: String(sessionId),
    agent,
    project,
    started_at: new Date().toISOString(),
    closed_at: null,
    status: "open", // open | closed | stale
    recall: { surfaced: [] },
    capture: { boundaries: [], writes: [], declined: null, nagged: false },
  };
  saveLedger(ledger);
  return ledger;
}

/** How a recalled issue reached the agent's context (§15.1 RECALL):
 *    "agent"  — the agent fetched it itself (CLI `surface`, MCP issue_read
 *               observer). Candidate for an OUTCOME obligation.
 *    "inject" — an adapter pushed it at session start (repo-aware recall,
 *               #442). Nothing is owed unless the agent relied on it, which
 *               only the agent can judge — so injected entries never count
 *               toward the Stop checkpoint on their own.
 *  Entries written before this field existed carry no `via` and are read as
 *  "agent" (the only path that existed then). */
export const SURFACE_VIA = ["agent", "inject"];

export function surfaceIssue(sessionId, issueNumber, title = "", via = "agent") {
  const ledger = loadLedger(sessionId) || openLedger(sessionId);
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) return ledger;
  const how = SURFACE_VIA.includes(via) ? via : "agent";
  const existing = ledger.recall.surfaced.find((s) => s.issue === n);
  if (!existing) {
    // Titles only, truncated — never bodies, never tokens (§15.4).
    ledger.recall.surfaced.push({
      issue: n,
      title: String(title).slice(0, 200),
      via: how,
      disposition: "unknown",
      outcome_posted: null,
    });
    saveLedger(ledger);
  } else if (how === "agent" && existing.via === "inject") {
    // The agent went and fetched an issue that was only injected: it is now
    // agent-surfaced, and the outcome reminder applies.
    existing.via = "agent";
    saveLedger(ledger);
  }
  return ledger;
}

export function recordBoundary(sessionId, repoName, sha, subject = "") {
  const ledger = loadLedger(sessionId) || openLedger(sessionId);
  ledger.capture.boundaries.push({
    kind: "commit",
    repo: String(repoName).slice(0, 100),
    ref: String(sha).slice(0, 40),
    subject: String(subject).slice(0, 200),
    at: new Date().toISOString(),
  });
  saveLedger(ledger);
  return ledger;
}

export function recordWrite(sessionId, issueNumber) {
  const ledger = loadLedger(sessionId) || openLedger(sessionId);
  const n = Number(issueNumber);
  ledger.capture.writes.push({ issue: Number.isInteger(n) && n > 0 ? n : null, at: new Date().toISOString() });
  saveLedger(ledger);
  return ledger;
}

export function recordDecline(sessionId, reason) {
  const ledger = loadLedger(sessionId) || openLedger(sessionId);
  ledger.capture.declined = { at: new Date().toISOString(), reason: String(reason).slice(0, 300) };
  saveLedger(ledger);
  return ledger;
}

export function markNagged(sessionId) {
  const ledger = loadLedger(sessionId);
  if (!ledger) return null;
  ledger.capture.nagged = true;
  saveLedger(ledger);
  return ledger;
}

export function closeLedger(sessionId) {
  const ledger = loadLedger(sessionId);
  if (!ledger) return null;
  ledger.status = "closed";
  ledger.closed_at = new Date().toISOString();
  saveLedger(ledger);
  return ledger;
}

/** CAPTURE / OUTCOME obligation state.
 *    meaningful — ≥1 work boundary (the §15.1 deterministic floor)
 *    discharged — a write or an explicit decline exists
 *    fetched    — issues the agent surfaced itself (`via` absent or "agent")
 *    injected   — issues an adapter pushed at session start (`via: "inject"`)
 *    unmarked   — fetched issues still without an outcome marker
 *    trivial    — no boundaries and nothing fetched: nothing is owed (§15.2).
 *                 Injected memories alone never make a session non-trivial;
 *                 surfaced-but-unused memories get nothing (§15.1 OUTCOME). */
export function obligations(ledger) {
  const surfaced = ledger.recall.surfaced;
  const fetched = surfaced.filter((s) => s.via !== "inject");
  const injected = surfaced.filter((s) => s.via === "inject");
  const meaningful = ledger.capture.boundaries.length > 0;
  const discharged = ledger.capture.writes.length > 0 || ledger.capture.declined !== null;
  const unmarked = fetched.filter((s) => s.disposition !== "unused" && s.outcome_posted === null);
  const trivial = !meaningful && fetched.length === 0;
  return { meaningful, discharged, unmarked, fetched, injected, trivial };
}

/** Janitor: returns stale open ledgers (once), deletes expired files. */
export function sweep() {
  ensureHome();
  const now = Date.now();
  const staleReminders = [];
  for (const file of readdirSync(sessionsDir())) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(sessionsDir(), file);
    let ledger;
    try {
      ledger = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      rmSync(full, { force: true }); // corrupt → remove
      continue;
    }
    if (ledger.schema !== LEDGER_SCHEMA) continue;
    const started = Date.parse(ledger.started_at) || 0;
    const closed = Date.parse(ledger.closed_at || "") || 0;
    if (ledger.status === "closed" && now - closed > DELETE_AFTER_MS) {
      rmSync(full, { force: true });
    } else if (ledger.status === "open" && now - started > STALE_AFTER_MS) {
      ledger.status = "stale";
      writeFileSync(full, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
      const { meaningful, discharged } = obligations(ledger);
      if (meaningful && !discharged) staleReminders.push(ledger);
    } else if (ledger.status === "stale" && now - started > STALE_AFTER_MS + DELETE_AFTER_MS) {
      rmSync(full, { force: true });
    }
  }
  return staleReminders;
}

// ---------------------------------------------------------------- CLI

function usage() {
  process.stderr.write(
    "usage: amp-ledger.mjs <open|surface|boundary|write|decline|nagged|close|status|sweep> [args]\n"
  );
  process.exit(1);
}

const [, , cmd, ...args] = process.argv;
if (import.meta.url === `file://${process.argv[1]}`) {
  switch (cmd) {
    case "open": {
      const [sessionId] = args;
      if (!sessionId) usage();
      const agentFlag = args.indexOf("--agent");
      const projectFlag = args.indexOf("--project");
      openLedger(sessionId, {
        agent: agentFlag > -1 ? args[agentFlag + 1] : "claudecowork",
        project: projectFlag > -1 ? args[projectFlag + 1] : process.cwd(),
      });
      break;
    }
    case "surface": {
      const [sessionId, issue, ...title] = args;
      if (!sessionId || !issue) usage();
      const viaFlag = title.indexOf("--via");
      const via = viaFlag > -1 ? title.splice(viaFlag, 2)[1] : "agent";
      surfaceIssue(sessionId, issue, title.join(" "), via);
      break;
    }
    case "boundary": {
      const [sessionId, repo, sha, ...subject] = args;
      if (!sessionId || !repo || !sha) usage();
      recordBoundary(sessionId, repo, sha, subject.join(" "));
      break;
    }
    case "write": {
      const [sessionId, issue] = args;
      if (!sessionId) usage();
      recordWrite(sessionId, issue);
      break;
    }
    case "decline": {
      const [sessionId, ...reason] = args;
      if (!sessionId || reason.length === 0) usage();
      recordDecline(sessionId, reason.join(" "));
      break;
    }
    case "nagged": {
      const [sessionId] = args;
      if (!sessionId) usage();
      markNagged(sessionId);
      break;
    }
    case "close": {
      const [sessionId] = args;
      if (!sessionId) usage();
      closeLedger(sessionId);
      break;
    }
    case "status": {
      const [sessionId] = args;
      if (!sessionId) usage();
      const ledger = loadLedger(sessionId);
      process.stdout.write(ledger ? JSON.stringify(ledger, null, 2) + "\n" : "no ledger\n");
      break;
    }
    case "sweep": {
      const reminders = sweep();
      for (const ledger of reminders) {
        process.stdout.write(
          `stale session ${ledger.session_id}: ${ledger.capture.boundaries.length} boundaries, no capture\n`
        );
      }
      break;
    }
    default:
      usage();
  }
}
