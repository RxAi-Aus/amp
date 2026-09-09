#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * post-tool-use.mjs — Claude Code PostToolUse hook (Protocol v2.9.1 §15)
 *
 * Passive observer that keeps the session ledger honest without relying on
 * the agent remembering the CLI. Matcher (installer default): Bash and the
 * GitHub MCP tools (server alias varies — see install-claude-hooks.mjs
 * --matcher).
 *
 *   Bash `git commit` succeeded            → capture boundary
 *   MCP issue create/write with [FROM: title → capture write
 *   MCP issue read/get                      → recall surface
 *
 * Always exits 0; observation failures never disturb the session (§15.5).
 */

import { readStdinJson, resolveConfig } from "../../lib/amp-config.mjs";
import { recordBoundary, recordWrite, surfaceIssue } from "../../lib/amp-ledger.mjs";

/**
 * `git` + zero or more global options + `commit` as its own word.
 * Global options that take a separate value (-C <path>, -c <k=v>,
 * --git-dir <p>, --work-tree <p>, --namespace <n>) are consumed with it;
 * any other -x / --xx flag is consumed alone.
 */
const GIT_COMMIT_RE =
  /\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)\s+\S+\s+|-\S+\s+)*commit(?![\w-])/;

const input = await readStdinJson();
const config = resolveConfig();
if (!config) process.exit(0);

const sessionId = input.session_id;
if (!sessionId) process.exit(0);

const toolName = String(input.tool_name || "");
const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};

try {
  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    // Boundary floor (§15.1): a commit created during the session. Only a
    // real `git [global-options] commit` invocation counts: `git` must be a
    // whole token (so `cat adapters/git-hooks/post-commit` is not a commit),
    // value-taking global options are skipped with their value, and `commit`
    // must be the subcommand itself (not `commit-tree`, not `log --grep
    // commit`). False negatives are fine (the git-hook floor and the agent's
    // own judgment also feed the ledger).
    if (GIT_COMMIT_RE.test(command) && !/--dry-run/.test(command)) {
      const repo = String(input.cwd || process.cwd()).split("/").filter(Boolean).pop() || "repo";
      recordBoundary(sessionId, repo, "bash", command.slice(0, 120));
    }
  } else if (/issue/i.test(toolName)) {
    const title = String(toolInput.title || "");
    const issueNumber = toolInput.issue_number ?? toolInput.issueNumber ?? toolInput.number;
    if (/(create|write|open)/i.test(toolName) && title.startsWith("[FROM:")) {
      recordWrite(sessionId, issueNumber);
    } else if (/(read|get)/i.test(toolName) && issueNumber != null) {
      surfaceIssue(sessionId, issueNumber, title);
    }
  }
} catch {
  /* observers never fail the tool call */
}

process.exit(0);
