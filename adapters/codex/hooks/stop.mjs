#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Codex Stop adapter (Protocol v2.9.2 §15, CAPTURE + OUTCOME).
 *
 * The tested Claude/Codex Stop wire shape is identical. Codex supplies
 * stop_hook_active and treats {decision:"block",reason} as a continuation.
 */

import { applyCodexIdentity } from "./identity.mjs";

// codex, or openclaw when OpenClaw started this session on the Codex runtime.
await applyCodexIdentity();
await import("../../claude-code/hooks/stop.mjs");
