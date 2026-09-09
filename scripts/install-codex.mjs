#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * install-codex.mjs — Protocol v2.9.1 (adapters/codex, L1)
 *
 * Codex has no lifecycle-hook runtime, so there is nothing to enforce with:
 * L1 means the obligations are carried into context by a skill plus a config
 * digest, and work boundaries come from the agent-agnostic git floor.
 *
 * This installer does the three pieces of that:
 *   1. Writes/merges ~/.rxai-amp/config.json (creates missing keys only;
 *      agent_name_default is left to whichever agent installed first).
 *   2. Copies the codex-flavoured rxai-amp skill to ~/.codex/skills/rxai-amp.
 *   3. Appends the §15 digest to ~/.codex/AGENTS.md between sentinel
 *      comments — replacing only a previous block of ours, never foreign
 *      content (§15.5 chain-never-clobber). A backup is written first.
 * and then makes sure the `from:codex` label exists on the memory repo,
 * because `gh issue create --label` fails on an unknown label.
 *
 * Flags:
 *   --dry-run              print planned changes, write nothing
 *   --repo-path <path>     memory repo clone (default: this checkout)
 *   --repo-slug <o/r>      GitHub slug (default: from `git remote get-url origin`)
 *   --agent <name>         agent identity (default: codex)
 *   --codex-home <path>    Codex config root (default: ~/.codex)
 *   --no-label             skip the from:<agent> label check (no network)
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
const agent = flag("--agent", "codex");
const codexHome = path.resolve(flag("--codex-home", path.join(homedir(), ".codex")));

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
const notes = [];
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

// ---- 2. skill mirror --------------------------------------------------
const skillSrc = path.join(memoryRoot, "adapters", "codex", "skills", "rxai-amp");
const skillDst = path.join(codexHome, "skills", "rxai-amp");
if (existsSync(skillSrc)) {
  apply(`copy skill ${skillSrc} -> ${skillDst}`, () => {
    mkdirSync(path.dirname(skillDst), { recursive: true });
    cpSync(skillSrc, skillDst, { recursive: true });
  });
}

// ---- 3. AGENTS.md digest ---------------------------------------------
const OPEN = "<!-- rxai-amp-digest v1";
const CLOSE = "<!-- /rxai-amp-digest -->";
const digest = readFileSync(path.join(memoryRoot, "adapters", "codex", "digest.md"), "utf8").trim();
const agentsFile = path.join(codexHome, "AGENTS.md");
let existing = "";
if (existsSync(agentsFile)) existing = readFileSync(agentsFile, "utf8");

const start = existing.indexOf(OPEN);
const end = existing.indexOf(CLOSE);
let merged;
if (start > -1 && end > start) {
  // Replace our own previous block, leave everything around it untouched.
  merged = existing.slice(0, start) + digest + existing.slice(end + CLOSE.length);
} else {
  merged = existing.trimEnd() + (existing.trim() ? "\n\n" : "") + digest + "\n";
}
if (merged !== existing) {
  apply(`${start > -1 ? "refresh" : "append"} the §15 digest in ${agentsFile} (backup first)`, () => {
    mkdirSync(codexHome, { recursive: true });
    if (existsSync(agentsFile)) cpSync(agentsFile, `${agentsFile}.amp-bak`);
    writeFileSync(agentsFile, merged);
  });
} else {
  notes.push(`digest in ${agentsFile} already current`);
}

// ---- 4. from:<agent> label -------------------------------------------
if (!process.argv.includes("--no-label") && repoSlug) {
  let labels = null;
  try {
    labels = JSON.parse(
      execFileSync("gh", ["label", "list", "--repo", repoSlug, "--limit", "100", "--json", "name"], {
        encoding: "utf8",
        timeout: 15_000,
      })
    ).map((l) => l.name);
  } catch {
    notes.push(`could not list labels on ${repoSlug} (gh missing/unauthenticated) — create from:${agent} manually`);
  }
  if (labels && !labels.includes(`from:${agent}`)) {
    apply(`create label from:${agent} on ${repoSlug}`, () => {
      try {
        execFileSync(
          "gh",
          ["label", "create", `from:${agent}`, "--repo", repoSlug, "--description", `Issue posted by ${agent}`, "--color", "5319E7"],
          { encoding: "utf8", timeout: 15_000 }
        );
      } catch (err) {
        notes.push(`label create failed: ${String(err.message).slice(0, 120)}`);
      }
    });
  } else if (labels) {
    notes.push(`label from:${agent} already exists`);
  }
}

// ---- report -----------------------------------------------------------
process.stdout.write((DRY ? "[dry-run] planned:\n" : "done:\n") + plan.map((p) => `  - ${p}`).join("\n") + "\n");
for (const n of notes) process.stdout.write(`  note: ${n}\n`);
if (!repoSlug) {
  process.stdout.write("note: no repo slug resolved — set RXAI_AMP_SLUG or config.json memory_repo.owner/name\n");
}
process.stdout.write(
  `next: export RXAI_AMP_AGENT=${agent} in the environment Codex runs under (identity + ledger day key; do NOT set it globally — other agents share this shell)\n` +
    "      install the commit floor in each repo Codex works in — npm run hooks:install:capture -- /path/to/repo\n" +
    "Codex is L1: no hooks fire. The skill + digest are what carry the obligations; AMP_DISABLE=1 switches them off.\n"
);
