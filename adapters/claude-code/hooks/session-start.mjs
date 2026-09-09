#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * session-start.mjs — Claude Code SessionStart hook (Protocol v2.9.1 §15, RECALL)
 *
 * Registered for matchers startup|resume|clear|compact (the compact matcher
 * means recall survives context compaction). Everything written to stdout is
 * injected into Claude's context.
 *
 * Behavior (all fail-soft — any problem exits 0 with degraded output):
 *   1. Resolve config; AMP disabled / unresolvable → silent exit 0.
 *   2. Open the session ledger (idempotent on resume/compact).
 *   3. If the memory clone is clean, git pull --ff-only (10 s timeout).
 *   4. Inject the navigation layer — INDEX.md + not_indexed.md (8 KB cap
 *      each) — then the repo-aware recall block (amp-recall.mjs, issue
 *      #442): bodies of the top open issues whose Region matches the cwd
 *      project, ledgered as surfaced `via: "inject"` (they never trigger the
 *      Stop checkpoint on their own). When a Region matched, INDEX.md is
 *      rendered around it (matched Regions verbatim, the others as one line)
 *      and an empty not_indexed.md collapses to one line: everything here is
 *      re-read on every turn as part of the cached prefix, so bytes matter.
 *      Then stale-session reminders and the ledger instructions.
 *
 * Hook JSON shapes verified against code.claude.com/docs/en/hooks (2026-08-01).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinJson, resolveConfig } from "../../lib/amp-config.mjs";
import { openLedger, surfaceIssue, sweep } from "../../lib/amp-ledger.mjs";
import { buildRepoRecall, compactIndex, compactNotIndexed } from "../../lib/amp-recall.mjs";

const BYTE_CAP = 8000;
const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../lib");

function git(repoPath, args, timeout = 10_000) {
  return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8", timeout }).trim();
}

function readCapped(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    return raw.length > BYTE_CAP ? raw.slice(0, BYTE_CAP) + "\n… (truncated at 8 KB)" : raw;
  } catch {
    return null;
  }
}

const input = await readStdinJson();
const config = resolveConfig();
if (!config) process.exit(0);

const sessionId = input.session_id || `${config.agent}-${Date.now()}`;
openLedger(sessionId, { agent: config.agent, project: input.cwd || process.cwd() });

let source = "unavailable";
if (config.repoPath) {
  source = "local (possibly stale)";
  try {
    if (git(config.repoPath, ["status", "--porcelain"]) === "") {
      git(config.repoPath, ["pull", "--ff-only", "origin", "main"]);
      source = "pull";
    } else {
      source = "local (dirty worktree — not pulled)";
    }
  } catch {
    /* offline or slow: keep local copy, degrade banner */
  }
}

// Repo-aware recall (issue #442): the open issues whose Region matches this
// project, so the agent does not have to remember to look. Computed first
// because the matched Regions also decide how INDEX.md is rendered below.
// Fail-soft: any problem yields an empty block and the navigation layer
// still stands verbatim.
const recall = config.repoPath
  ? buildRepoRecall({ cwd: input.cwd || process.cwd(), repoPath: config.repoPath, repoSlug: config.repoSlug })
  : { text: "", surfaced: [], regions: [] };

const lines = [];
lines.push("=== RxAi AMP shared memory — RECALL (PROTOCOL.md §15.1, Rule 4) ===");
lines.push(`Memory repo: ${config.repoSlug || config.repoPath} · agent: ${config.agent} · source: ${source}`);

if (config.repoPath) {
  const index = readCapped(path.join(config.repoPath, "INDEX.md"));
  const notIndexed = readCapped(path.join(config.repoPath, "not_indexed.md"));
  if (index) {
    const rendered = recall.regions.length > 0 ? compactIndex(index, recall.regions) : index;
    lines.push("", "--- INDEX.md ---", rendered.trimEnd());
  }
  if (notIndexed) {
    lines.push("", "--- not_indexed.md ---", compactNotIndexed(notIndexed).trimEnd());
  }
  if (!index) {
    lines.push("", "(INDEX.md unreadable — fall back to GitHub MCP get_file_contents, Rule 4.)");
  }
} else {
  lines.push("", "(No local clone configured — read INDEX.md and not_indexed.md via GitHub MCP get_file_contents before task work, Rule 4.)");
}

// Injected issues are ledgered as surfaced via "inject" (§15.1 RECALL): the
// Stop checkpoint ignores them unless the agent fetches one itself, because
// surfaced-but-unused memories owe nothing (§15.1 OUTCOME).
if (recall.text) {
  lines.push("", recall.text);
  for (const s of recall.surfaced) {
    try { surfaceIssue(sessionId, s.issue, s.title, "inject"); } catch { /* ledger is best-effort */ }
  }
}

// Stale sessions from crashes: surfaced once, never auto-posted (§15.4).
try {
  const stale = sweep();
  if (stale.length > 0) {
    lines.push("", "--- Unfinished capture obligations from previous sessions ---");
    for (const ledger of stale) {
      const commits = ledger.capture.boundaries.map((b) => `${b.repo}@${b.ref}`).join(", ");
      lines.push(`- ${ledger.started_at}: ${commits || "work recorded"} — no memory was posted. Consider a catch-up Rule 10 summary or ignore if obsolete.`);
    }
  }
} catch {
  /* janitor is best-effort */
}

lines.push(
  "",
  "--- Session cooperation (§15) ---",
  "This session's ledger id: " + sessionId,
  "When you fetch an AMP issue this session, record it:",
  `  node ${path.join(LIB, "amp-ledger.mjs")} surface ${sessionId} <issue-number> <title>`,
  "After posting any AMP memory (issue or Rule 10 summary):",
  `  node ${path.join(LIB, "amp-ledger.mjs")} write ${sessionId} <issue-number>`,
  "REGION files and issue bodies are fetch-on-demand (Rule 6). Use the rxai-amp skill for exact read/write formats.",
  "=== end AMP memory ==="
);

process.stdout.write(lines.join("\n") + "\n");
