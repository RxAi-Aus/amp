#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * user-prompt-submit.mjs — Claude Code UserPromptSubmit hook
 * (Protocol v2.11 §15.1, RECALL — the task-aware stage)
 *
 * SessionStart cannot know the task, so on this runtime it injects the
 * repo's records at the pointer tier only (session-start.mjs). This hook
 * fires on every user prompt (no matcher; plain stdout on exit 0 is added to
 * Claude's context) and expands to the summary tier just the records whose
 * title or Place lexically overlap the prompt — stemmed ASCII tokens minus
 * stopwords and the project's own names, CJK bigrams, explicit `#N` refs
 * (amp-recall.mjs `matchPrompt`). Each record is expanded at most once per
 * session (ledger `tier: "summary"`); a record the agent already fetched
 * itself is never re-injected. A prompt that matches nothing injects
 * nothing: on a task no memory covered, unrelated injected summaries cost
 * 14–17 KB of extra reading per session (measured 2026-09-23).
 *
 * Bodies come from the clone's `.rxai-cache` when fresh (no network), else
 * `gh` — the hook runs inside Claude Code's 30 s UserPromptSubmit budget.
 * Fail-soft: any problem exits 0 with empty stdout. Never writes memory.
 *
 * Hook JSON shape verified against code.claude.com/docs/en/hooks (2026-09-23):
 * stdin { session_id, cwd, hook_event_name: "UserPromptSubmit", prompt, … }.
 */

import { readStdinJson, resolveConfig } from "../../lib/amp-config.mjs";
import { loadLedger, surfaceIssue } from "../../lib/amp-ledger.mjs";
import { buildPromptRecall, debugLog } from "../../lib/amp-recall.mjs";

const input = await readStdinJson();
const config = resolveConfig();
if (!config || !config.repoPath) process.exit(0);

const prompt = typeof input.prompt === "string" ? input.prompt : "";
if (!prompt.trim()) process.exit(0);
const sessionId = typeof input.session_id === "string" ? input.session_id : "";

// Already expanded this session, or fetched by the agent itself: skip.
const exclude = new Set();
try {
  const ledger = sessionId ? loadLedger(sessionId) : null;
  for (const s of ledger?.recall?.surfaced ?? []) {
    if (s.via !== "inject" || s.tier === "summary") exclude.add(s.issue);
  }
} catch {
  /* no ledger: expand freely, ledger below is best-effort */
}

const recall = buildPromptRecall({ cwd: input.cwd || process.cwd(), repoPath: config.repoPath, repoSlug: config.repoSlug, prompt, exclude });
debugLog(`user-prompt-submit cwd=${input.cwd || process.cwd()} repo=${config.repoPath} slug=${config.repoSlug} prompt=${prompt.length}ch exclude=[${[...exclude]}] surfaced=${JSON.stringify(recall.surfaced.map((s) => [s.issue, s.title.slice(0, 24)]))} text=${recall.text.length}B`);
if (!recall.text) process.exit(0);

// Injected at summary tier: still `via: "inject"`, so nothing is owed unless
// the agent relies on it (§15.1 OUTCOME); the tier only prevents a repeat.
if (sessionId) {
  for (const s of recall.surfaced) {
    try { surfaceIssue(sessionId, s.issue, s.title, "inject", "summary"); } catch { /* best-effort */ }
  }
}

process.stdout.write(recall.text + "\n");
