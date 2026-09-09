#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * postinstall-hint.mjs — Protocol v2.9.1
 *
 * `npm install` must never touch anything outside this checkout: an install
 * that writes into ~/.codex or ~/.claude would fire in CI, in Docker builds
 * and on every dependency bump. So this hint READS ONLY. It reports which
 * agents on this machine are missing their AMP wiring and prints the exact
 * command to fix each one; installing remains an explicit act
 * (`npm run setup`, or the per-agent installers).
 *
 * Silent when: CI, AMP_DISABLE=1, nothing installed, or everything wired.
 * Always exits 0 — a hint can never fail an install.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const home = homedir();
const has = (...p) => existsSync(path.join(home, ...p));
const contains = (file, needle) => {
  try { return readFileSync(path.join(home, ...file), "utf8").includes(needle); } catch { return false; }
};

try {
  if (process.env.CI || process.env.AMP_DISABLE === "1") process.exit(0);

  const missing = [];
  if (has(".claude") && !contains([".claude", "settings.json"], "adapters/claude-code"))
    missing.push(["Claude Code (L2)", "npm run hooks:install:claude"]);
  if (has(".gemini", "config") && !contains([".gemini", "config", "hooks.json"], "adapters/agy"))
    missing.push(["agy / Antigravity CLI (L2)", "npm run hooks:install:agy"]);
  if (has(".codex") && !(has(".codex", "skills", "rxai-amp", "SKILL.md") && contains([".codex", "AGENTS.md"], "rxai-amp-digest")))
    missing.push(["Codex (L1)", "npm run hooks:install:codex"]);
  if (has(".openclaw")) {
    // Workspace path may be customized in openclaw.json; conventional default otherwise.
    let ws = [".openclaw", "workspace"];
    try {
      const cfg = JSON.parse(readFileSync(path.join(home, ".openclaw", "openclaw.json"), "utf8"));
      if (typeof cfg?.agents?.defaults?.workspace === "string") ws = [cfg.agents.defaults.workspace.replace(home + "/", "")];
    } catch { /* default */ }
    if (!contains([...ws, "AGENTS.md"], "rxai-amp-digest"))
      missing.push(["OpenClaw (L1)", "npm run hooks:install:openclaw"]);
  }
  if (has(".hermes") && !contains([".hermes", "SOUL.md"], "rxai-amp-digest"))
    missing.push(["Hermes (L1)", "npm run hooks:install:hermes"]);

  if (missing.length === 0) process.exit(0);
  process.stdout.write(
    "\nRxAi AMP — agents found on this machine without memory wiring:\n" +
      missing.map(([label, cmd]) => `  · ${label.padEnd(26)} ${cmd}\n`).join("") +
      "  (full onboarding: npm run setup · coverage: npm run setup -- --verify)\n\n"
  );
} catch {
  /* a hint never fails an install */
}
process.exit(0);
