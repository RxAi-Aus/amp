#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Codex SessionEnd adapter (Protocol v2.9.2 §15.4): the Claude Code hook
 * under the Codex identity, single-sourced like the other shims. Always
 * fail-soft.
 */

process.env.RXAI_AMP_AGENT ||= "codex";
process.env.RXAI_AMP_RUNTIME = "codex";
await import("../../claude-code/hooks/session-end.mjs");
