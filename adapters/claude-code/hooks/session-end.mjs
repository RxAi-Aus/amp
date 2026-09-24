#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * session-end.mjs — Claude Code SessionEnd hook (Protocol v2.12 §15.4)
 *
 * Closes the session ledger. Registered without a matcher, so it runs for
 * every reason a session ends (clear, resume, logout, prompt_input_exit,
 * other). It is the only place a ledger is closed: `Stop` fires after every
 * turn and must leave it open (stop.mjs). A session resumed later reopens
 * its ledger at SessionStart (`openLedger`), history intact. The Codex shim
 * (adapters/codex/hooks/session-end.mjs) imports this file.
 *
 * Advisory cleanup only — nothing is posted, nothing is owed here. A ledger
 * that never sees SessionEnd (a crash) goes stale after 48 h and is surfaced
 * once by the janitor (§15.4). Always fail-soft.
 */

import { readStdinJson, resolveConfig } from "../../lib/amp-config.mjs";
import { closeLedger } from "../../lib/amp-ledger.mjs";

try {
  const input = await readStdinJson();
  if (resolveConfig() && input.session_id) closeLedger(input.session_id);
} catch {
  /* lifecycle cleanup never breaks the user's session */
}
