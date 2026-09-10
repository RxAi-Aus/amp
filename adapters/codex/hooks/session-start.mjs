#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Codex SessionStart adapter (Protocol v2.9.2 §15, RECALL).
 *
 * Codex and Claude Code use the same stdin fields and both accept plain stdout
 * as model-visible developer context for SessionStart. Keep the tested recall
 * implementation single-sourced and set the Codex identity before loading it.
 */

process.env.RXAI_AMP_AGENT ||= "codex";
process.env.RXAI_AMP_RUNTIME = "codex";
await import("../../claude-code/hooks/session-start.mjs");
