#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * install-agy-hooks.mjs — Protocol v2.9.1 (adapters/agy, L2)
 *
 * One-command agy (Antigravity CLI) setup:
 *   1. Writes/merges ~/.rxai-amp/config.json (creates missing keys only —
 *      agent_name_default is NOT touched; agy carries its identity in the
 *      hook command's RXAI_AMP_AGENT instead, so one machine can host
 *      several agents).
 *   2. Copies the agy-flavoured rxai-amp skill to
 *      ~/.gemini/config/skills/rxai-amp (agy's global customization root),
 *      so it is available in every workspace.
 *   3. Merges the PreInvocation + Stop hooks into
 *      ~/.gemini/config/hooks.json under the single key "rxai-amp".
 *      Idempotent and chaining: foreign hook names are preserved untouched,
 *      and a backup is written before the first modification.
 *
 * Flags:
 *   --dry-run              print planned changes, write nothing
 *   --repo-path <path>     memory repo clone (default: this checkout)
 *   --repo-slug <o/r>      GitHub slug (default: from `git remote get-url origin`)
 *   --agent <name>         agent identity baked into the hook commands (default: agy)
 *   --config-root <path>   agy customization root (default: ~/.gemini/config)
 *
 * Hook JSON shapes verified against agy's builtin docs
 * (~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md,
 * agy v1.1.10, 2026-08-17).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const memoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes("--dry-run");
const repoPath = path.resolve(flag("--repo-path", memoryRoot));
const agent = flag("--agent", "agy");
const configRoot = path.resolve(flag("--config-root", path.join(homedir(), ".gemini", "config")));

let repoSlug = flag("--repo-slug");
if (!repoSlug) {
  try {
    const url = execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    repoSlug = url.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    repoSlug = null;
  }
}

const plan = [];
function apply(description, fn) {
  plan.push(description);
  if (!DRY) fn();
}

// ---- 1. ~/.rxai-amp/config.json --------------------------------------
const ampHome = process.env.RXAI_AMP_HOME || path.join(homedir(), ".rxai-amp");
const configFile = path.join(ampHome, "config.json");
let config = {};
try {
  config = JSON.parse(readFileSync(configFile, "utf8"));
} catch {
  /* fresh install */
}
const [owner, name] = (repoSlug || "/").split("/");
const mergedConfig = {
  schema: "rxai-amp/config@1",
  ...config,
  memory_repo: {
    ...(repoSlug ? { owner, name } : {}),
    ...(config.memory_repo || {}),
    local_clone: config.memory_repo?.local_clone || repoPath,
  },
  // Deliberately not overwritten: whichever agent installed first owns the
  // machine-wide default; agy passes its own name per hook invocation.
  agent_name_default: config.agent_name_default || agent,
};
apply(`write ${configFile} (merge, existing keys win)`, () => {
  mkdirSync(path.join(ampHome, "sessions"), { recursive: true, mode: 0o700 });
  writeFileSync(configFile, JSON.stringify(mergedConfig, null, 2) + "\n", { mode: 0o600 });
});

// ---- 2. global skill --------------------------------------------------
const skillSrc = path.join(memoryRoot, "adapters", "agy", "skills", "rxai-amp");
const skillDst = path.join(configRoot, "skills", "rxai-amp");
if (existsSync(skillSrc)) {
  apply(`copy skill ${skillSrc} -> ${skillDst} (available in every workspace)`, () => {
    mkdirSync(path.dirname(skillDst), { recursive: true });
    cpSync(skillSrc, skillDst, { recursive: true });
  });
}

// ---- 3. ~/.gemini/config/hooks.json ----------------------------------
const hooksFile = path.join(configRoot, "hooks.json");
let hooks = {};
if (existsSync(hooksFile)) {
  // Malformed hooks.json should fail loudly rather than be clobbered.
  hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
}

const template = JSON.parse(
  readFileSync(path.join(memoryRoot, "adapters", "agy", "hooks.json"), "utf8")
);
const ours = JSON.parse(
  JSON.stringify(template).replaceAll("__AMP_ROOT__", memoryRoot).replaceAll("RXAI_AMP_AGENT=agy", `RXAI_AMP_AGENT=${agent}`)
);
// Chain, never clobber (§15.5): only our own named hook is replaced.
const merged = { ...hooks, ...ours };

apply(`merge PreInvocation/Stop hooks into ${hooksFile} under "rxai-amp" (backup first)`, () => {
  mkdirSync(configRoot, { recursive: true });
  if (existsSync(hooksFile)) cpSync(hooksFile, `${hooksFile}.amp-bak`);
  writeFileSync(hooksFile, JSON.stringify(merged, null, 2) + "\n");
});

// ---- report -----------------------------------------------------------
process.stdout.write((DRY ? "[dry-run] planned:\n" : "done:\n") + plan.map((p) => `  - ${p}`).join("\n") + "\n");
if (!repoSlug) {
  process.stdout.write(
    "note: no repo slug resolved — Stop-hook remote verify disabled until RXAI_AMP_SLUG or config.json memory_repo.owner/name is set\n"
  );
}
process.stdout.write(
  `next: install the commit floor in each repo agy works in — npm run hooks:install:capture -- /path/to/repo\n` +
    `      verify the skill is discovered — agy --print-timeout 90s -p "/skills" | grep rxai-amp\n` +
    "Disable everything anytime with AMP_DISABLE=1; uninstall by deleting the \"rxai-amp\" key from " +
    hooksFile +
    "\n"
);
