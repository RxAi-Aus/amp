#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * amp-config.mjs — Protocol v2.9.1 (§15.4, adapters/README.md)
 *
 * Shared configuration discovery for every lifecycle adapter. Zero
 * dependencies, no build step (hooks run in repos where dist/ does not
 * exist — same precedent as scripts/secret-scan.mjs).
 *
 * Resolution precedence:
 *   1. Environment: RXAI_AMP_REPO (local clone path), RXAI_AMP_SLUG
 *      (owner/repo), RXAI_AMP_AGENT, RXAI_AMP_HOME
 *   2. ~/.rxai-amp/config.json  (schema rxai-amp/config@1)
 *   3. Self-detection: cwd is itself the memory repo (PROTOCOL.md naming
 *      "RxAi AMP" + weights.json present)
 *
 * AMP_DISABLE=1 turns every adapter into a silent no-op (§15.5 fail-soft).
 * Callers treat a null resolution the same way: exit 0, never block.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export const CONFIG_SCHEMA = "rxai-amp/config@1";
export const LEDGER_SCHEMA = "rxai-amp/ledger@1";

export function ampHome() {
  return process.env.RXAI_AMP_HOME || path.join(homedir(), ".rxai-amp");
}

export function sessionsDir() {
  return path.join(ampHome(), "sessions");
}

export function configPath() {
  return path.join(ampHome(), "config.json");
}

/** Create the AMP home (0700 — ledger titles are personal data, §15.4). */
export function ensureHome() {
  const dir = sessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readConfigFile() {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* missing or malformed config degrades to lower tiers */
  }
  return null;
}

function looksLikeMemoryRepo(dir) {
  try {
    const protocolPath = path.join(dir, "PROTOCOL.md");
    if (!existsSync(protocolPath) || !existsSync(path.join(dir, "weights.json"))) return false;
    // Only the first KB is needed to find the protocol name.
    const head = readFileSync(protocolPath, "utf8").slice(0, 1024);
    return head.includes("RxAi AMP");
  } catch {
    return false;
  }
}

function slugFromClone(clonePath) {
  try {
    const url = execFileSync("git", ["-C", clonePath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const m = url.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve adapter configuration. Returns null when AMP is disabled or no
 * memory repo can be located — callers MUST exit 0 silently in that case.
 *
 * Shape: { home, repoPath|null, repoSlug|null, agent }
 * (repoPath null is valid: a folderless setup can still ledger + remote-verify.)
 */
export function resolveConfig(cwd = process.cwd()) {
  if (process.env.AMP_DISABLE === "1") return null;

  const file = readConfigFile();
  const fileRepo = file?.memory_repo && typeof file.memory_repo === "object" ? file.memory_repo : {};

  let repoPath = process.env.RXAI_AMP_REPO || fileRepo.local_clone || null;
  let repoSlug =
    process.env.RXAI_AMP_SLUG ||
    (fileRepo.owner && fileRepo.name ? `${fileRepo.owner}/${fileRepo.name}` : null);
  const agent = process.env.RXAI_AMP_AGENT || file?.agent_name_default || "claudecowork";

  if (repoPath) {
    try {
      if (!statSync(repoPath).isDirectory()) repoPath = null;
    } catch {
      repoPath = null;
    }
  }

  // Self-detection: working directly inside the memory repo.
  if (!repoPath && looksLikeMemoryRepo(cwd)) repoPath = cwd;

  if (repoPath && !repoSlug) repoSlug = slugFromClone(repoPath);

  if (!repoPath && !repoSlug) return null;

  return { home: ampHome(), repoPath, repoSlug, agent };
}

/** First token found in the environment, same trio as cache_issues.ts. */
export function githubToken() {
  return (
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    null
  );
}

/** Read all of stdin (hook input JSON). Returns {} on empty/invalid input. */
export async function readStdinJson() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
