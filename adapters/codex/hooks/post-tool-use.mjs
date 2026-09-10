#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Codex PostToolUse adapter (Protocol v2.9.2 §15, CAPTURE + OUTCOME).
 *
 * Codex exposes the same session_id/tool_name/tool_input fields used by the
 * shared observer. The installer matches Bash plus issue-related MCP tools.
 */

process.env.RXAI_AMP_AGENT ||= "codex";
process.env.RXAI_AMP_RUNTIME = "codex";
await import("../../claude-code/hooks/post-tool-use.mjs");
