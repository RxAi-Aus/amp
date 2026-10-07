#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Codex SessionStart adapter (Protocol v2.9.2 §15, RECALL).
 *
 * Codex and Claude Code use the same stdin fields and both accept plain stdout
 * as model-visible developer context for SessionStart. Keep the tested recall
 * implementation single-sourced and set the Codex identity before loading it.
 */

import { applyCodexIdentity } from "./identity.mjs";

// codex, or openclaw when OpenClaw started this session on the Codex runtime.
await applyCodexIdentity();
await import("../../claude-code/hooks/session-start.mjs");
