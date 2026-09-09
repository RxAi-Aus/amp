#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * install-digest.mjs — Protocol v2.9.1 (adapters/openclaw + adapters/hermes, L1)
 *
 * Digest-only L1 install for agents with no hook runtime and no skill
 * directory of their own. One script, parameterized by --agent, because the
 * two differ only in where their always-loaded instruction file lives:
 *
 *   openclaw → <workspace>/AGENTS.md, workspace read from
 *              ~/.openclaw/openclaw.json (agents.defaults.workspace,
 *              falling back to ~/.openclaw/workspace). OpenClaw reads this
 *              file every session alongside its own memory files.
 *   hermes   → ~/.hermes/SOUL.md — the one file Hermes' prompt builder
 *              always includes from HERMES_HOME ("SOUL.md ... is independent
 *              and always included when present", agent/prompt_builder.py,
 *              verified 2026-08-18).
 *
 * Steps (idempotent; §15.5 chain-never-clobber):
 *   1. Writes/merges ~/.rxai-amp/config.json (creates missing keys only).
 *   2. Splices adapters/<agent>/digest.md into the instruction file between
 *      sentinel comments — replacing only a previous block of ours, never
 *      foreign content. A .amp-bak backup is written first.
 *   3. Ensures the from:<agent> label exists on the memory repo
 *      (`gh issue create --label` fails outright on an unknown label).
 *
 * Codex is NOT handled here — it also ships a skill mirror, so it keeps its
 * own installer (scripts/install-codex.mjs).
 *
 * Flags:
 *   --agent <openclaw|hermes>   required
 *   --dry-run                   print planned changes, write nothing
 *   --repo-path <path>          memory repo clone (default: this checkout)
 *   --repo-slug <o/r>           GitHub slug (default: git remote get-url origin)
 *   --target <path>             override the instruction-file path entirely
 *   --no-label                  skip the label check (no network)
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
const agent = flag("--agent");
const repoPath = path.resolve(flag("--repo-path", memoryRoot));

/** Where each agent's always-loaded instruction file lives. */
function defaultTarget(name) {
  const home = homedir();
  if (name === "openclaw") {
    let workspace = path.join(home, ".openclaw", "workspace");
    try {
      const cfg = JSON.parse(readFileSync(path.join(home, ".openclaw", "openclaw.json"), "utf8"));
      if (typeof cfg?.agents?.defaults?.workspace === "string") workspace = cfg.agents.defaults.workspace;
    } catch {
      /* config unreadable → conventional default */
    }
    return path.join(workspace, "AGENTS.md");
  }
  if (name === "hermes") return path.join(home, ".hermes", "SOUL.md");
  return null;
}

const target = flag("--target", defaultTarget(agent));
if (!agent || !target) {
  process.stderr.write("usage: install-digest.mjs --agent <openclaw|hermes> [--dry-run] [--target <file>]\n");
  process.exit(1);
}
const digestFile = path.join(memoryRoot, "adapters", agent, "digest.md");
if (!existsSync(digestFile)) {
  process.stderr.write(`no digest for agent "${agent}" (expected ${digestFile})\n`);
  process.exit(1);
}

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
  // Whoever installed first owns the machine-wide default; this agent
  // carries its identity via RXAI_AMP_AGENT in its own environment.
  agent_name_default: config.agent_name_default || agent,
};
apply(`write ${configFile} (merge, existing keys win)`, () => {
  mkdirSync(path.join(ampHome, "sessions"), { recursive: true, mode: 0o700 });
  writeFileSync(configFile, JSON.stringify(mergedConfig, null, 2) + "\n", { mode: 0o600 });
});

// ---- 2. digest splice -------------------------------------------------
const OPEN = "<!-- rxai-amp-digest v1";
const CLOSE = "<!-- /rxai-amp-digest -->";
const digest = readFileSync(digestFile, "utf8").trim();
let existing = "";
if (existsSync(target)) existing = readFileSync(target, "utf8");

const start = existing.indexOf(OPEN);
const end = existing.indexOf(CLOSE);
let merged;
if (start > -1 && end > start) {
  merged = existing.slice(0, start) + digest + existing.slice(end + CLOSE.length);
} else {
  merged = existing.trimEnd() + (existing.trim() ? "\n\n" : "") + digest + "\n";
}
if (merged !== existing) {
  apply(`${start > -1 ? "refresh" : "append"} the §15 digest in ${target} (backup first)`, () => {
    mkdirSync(path.dirname(target), { recursive: true });
    if (existsSync(target)) cpSync(target, `${target}.amp-bak`);
    writeFileSync(target, merged);
  });
} else {
  notes.push(`digest in ${target} already current`);
}

// ---- 3. from:<agent> label -------------------------------------------
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
          ["label", "create", `from:${agent}`, "--repo", repoSlug, "--description", `Issue posted by ${agent}`, "--color", "0E8A16"],
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
  `next: export RXAI_AMP_AGENT=${agent} in the environment ${agent} runs under (never globally — other agents share this shell)\n` +
    `      install the commit floor in each repo ${agent} works in — npm run hooks:install:capture -- /path/to/repo\n` +
    `${agent} is L1: nothing fires automatically. The digest carries the obligations; AMP_DISABLE=1 switches them off.\n`
);
