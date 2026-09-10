#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Codex SessionEnd cleanup (Protocol v2.9.2 §15.4). Always fail-soft. */

import { readStdinJson, resolveConfig } from "../../lib/amp-config.mjs";
import { closeLedger } from "../../lib/amp-ledger.mjs";

process.env.RXAI_AMP_AGENT ||= "codex";
process.env.RXAI_AMP_RUNTIME = "codex";

try {
  const input = await readStdinJson();
  if (resolveConfig() && input.session_id) closeLedger(input.session_id);
} catch {
  /* lifecycle cleanup never breaks the user's session */
}
