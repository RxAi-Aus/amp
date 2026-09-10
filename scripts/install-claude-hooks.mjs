#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * install-claude-hooks.mjs — Protocol v2.9.1 (adapters/claude-code, L2)
 *
 * One-command Claude Code setup:
 *   1. Writes/merges ~/.rxai-amp/config.json (creates missing keys only).
 *   2. Merges the three lifecycle hooks into ~/.claude/settings.json
 *      (user level — fires in EVERY project). Idempotent: entries whose
 *      command path contains "adapters/claude-code/" are replaced; all
 *      other hooks and settings are preserved. A timestamped backup is
 *      written before the first modification.
 *   3. Copies the rxai-amp skill to ~/.claude/skills/rxai-amp so it is
 *      available in every project (the repo copy stays source of truth).
 *   4. Copies the /amp command to ~/.claude/commands/amp.md so the
 *      user-invocable memory entry point works in every project.
 *
 * Flags:
 *   --dry-run              print planned changes, write nothing
 *   --repo-path <path>     memory repo clone (default: this checkout)
 *   --repo-slug <o/r>      GitHub slug (default: from `git remote get-url origin`)
 *   --agent <name>         agent identity (default: claudecowork)
 *   --matcher <regex>      PostToolUse matcher (default: "Bash|mcp__github__.*")
 *
 * Hook JSON shapes verified against code.claude.com/docs/en/hooks (2026-08-01).
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
const agent = flag("--agent", "claudecowork");
const matcher = flag("--matcher", "Bash|mcp__github__.*");

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
  agent_name_default: config.agent_name_default || agent,
};
apply(`write ${configFile} (merge, existing keys win)`, () => {
  mkdirSync(path.join(ampHome, "sessions"), { recursive: true, mode: 0o700 });
  writeFileSync(configFile, JSON.stringify(mergedConfig, null, 2) + "\n", { mode: 0o600 });
});

// ---- 2. ~/.claude/settings.json hooks --------------------------------
const settingsFile = path.join(homedir(), ".claude", "settings.json");
let settings = {};
if (existsSync(settingsFile)) {
  settings = JSON.parse(readFileSync(settingsFile, "utf8")); // malformed settings should fail loudly, not be clobbered
}

const hookCmd = (file) => `node "${path.join(memoryRoot, "adapters", "claude-code", "hooks", file)}"`;
const OURS = /adapters[/\\]claude-code[/\\]/;

const desired = {
  SessionStart: { matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: hookCmd("session-start.mjs") }] },
  Stop: { hooks: [{ type: "command", command: hookCmd("stop.mjs") }] },
  PostToolUse: { matcher, hooks: [{ type: "command", command: hookCmd("post-tool-use.mjs") }] },
};

settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
for (const [event, entry] of Object.entries(desired)) {
  const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const foreign = existing.filter(
    (e) => !e?.hooks?.some((h) => typeof h?.command === "string" && OURS.test(h.command))
  );
  settings.hooks[event] = [...foreign, entry];
}

apply(`merge SessionStart/Stop/PostToolUse hooks into ${settingsFile} (backup first)`, () => {
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  if (existsSync(settingsFile)) {
    cpSync(settingsFile, `${settingsFile}.amp-bak`);
  }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
});

// ---- 3. user-level skill ---------------------------------------------
const skillSrc = path.join(memoryRoot, ".claude", "skills", "rxai-amp");
const skillDst = path.join(homedir(), ".claude", "skills", "rxai-amp");
if (existsSync(skillSrc)) {
  apply(`copy skill ${skillSrc} -> ${skillDst} (available in every project)`, () => {
    mkdirSync(path.dirname(skillDst), { recursive: true });
    cpSync(skillSrc, skillDst, { recursive: true });
  });
}

// ---- 4. user-level /amp command --------------------------------------
const cmdSrc = path.join(memoryRoot, ".claude", "commands", "amp.md");
const cmdDst = path.join(homedir(), ".claude", "commands", "amp.md");
if (existsSync(cmdSrc)) {
  apply(`copy command ${cmdSrc} -> ${cmdDst} (/amp available in every project)`, () => {
    mkdirSync(path.dirname(cmdDst), { recursive: true });
    cpSync(cmdSrc, cmdDst);
  });
}

// ---- report -----------------------------------------------------------
process.stdout.write((DRY ? "[dry-run] planned:\n" : "done:\n") + plan.map((p) => `  - ${p}`).join("\n") + "\n");
if (!repoSlug) {
  process.stdout.write("note: no repo slug resolved — Stop-hook remote verify disabled until RXAI_AMP_SLUG or config.json memory_repo.owner/name is set\n");
}
process.stdout.write("Other agents: npm run hooks:install:agy (L2) · npm run hooks:install:codex (L2) — see adapters/*/README.md\n");
process.stdout.write("Disable everything anytime with AMP_DISABLE=1; uninstall by removing the three hook entries and rerunning nothing.\n");
