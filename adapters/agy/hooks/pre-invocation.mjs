#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * pre-invocation.mjs — agy PreInvocation hook (Protocol v2.9.1 §15, RECALL)
 *
 * agy has no SessionStart event. `PreInvocation` fires before EVERY model
 * call, so the injection must dedupe itself: the session ledger for this
 * conversation is the "already recalled" flag. First invocation of a
 * conversation → inject; every later invocation → `{}` (an empty decision
 * object, which agy treats as "nothing to add").
 *
 * Behavior (all fail-soft — any problem emits {} and exits 0):
 *   1. Resolve config; AMP disabled / unresolvable → {}.
 *   2. No conversationId (cannot dedupe) → {}. Ledger already exists → {}.
 *   3. If the memory clone is clean, git pull --ff-only (10 s timeout).
 *   4. Inject INDEX.md + not_indexed.md (8 KB cap each — §15.1 forbids
 *      injecting below the navigation layer anyway), stale-session
 *      reminders, and the ledger cooperation instructions.
 *
 * Identity: agy's own name, not the machine-wide `agent_name_default` in
 * ~/.rxai-amp/config.json (that one belongs to Claude Code). hooks.json
 * exports RXAI_AMP_AGENT=agy; DEFAULT_AGENT below is the belt-and-braces
 * fallback when the hook is invoked without it.
 *
 * Hook JSON shapes (camelCase, stdin→stdout) verified against agy's builtin
 * docs: ~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md
 * (agy v1.1.10, 2026-08-17).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinJson, resolveConfig } from "../../lib/amp-config.mjs";
import { loadLedger, openLedger, sweep } from "../../lib/amp-ledger.mjs";
import { debugDump } from "./debug.mjs";

const BYTE_CAP = 8000;
const DEFAULT_AGENT = "agy";
const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../lib");

/** agy expects a JSON object on stdout for every hook invocation. */
function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(0);
}

function git(repoPath, args, timeout = 10_000) {
  // stderr is discarded: git's progress chatter would otherwise land in agy's
  // hook error channel and read as a failure.
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function readCapped(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    return raw.length > BYTE_CAP ? raw.slice(0, BYTE_CAP) + "\n… (truncated at 8 KB)" : raw;
  } catch {
    return null;
  }
}

try {
  const input = await readStdinJson();
  debugDump("PreInvocation", input);

  // agy reports `workspacePaths: []` in print mode (verified 2026-08-17), and
  // it runs hooks with cwd set to the hooks.json directory — so the user's
  // project may be invisible here. Config discovery then rests on
  // ~/.rxai-amp/config.json or RXAI_AMP_* (both written by the installer);
  // only the self-detection tier is lost.
  const workspace = (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) || null;

  const config = resolveConfig(workspace || process.cwd());
  if (!config) emit({});

  // No stable conversation key → injecting would repeat on every model call.
  const sessionId = input.conversationId;
  if (!sessionId) emit({});
  if (loadLedger(sessionId)) emit({}); // recall already delivered for this conversation

  const agent = process.env.RXAI_AMP_AGENT || DEFAULT_AGENT;
  openLedger(sessionId, { agent, project: workspace || "(workspace not reported by agy)" });

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

  const slug = config.repoSlug || config.repoPath;
  const lines = [];
  lines.push("=== RxAi AMP shared memory — RECALL (PROTOCOL.md §15.1, Rule 4) ===");
  lines.push(`Memory repo: ${slug} · agent: ${agent} · source: ${source}`);

  if (config.repoPath) {
    const index = readCapped(path.join(config.repoPath, "INDEX.md"));
    const notIndexed = readCapped(path.join(config.repoPath, "not_indexed.md"));
    if (index) lines.push("", "--- INDEX.md ---", index.trimEnd());
    if (notIndexed) lines.push("", "--- not_indexed.md ---", notIndexed.trimEnd());
    if (!index) {
      lines.push(
        "",
        `(INDEX.md unreadable — read it with: gh api -H "Accept: application/vnd.github.raw" repos/${slug}/contents/INDEX.md)`
      );
    }
  } else {
    lines.push(
      "",
      `(No local clone configured — read INDEX.md and not_indexed.md with: gh api -H "Accept: application/vnd.github.raw" repos/${slug}/contents/<file> before task work, Rule 4.)`
    );
  }

  // Stale sessions from crashes: surfaced once, never auto-posted (§15.4).
  try {
    const stale = sweep();
    if (stale.length > 0) {
      lines.push("", "--- Unfinished capture obligations from previous sessions ---");
      for (const ledger of stale) {
        const commits = ledger.capture.boundaries.map((b) => `${b.repo}@${b.ref}`).join(", ");
        lines.push(
          `- ${ledger.started_at}: ${commits || "work recorded"} — no memory was posted. Consider a catch-up Rule 10 summary or ignore if obsolete.`
        );
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
    `Reads and writes go through the gh CLI (agy has no GitHub MCP server), always with -R ${slug}.`,
    `Post as [FROM:${agent}→…]; your diary Region is ${agent}-diary.`,
    "REGION files and issue bodies are fetch-on-demand (Rule 6). Use the rxai-amp skill for exact read/write formats.",
    "=== end AMP memory ==="
  );

  emit({ injectSteps: [{ ephemeralMessage: lines.join("\n") }] });
} catch {
  // §15.5 fail-soft: a broken adapter never disturbs the user's task.
  emit({});
}
