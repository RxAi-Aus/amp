// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * debug.mjs — opt-in payload recorder for the agy hooks.
 *
 * `RXAI_AMP_DEBUG=1 agy …` appends every hook payload agy sends to
 * `~/.rxai-amp/agy-hook-debug.jsonl`. That file is the diagnostic for the
 * "hook runtime API drift" failure mode (adapters/README.md): if agy renames
 * or reshapes a field, the recorded payloads say so immediately.
 *
 * Off by default, local-only, never part of a hook's decision.
 */

import { appendFileSync } from "node:fs";
import path from "node:path";
import { ampHome, ensureHome } from "../../lib/amp-config.mjs";

export function debugDump(hook, input) {
  if (process.env.RXAI_AMP_DEBUG !== "1") return;
  try {
    ensureHome();
    appendFileSync(
      path.join(ampHome(), "agy-hook-debug.jsonl"),
      JSON.stringify({
        hook,
        at: new Date().toISOString(),
        cwd: process.cwd(),
        pwd: process.env.PWD ?? null,
        input,
      }) + "\n",
      { mode: 0o600 }
    );
  } catch {
    /* diagnostics never affect the hook's decision */
  }
}
