#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * install-codex.mjs — Protocol v2.9.2 (adapters/codex, L2)
 *
 * This installer does the four pieces of the L2 adapter:
 *   1. Writes/merges ~/.rxai-amp/config.json (creates missing keys only;
 *      agent_name_default is left to whichever agent installed first).
 *   2. Copies the zero-dependency hook runtime under ~/.codex/rxai-amp.
 *   3. Merges SessionStart/PostToolUse/Stop/SessionEnd into hooks.json.
 *   4. Copies the codex-flavoured rxai-amp skill to ~/.codex/skills/rxai-amp.
 *   5. Appends the §15 digest to ~/.codex/AGENTS.md between sentinel
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

function shellArg(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
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

// ---- 2. self-contained hook runtime ----------------------------------
const runtimeRoot = path.join(codexHome, "rxai-amp");
apply(`copy hook runtime into ${runtimeRoot}`, () => {
  mkdirSync(runtimeRoot, { recursive: true });
  cpSync(path.join(memoryRoot, "adapters"), path.join(runtimeRoot, "adapters"), { recursive: true });
});

// ---- 3. ~/.codex/hooks.json ------------------------------------------
const hooksFile = path.join(codexHome, "hooks.json");
let hooksConfig = {};
if (existsSync(hooksFile)) {
  // Malformed hook config must fail loudly rather than be clobbered.
  hooksConfig = JSON.parse(readFileSync(hooksFile, "utf8"));
}
hooksConfig.hooks = hooksConfig.hooks && typeof hooksConfig.hooks === "object" ? hooksConfig.hooks : {};

const hookCmd = (file) =>
  `/usr/bin/env RXAI_AMP_AGENT=${shellArg(agent)} node ${shellArg(path.join(runtimeRoot, "adapters", "codex", "hooks", file))}`;
const OURS = /adapters[/\\]codex[/\\]hooks[/\\]/;
const desiredHooks = {
  SessionStart: {
    matcher: "startup|resume|clear|compact",
    hooks: [{ type: "command", command: hookCmd("session-start.mjs"), timeout: 30, statusMessage: "Loading AMP memory", additionalContextLimit: 2500 }],
  },
  PostToolUse: {
    matcher: "Bash|mcp__.*issue.*",
    hooks: [{ type: "command", command: hookCmd("post-tool-use.mjs"), timeout: 15 }],
  },
  Stop: {
    hooks: [{ type: "command", command: hookCmd("stop.mjs"), timeout: 30 }],
  },
  SessionEnd: {
    hooks: [{ type: "command", command: hookCmd("session-end.mjs"), timeout: 3 }],
  },
};

for (const [event, entry] of Object.entries(desiredHooks)) {
  const existingHooks = Array.isArray(hooksConfig.hooks[event]) ? hooksConfig.hooks[event] : [];
  const foreign = existingHooks.filter(
    (group) => !group?.hooks?.some((hook) => typeof hook?.command === "string" && OURS.test(hook.command))
  );
  hooksConfig.hooks[event] = [...foreign, entry];
}

apply(`merge AMP lifecycle hooks into ${hooksFile} (backup first)`, () => {
  mkdirSync(codexHome, { recursive: true });
  if (existsSync(hooksFile)) cpSync(hooksFile, `${hooksFile}.amp-bak`);
  writeFileSync(hooksFile, JSON.stringify(hooksConfig, null, 2) + "\n");
});

// ---- 4. skill mirror --------------------------------------------------
const skillSrc = path.join(memoryRoot, "adapters", "codex", "skills", "rxai-amp");
const skillDst = path.join(codexHome, "skills", "rxai-amp");
if (existsSync(skillSrc)) {
  apply(`copy skill ${skillSrc} -> ${skillDst}`, () => {
    mkdirSync(path.dirname(skillDst), { recursive: true });
    cpSync(skillSrc, skillDst, { recursive: true });
  });
}

// ---- 5. AGENTS.md digest ---------------------------------------------
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

// ---- 6. from:<agent> label -------------------------------------------
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
  "next: open /hooks in Codex and trust the new or changed AMP definitions; Codex will skip non-managed hooks until reviewed.\n" +
    "      install the commit floor in each repo Codex works in — npm run hooks:install:capture -- /path/to/repo\n" +
    "Codex is L2 after hook trust; the skill + digest remain the L1 fallback. AMP_DISABLE=1 switches AMP off.\n"
);
