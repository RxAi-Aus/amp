#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Codex Stop adapter (Protocol v2.9.2 §15, CAPTURE + OUTCOME).
 *
 * The tested Claude/Codex Stop wire shape is identical. Codex supplies
 * stop_hook_active and treats {decision:"block",reason} as a continuation.
 */

process.env.RXAI_AMP_AGENT ||= "codex";
process.env.RXAI_AMP_RUNTIME = "codex";
await import("../../claude-code/hooks/stop.mjs");
