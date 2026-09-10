#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * setup.mjs — Protocol v2.9.1 one-command onboarding wizard.
 *
 * `npm run setup` takes a fresh clone of the AMP template to a fully working
 * memory repo: GitHub repo creation, Actions permissions, label seeding,
 * workflow secrets, PAT storage, MCP registration, lifecycle hook installs
 * (delegated to the existing installers), and an end-to-end first compile.
 *
 * §15.5 installer contract: idempotent (every step probes live state first;
 * re-running is the resume mechanism), fail-soft (optional steps warn and
 * land in a final todo block; required steps stop with the exact manual
 * fallback), chain-never-clobber (inherited from the delegated installers),
 * dry-run end to end, and no secrets ever persisted by this script itself.
 *
 * Flags:
 *   --dry-run                 print the full plan, mutate nothing
 *   --yes                     non-interactive defaults (human-only steps → todo)
 *   --verify                  run the verification checklist only
 *   --repo <owner/name>       target repo slug (skips prompts)
 *   --agent <name>            agent identity (default claudecowork)
 *   --visibility <private|public>   default private
 *   --no-test-issue           skip the canonical end-to-end test issue
 *   --skip <id,id> / --only <id,id>  step selection (ids printed in output)
 */

import { spawnSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync,
  readdirSync, chmodSync, appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_SLUGS = ["RxAi-Aus/AgentMemory"];
const KEYCHAIN_SERVICE = "rxai-amp-gh-token";

// ---------------------------------------------------------------- helpers --

function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const DRY = has("--dry-run");
const YES = has("--yes");
const AGENT = flag("--agent", "claudecowork");
const VISIBILITY = flag("--visibility", "private") === "public" ? "public" : "private";

const info = (m) => process.stdout.write(`     ${m}\n`);
const ok = (m) => process.stdout.write(`[ok]   ${m}\n`);
const warn = (m) => process.stdout.write(`[warn] ${m}\n`);
const fail = (m) => process.stdout.write(`[FAIL] ${m}\n`);
const banner = (m) => process.stdout.write(`\n== ${m} ==\n`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    input: opts.input,
    encoding: "utf8",
    stdio: opts.inherit ? ["inherit", "inherit", "inherit"] : undefined,
    timeout: opts.timeoutMs || 300000,
  });
  const okRes = r.status === 0;
  if (!okRes && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${(r.stderr || "").slice(0, 400)}`);
  }
  return { ok: okRes, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), code: r.status };
}

const gh = (args, opts = {}) => run("gh", args, { allowFail: true, ...opts });

function ghJson(args) {
  const r = gh(args);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** Announce + execute (or just announce under --dry-run). */
function apply(desc, fn) {
  if (DRY) { info(`[dry-run] would: ${desc}`); return null; }
  info(desc);
  return fn();
}

async function ask(question, def = "") {
  if (YES) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(def ? `${question} [${def}]: ` : `${question}: `)).trim();
    return a || def;
  } finally { rl.close(); }
}

async function confirm(question, def = true) {
  if (YES) return def;
  const a = (await ask(`${question} ${def ? "[Y/n]" : "[y/N]"}`, "")).toLowerCase();
  if (!a) return def;
  return a.startsWith("y");
}

/** Masked paste for tokens. Returns "" when skipped or non-interactive. */
function askHidden(question) {
  if (YES || !process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    process.stdout.write(question);
    const chars = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (buf) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(chars.join("").trim());
          return;
        }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") { chars.pop(); continue; }
        chars.push(ch);
      }
    };
    process.stdin.on("data", onData);
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, { attempts = 6, delayMs = 5000, label = "" } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false && v !== null) return v;
    } catch (e) { lastErr = e; }
    if (i < attempts - 1) await sleepMs(delayMs);
  }
  if (lastErr) throw lastErr;
  return null;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// ------------------------------------------------------------ shared state --

const ctx = {
  owner: null, name: null, slug: null,
  mode: "create",            // "create" | "adopt"
  templateOrigin: false,
  originSlug: null,
  patToken: null,            // memory only — never persisted by this script
  todo: [],
  createDeferred: false,     // repo creation runs in stepPush
};

const remoteFileRaw = (file) =>
  gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${ctx.slug}/contents/${file}`]);

// ------------------------------------------------------------------- steps --

const stepPreflight = {
  id: "preflight", title: "Preflight checks", required: true,
  async run() {
    const checks = [
      ["git", () => run("git", ["--version"], { allowFail: true }).ok, "install Xcode CLT / git"],
      ["node >= 22", () => Number(process.versions.node.split(".")[0]) >= 22, "install Node 22 LTS (nodejs.org)"],
      ["gh CLI", () => run("gh", ["--version"], { allowFail: true }).ok, "brew install gh"],
      ["gh auth", () => gh(["auth", "status"]).ok, "gh auth login"],
    ];
    for (const [label, probe, fix] of checks) {
      if (probe()) ok(label);
      else { fail(`${label} — fix: ${fix}`); throw new Error(`preflight: ${label}`); }
    }
    const npmMajor = Number(run("npm", ["--version"], { allowFail: true }).stdout.split(".")[0] || 0);
    if (npmMajor < 10) warn(`npm ${npmMajor} < 10 — continuing, but README recommends npm 10+`);
  },
  verify: () => run("git", ["--version"], { allowFail: true }).ok
    && Number(process.versions.node.split(".")[0]) >= 22
    && gh(["auth", "status"]).ok,
};

const stepResolveRepo = {
  id: "resolve-repo", title: "Resolve target memory repo", required: true,
  async run() {
    const originUrl = run("git", ["remote", "get-url", "origin"], { allowFail: true }).stdout;
    ctx.originSlug = originUrl.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/)?.[1] ?? null;
    ctx.templateOrigin = TEMPLATE_SLUGS.includes(ctx.originSlug);

    let target = flag("--repo");
    if (target && !/^[\w.-]+\/[\w.-]+$/.test(target)) throw new Error(`--repo must be owner/name, got: ${target}`);

    if (!target) {
      if (ctx.originSlug && !ctx.templateOrigin && gh(["api", `repos/${ctx.originSlug}`]).ok) {
        const adopt = await confirm(`Origin is ${ctx.originSlug} — use it as the memory repo?`, true);
        if (adopt) target = ctx.originSlug;
      }
      if (!target) {
        const login = gh(["api", "user", "--jq", ".login"]).stdout || "";
        const name = await ask("New memory repo name", "agent-memory");
        const owner = await ask("Owner (user or org)", login);
        target = `${owner}/${name}`;
      }
    }
    if (TEMPLATE_SLUGS.includes(target)) {
      throw new Error(`target ${target} is the RxAi template — your memory repo must be a NEW repo`);
    }

    [ctx.owner, ctx.name] = target.split("/");
    ctx.slug = target;
    if (gh(["api", `repos/${ctx.slug}`]).ok) {
      ctx.mode = "adopt";
      ok(`adopt mode: ${ctx.slug} already exists on GitHub`);
    } else {
      ctx.mode = "create";
      ctx.createDeferred = true;
      ok(`create mode: will create ${VISIBILITY} repo ${ctx.slug}`);
    }
  },
  verify: () => Boolean(ctx.slug),
};

const stepBuild = {
  id: "build", title: "npm install + build", required: true,
  async run() {
    apply("npm install", () => run("npm", ["install"], { inherit: true }));
    apply("npm run build (tsc → dist/)", () => run("npm", ["run", "build"], { inherit: true }));
  },
  verify: () => DRY || existsSync(path.join(ROOT, "dist", "compile_index.js")),
};

function repoLooksLive() {
  const issues = ghJson(["api", `repos/${ctx.slug}/issues?state=all&per_page=1`]);
  if (Array.isArray(issues) && issues.length > 0) return true;
  const idx = remoteFileRaw("INDEX.md");
  if (idx.ok) {
    const m = idx.stdout.match(/\*\*Total Issues Indexed:\*\*\s*(\d+)/);
    if (m && Number(m[1]) > 0) return true;
  }
  return false;
}

const stepSeedReset = {
  id: "seed-reset", title: "Reset compiled state for a fresh brain", required: false,
  async run() {
    if (ctx.mode !== "create") { info("adopt mode — seed reset skipped (never reset an existing repo)"); return; }
    if (!(await confirm("Reset compiled index state (INDEX.md / not_indexed.md / weights.json)?", true))) return;

    const t = nowIso();
    apply("write empty-state INDEX.md / not_indexed.md / weights.json", () => {
      writeFileSync(path.join(ROOT, "INDEX.md"),
        `# Agent Memory Index\n\n**Last Compiled:** ${t}  \n**Compiled By:** index-scheduler workflow  \n**Total Issues Indexed:** 0  \n**Next Scheduled Compile:** approximately 6 hours from above timestamp  \n\n---\n`);
      writeFileSync(path.join(ROOT, "not_indexed.md"),
        `# Not Yet Indexed\n\n**Since Last Index Compile:** ${t}\n**Last Updated:** ${t}\n**Unindexed Issue Count:** 0\n\n| Issue | From | Region | Place | Type | Posted |\n|-------|------|------|------|------|--------|\n`);
      writeFileSync(path.join(ROOT, "weights.json"), `{\n  "_last_compile_iso": "${t}"\n}\n`);
      for (const f of readdirSync(ROOT)) if (/^REGION-.*\.md$/.test(f)) rmSync(path.join(ROOT, f));
    });

    const cla = path.join(ROOT, ".github", "workflows", "cla.yml");
    if (existsSync(cla) && (await confirm("Remove upstream-only cla.yml (RxAi contributor workflow)?", true))) {
      apply("remove .github/workflows/cla.yml", () => rmSync(cla));
    }

    if (!DRY && run("git", ["status", "--porcelain"], { allowFail: true }).stdout) {
      apply("commit: setup: reset generated state for fresh memory repo", () =>
        run("git", ["commit", "-am", "setup: reset generated state for fresh memory repo"], { allowFail: false }));
    }
  },
  verify: () => true,
};

const stepPush = {
  id: "push", title: "Create remote and push", required: true,
  async run() {
    if (ctx.createDeferred) {
      apply(`gh repo create ${ctx.slug} --${VISIBILITY}`, () => {
        const r = gh(["repo", "create", ctx.slug, `--${VISIBILITY}`]);
        if (!r.ok && !/already exists/i.test(r.stderr)) throw new Error(`gh repo create: ${r.stderr}`);
      });
      apply("point origin at the new repo (template origin kept as 'template')", () => {
        if (ctx.templateOrigin) run("git", ["remote", "rename", "origin", "template"], { allowFail: true });
        else if (ctx.originSlug) run("git", ["remote", "remove", "origin"], { allowFail: true });
        run("git", ["remote", "add", "origin", `https://github.com/${ctx.slug}.git`], { allowFail: true });
      });
    }
    const branch = run("git", ["branch", "--show-current"], { allowFail: true }).stdout || "main";
    if (branch !== "main") apply("rename branch to main", () => run("git", ["branch", "-M", "main"]));
    apply(`git push -u origin main → ${ctx.slug}`, () => run("git", ["push", "-u", "origin", "main"], { inherit: true }));
  },
  verify: () => DRY || remoteFileRaw("PROTOCOL.md").ok,
};

const stepActionsPerms = {
  id: "actions-perms", title: "Actions workflow permissions (read+write)", required: true,
  async run() {
    if (DRY) { info("[dry-run] would: ensure Actions enabled + default_workflow_permissions=write"); return; }
    const enabled = gh(["api", `repos/${ctx.slug}/actions/permissions`, "--jq", ".enabled"]).stdout;
    if (enabled !== "true") {
      const r = gh(["api", "-X", "PUT", `repos/${ctx.slug}/actions/permissions`, "-F", "enabled=true", "-f", "allowed_actions=all"]);
      if (!r.ok) throw new Error(`cannot enable Actions: ${r.stderr}\nManual: https://github.com/${ctx.slug}/settings/actions`);
    }
    const current = gh(["api", `repos/${ctx.slug}/actions/permissions/workflow`, "--jq", ".default_workflow_permissions"]).stdout;
    if (current === "write") { ok("workflow permissions already read+write"); return; }
    const r = gh(["api", "-X", "PUT", `repos/${ctx.slug}/actions/permissions/workflow`,
      "-f", "default_workflow_permissions=write", "-F", "can_approve_pull_request_reviews=false"]);
    const after = gh(["api", `repos/${ctx.slug}/actions/permissions/workflow`, "--jq", ".default_workflow_permissions"]).stdout;
    if (!r.ok || after !== "write") {
      throw new Error(`could not set workflow permissions (org policy?).\nManual (the #1 reason setup fails): https://github.com/${ctx.slug}/settings/actions → Workflow permissions → Read and write → Save`);
    }
    ok("workflow permissions set to read+write");
  },
  verify: () => DRY ||
    gh(["api", `repos/${ctx.slug}/actions/permissions/workflow`, "--jq", ".default_workflow_permissions"]).stdout === "write",
};

const LABELS = [
  ["from:openclaw", "1D76DB", "Issue posted by openclaw"],
  ["from:claudecowork", "5319E7", "Issue posted by claudecowork"],
  ["type:intent", "0E8A16", "goal / planned action"],
  ["type:facts", "006B75", "durable fact"],
  ["type:events", "FBCA04", "timeline event"],
  ["type:discovery", "D93F0B", "new finding"],
  ["type:pattern", "0075CA", "reusable pattern"],
  ["type:invalidation", "B60205", "supersedes a prior issue"],
  ["type:lifefact", "6F42C1", "permanent, decay-exempt (v2.4)"],
  ["unindexed", "F9D0C4", "not yet compiled into INDEX.md"],
  ["archived", "CFD3D7", "weight < 0.10"],
];

const stepLabels = {
  id: "labels", title: "Seed issue labels (PROTOCOL.md §6)", required: false,
  async run() {
    const wanted = [...LABELS];
    if (!wanted.some(([n]) => n === `from:${AGENT}`)) wanted.push([`from:${AGENT}`, "0052CC", `Issue posted by ${AGENT}`]);
    if (DRY) { info(`[dry-run] would: create up to ${wanted.length} labels on ${ctx.slug}`); return; }
    const existing = new Set((ghJson(["label", "list", "--repo", ctx.slug, "--json", "name", "--limit", "100"]) || []).map((l) => l.name));
    let created = 0;
    for (const [name, color, description] of wanted) {
      if (existing.has(name)) continue;
      const r = gh(["api", "-X", "POST", `repos/${ctx.slug}/labels`, "-f", `name=${name}`, "-f", `color=${color}`, "-f", `description=${description}`]);
      if (r.ok || /already_exists/.test(r.stderr + r.stdout)) created++;
      else warn(`label ${name}: ${r.stderr.slice(0, 120)}`);
    }
    ok(`labels ready (${existing.size} existed, ${created} created) — without these, /amp's gh issue create --label fails silently into unlabeled issues`);
  },
  verify: () => {
    if (DRY) return true;
    const names = new Set((ghJson(["label", "list", "--repo", ctx.slug, "--json", "name", "--limit", "100"]) || []).map((l) => l.name));
    return names.has("unindexed") && names.has("type:intent");
  },
};

const stepRepoWorkflows = {
  id: "repo-workflows", title: "Workflow secrets & upstream-only workflows", required: false,
  async run() {
    if (DRY) { info("[dry-run] would: librarian secret/disable choice, cla.yml disable, BigQuery notice"); return; }
    await retry(() => {
      const list = ghJson(["workflow", "list", "--repo", ctx.slug, "--json", "name,path,state"]);
      return list && list.some((w) => w.path.endsWith("index-scheduler.yml"));
    }, { attempts: 8, delayMs: 5000 }).catch(() => warn("workflows not yet registered — continuing"));

    info("AMP Librarian (daily Copilot audit) needs repo secret PERSONAL_ACCESS_TOKEN (Copilot subscription).");
    info("Unset secret = one red Actions run per day.");
    const choice = YES ? "d" : (await ask("Librarian: [s]et secret / [d]isable workflow / s[k]ip", "d")).toLowerCase();
    if (choice.startsWith("s")) {
      info("Create a fine-grained PAT on your PERSONAL account with Account permissions → Copilot Requests (README §Librarian).");
      const token = await askHidden("Paste Copilot PAT (input hidden, Enter to skip): ");
      if (token) {
        const r = gh(["secret", "set", "PERSONAL_ACCESS_TOKEN", "--repo", ctx.slug, "--body-file", "-"], { input: token });
        if (r.ok) ok("secret PERSONAL_ACCESS_TOKEN set");
        else { warn(`secret set failed: ${r.stderr.slice(0, 120)}`); ctx.todo.push(`gh secret set PERSONAL_ACCESS_TOKEN --repo ${ctx.slug}`); }
      } else ctx.todo.push(`gh secret set PERSONAL_ACCESS_TOKEN --repo ${ctx.slug}  # or: gh workflow disable amp-librarian.yml --repo ${ctx.slug}`);
    } else if (choice.startsWith("d")) {
      const wfs = ghJson(["workflow", "list", "--repo", ctx.slug, "--all", "--json", "path,state"]) || [];
      const lib = wfs.find((w) => w.path.endsWith("amp-librarian.yml"));
      if (lib && lib.state !== "active") ok("amp-librarian.yml already disabled");
      else {
        const r = await retry(() => gh(["workflow", "disable", "amp-librarian.yml", "--repo", ctx.slug]).ok, { attempts: 4, delayMs: 5000 }).catch(() => false);
        if (r) ok("amp-librarian.yml disabled (re-enable: gh workflow enable amp-librarian.yml)");
        else { warn("could not disable amp-librarian.yml yet"); ctx.todo.push(`gh workflow disable amp-librarian.yml --repo ${ctx.slug}`); }
      }
    } else {
      ctx.todo.push(`Librarian left unconfigured: set PERSONAL_ACCESS_TOKEN secret or disable amp-librarian.yml`);
    }

    if (gh(["api", `repos/${ctx.slug}/contents/.github/workflows/cla.yml`]).ok
        && (await confirm("Disable upstream-only cla.yml workflow?", true))) {
      if (gh(["workflow", "disable", "cla.yml", "--repo", ctx.slug]).ok) ok("cla.yml disabled");
      else ctx.todo.push(`gh workflow disable cla.yml --repo ${ctx.slug}`);
    }
    info("BigQuery/OKF export self-skips until secret GCP_SA_KEY + vars BQ_PROJECT/BQ_DATASET are set (README §OKF).");
  },
  verify: () => true,
};

function keychainHasToken() {
  return process.platform === "darwin"
    ? run("security", ["find-generic-password", "-a", process.env.USER || "", "-s", KEYCHAIN_SERVICE], { allowFail: true }).ok
    : new RegExp(["(^|\\n)GH_", "TOKEN", "="].join("")).test(existsSync(path.join(ROOT, ".env")) ? readFileSync(path.join(ROOT, ".env"), "utf8") : "");
}

const stepPat = {
  id: "pat", title: "Fine-grained PAT for agents", required: false,
  async run() {
    if (keychainHasToken()) { ok("agent token already stored"); return; }
    if (YES || DRY) {
      ctx.todo.push(`Create a fine-grained PAT (Contents:R, Issues:RW, Metadata:R, only ${ctx.slug}) at https://github.com/settings/personal-access-tokens/new — then store it: macOS \`security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -U -w <token>\` or .env GH_TOKEN=`);
      info("PAT step queued to todo (needs the browser)");
      return;
    }
    info(`Create a fine-grained PAT: https://github.com/settings/personal-access-tokens/new`);
    info(`  Repository access: Only select repositories → ${ctx.slug}`);
    info("  Permissions: Contents Read-only · Issues Read and write · Metadata Read-only · 90-day expiry");
    let token = await askHidden("Paste token (input hidden, Enter to skip): ");
    for (let attempt = 0; token && attempt < 2; attempt++) {
      const h = { Authorization: `Bearer ${token}`, "User-Agent": "rxai-amp-setup" };
      const a = await fetch(`https://api.github.com/repos/${ctx.slug}`, { headers: h });
      const b = await fetch(`https://api.github.com/repos/${ctx.slug}/issues?per_page=1`, { headers: h });
      if (a.ok && b.ok) { ok("token validated (Contents:R, Issues:R at minimum)"); break; }
      warn(`token failed validation (repo ${a.status}, issues ${b.status})`);
      token = attempt === 0 ? await askHidden("Paste corrected token (Enter to skip): ") : "";
    }
    if (!token) { ctx.todo.push("Agent PAT not stored — see README Step 5/6"); return; }
    ctx.patToken = token;
    if (process.platform === "darwin") {
      // Token passes through argv once; acceptable single-user trade-off (see plan §9).
      apply("store token in macOS Keychain (service rxai-amp-gh-token)", () =>
        run("security", ["add-generic-password", "-a", process.env.USER || "", "-s", KEYCHAIN_SERVICE, "-U", "-w", token]));
    } else {
      apply("store token in repo-root .env (chmod 600, gitignored)", () => {
        const envPath = path.join(ROOT, ".env");
        const pairs = [["GH_TOKEN", token], ["REPO_OWNER", ctx.owner], ["REPO_NAME", ctx.name]];
        appendFileSync(envPath, pairs.map(([k, v]) => [k, v].join("=")).join("\n") + "\n");
        chmodSync(envPath, 0o600);
      });
    }
  },
  verify: () => keychainHasToken(),
};

const stepMcp = {
  id: "mcp", title: "GitHub MCP registration per agent", required: false,
  async run() {
    const hasClaude = run("claude", ["--version"], { allowFail: true, timeoutMs: 15000 }).ok;
    // The wizard registers the npx fallback because it cannot assume Docker.
    // PROTOCOL.md §2 (v2.9) documents the official ghcr.io/github/github-mcp-server
    // Docker image as the primary configuration — upgrade when Docker is available.
    const mcpCmd = `claude mcp add github --scope user -e GITHUB_PERSONAL_ACCESS_TOKEN=<token> -- npx -y @modelcontextprotocol/server-github`;
    if (hasClaude) {
      const already = run("claude", ["mcp", "get", "github"], { allowFail: true, timeoutMs: 20000 }).ok;
      if (already) ok("Claude Code: github MCP server already registered");
      else if (DRY) info(`[dry-run] would: ${mcpCmd}`);
      else if (await confirm("Register github MCP server for Claude Code (user scope)?", true)) {
        let token = ctx.patToken;
        if (!token && process.platform === "darwin") {
          token = run("security", ["find-generic-password", "-a", process.env.USER || "", "-s", KEYCHAIN_SERVICE, "-w"], { allowFail: true }).stdout;
        }
        if (!token) { ctx.todo.push(mcpCmd); warn("no token available — MCP registration queued to todo"); }
        else {
          const r = run("claude", ["mcp", "add", "github", "--scope", "user",
            "-e", `GITHUB_PERSONAL_ACCESS_TOKEN=${token}`, "--",
            "npx", "-y", "@modelcontextprotocol/server-github"], { allowFail: true, timeoutMs: 30000 });
          if (r.ok) ok("Claude Code: github MCP registered (note: token lands in ~/.claude.json plaintext)");
          else { warn(`claude mcp add failed: ${r.stderr.slice(0, 120)}`); ctx.todo.push(mcpCmd); }
        }
      }
    } else {
      ctx.todo.push(mcpCmd + "   # once Claude Code CLI is installed");
    }

    const detected = detectAgents().filter((a) => a.id !== "claudecowork").map((a) => a.id);
    if (YES || DRY) { info(`other agents detected: ${detected.join(", ") || "none"} — see adapters/*/README.md`); return; }
    const others = (await ask(
      `Set up other agents? (detected: ${detected.join(",") || "none"}; comma list, Enter to accept, "none" to skip)`,
      detected.join(","),
    )).toLowerCase();
    // agy needs no MCP server at all (§2: gh CLI transport) — its whole
    // setup is the delegated installer in the lifecycle step below.
    if (others.includes("agy")) info("agy: run `npm run hooks:install:agy` (offered in the lifecycle step) — no MCP registration needed, it uses the gh CLI");
    if (others.includes("codex")) {
      // Delegated installer (L1: skill mirror + AGENTS.md digest + label).
      const args = ["scripts/install-codex.mjs", "--repo-path", ROOT, "--repo-slug", ctx.slug, "--agent", "codex"];
      if (DRY) args.push("--dry-run");
      run("node", args, { inherit: true, allowFail: true });
      info("still yours to do: export RXAI_AMP_AGENT=codex in the environment Codex runs under, and keep the github MCP entry in ~/.codex/config.toml");
    }
    if (others.includes("openclaw")) info("openclaw: follow adapters/openclaw/README.md (mcporter + digest + RXAI_AMP_AGENT=openclaw)");
    if (others.includes("hermes")) info("hermes: L0/L1 — optional digest per adapters/hermes/README.md");
  },
  verify: () => true,
};

/**
 * Which agents exist on this machine. Probes config roots rather than PATH:
 * `codex` is a shell function here and `agy` lives in ~/.local/bin, so a
 * spawn test would report false negatives for both.
 */
function detectAgents() {
  const home = homedir();
  return [
    { id: "claudecowork", label: "Claude Code", root: path.join(home, ".claude"), installer: "scripts/install-claude-hooks.mjs", level: "L2" },
    { id: "agy", label: "agy / Antigravity CLI", root: path.join(home, ".gemini", "config"), installer: "scripts/install-agy-hooks.mjs", level: "L2" },
    { id: "codex", label: "Codex", root: path.join(home, ".codex"), installer: "scripts/install-codex.mjs", level: "L2" },
    { id: "openclaw", label: "OpenClaw", root: path.join(home, ".openclaw"), installer: "scripts/install-digest.mjs --agent openclaw", level: "L1" },
    { id: "hermes", label: "Hermes", root: path.join(home, ".hermes"), installer: "scripts/install-digest.mjs --agent hermes", level: "L1" },
  ].filter((a) => existsSync(a.root));
}

const CAPTURE_PART = ".git/hooks/post-commit.d/50-amp-capture";
const ACTIVE_DAYS = 90;

/**
 * Discover the repos your agents actually work in — the install targets for
 * the capture floor (§15.1 CAPTURE). Without it, a Stop/checkpoint adapter
 * counts zero work boundaries and never prompts, which is the difference
 * between L2 enforcement and silence.
 *
 * Sources are agent config files, not a disk crawl: agy's trusted workspaces
 * and Claude Code's project history, plus this memory repo. Paths are
 * resolved to their git toplevel, so subdirectories and case-variant volume
 * paths collapse to one entry.
 */
function discoverWorkingRepos() {
  const candidates = new Map();
  const addAll = (dirs, source) => {
    for (const d of dirs || []) {
      if (typeof d !== "string" || !d.startsWith("/")) continue;
      if (!candidates.has(d)) candidates.set(d, new Set());
      candidates.get(d).add(source);
    }
  };
  try {
    const agy = JSON.parse(readFileSync(path.join(homedir(), ".gemini", "antigravity-cli", "settings.json"), "utf8"));
    addAll(agy.trustedWorkspaces, "agy");
  } catch { /* agy not installed */ }
  try {
    const claude = JSON.parse(readFileSync(path.join(homedir(), ".claude.json"), "utf8"));
    addAll(Object.keys(claude.projects || {}), "claude");
  } catch { /* Claude Code not installed */ }
  addAll([ROOT], "memory repo");

  const repos = new Map();
  for (const [dir, sources] of candidates) {
    if (!existsSync(dir)) continue;
    const top = run("git", ["-C", dir, "rev-parse", "--show-toplevel"], { allowFail: true, timeoutMs: 5000 });
    if (!top.ok || !top.stdout) continue;
    let entry = repos.get(top.stdout);
    if (!entry) {
      const ts = run("git", ["-C", top.stdout, "log", "-1", "--format=%ct"], { allowFail: true, timeoutMs: 5000 });
      entry = {
        dir: top.stdout,
        sources: new Set(),
        lastCommit: Number(ts.stdout) || 0,
        hasFloor: existsSync(path.join(top.stdout, CAPTURE_PART)),
      };
      repos.set(top.stdout, entry);
    }
    for (const s of sources) entry.sources.add(s);
  }
  const cutoff = Date.now() / 1000 - ACTIVE_DAYS * 86400;
  return [...repos.values()]
    .map((r) => ({ ...r, sources: [...r.sources], active: r.lastCommit >= cutoff }))
    .sort((a, b) => b.lastCommit - a.lastCommit);
}

/** Scan → show → ask → install. Returns the number of repos equipped. */
async function offerCaptureFloor() {
  const all = discoverWorkingRepos();
  const equipped = all.filter((r) => r.hasFloor).length;
  const targets = all.filter((r) => !r.hasFloor && r.active);
  const dormant = all.filter((r) => !r.hasFloor && !r.active).length;

  if (all.length === 0) { info("no agent workspaces found to scan — add repos by path below"); return 0; }
  info(`scanned ${all.length} repo(s) from agent configs: ${equipped} already have the capture hook, ${dormant} inactive (>${ACTIVE_DAYS}d) skipped`);
  if (targets.length === 0) return 0;

  targets.forEach((r, i) => {
    const age = r.lastCommit ? `${Math.round((Date.now() / 1000 - r.lastCommit) / 86400)}d ago` : "no commits";
    info(`  ${String(i + 1).padStart(2)}. ${r.dir}  (${r.sources.join(", ")}; last commit ${age})`);
  });

  if (YES || DRY) {
    // Never mutate repos outside this one without an explicit answer.
    ctx.todo.push(`npm run hooks:install:capture -- <repo>   # ${targets.length} candidate(s) listed above`);
    info("non-interactive: capture-hook installs queued to the todo block");
    return 0;
  }

  const answer = (await ask(`Install the AMP capture hook into which? (all / none / e.g. 1,3-5)`, "all")).toLowerCase();
  if (!answer || answer === "none" || answer === "n") return 0;
  let chosen = targets;
  if (answer !== "all") {
    const picked = new Set();
    for (const part of answer.split(",").map((s) => s.trim())) {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) for (let i = Number(range[1]); i <= Number(range[2]); i++) picked.add(i);
      else if (/^\d+$/.test(part)) picked.add(Number(part));
    }
    chosen = targets.filter((_, i) => picked.has(i + 1));
  }
  let done = 0;
  for (const repo of chosen) {
    const r = run("bash", ["scripts/install-agent-hooks.sh", "--capture", repo.dir], { allowFail: true });
    if (r.ok) { ok(`capture hook installed in ${repo.dir}`); done++; }
    else warn(`${repo.dir}: ${r.stderr || r.stdout}`); // foreign hook → chain instructions
  }
  return done;
}

const stepLifecycle = {
  id: "lifecycle", title: "Lifecycle hooks (delegated installers)", required: false,
  async run() {
    const found = detectAgents();
    info(`agents detected: ${found.map((a) => `${a.id} (${a.level})`).join(", ") || "none"}`);
    for (const a of found.filter((x) => !x.installer)) info(`${a.id}: no installer — follow adapters/${a.id}/README.md`);
    if (existsSync(path.join(homedir(), ".claude")) && (await confirm("Install Claude Code lifecycle hooks (v2.8 recall/capture)?", true))) {
      const args = ["scripts/install-claude-hooks.mjs", "--repo-path", ROOT, "--repo-slug", ctx.slug, "--agent", AGENT];
      if (DRY) args.push("--dry-run");
      run("node", args, { inherit: true, allowFail: true });
    }
    if (existsSync(path.join(homedir(), ".gemini", "config")) && (await confirm("Install agy (Antigravity CLI) lifecycle hooks + skill?", true))) {
      const args = ["scripts/install-agy-hooks.mjs", "--repo-path", ROOT, "--repo-slug", ctx.slug];
      if (DRY) args.push("--dry-run");
      run("node", args, { inherit: true, allowFail: true });
    }
    if (existsSync(path.join(homedir(), ".codex")) && (await confirm("Install Codex L2 hooks with skill/digest fallback?", true))) {
      const args = ["scripts/install-codex.mjs", "--repo-path", ROOT, "--repo-slug", ctx.slug];
      if (DRY) args.push("--dry-run");
      run("node", args, { inherit: true, allowFail: true });
      info("Review and trust the installed AMP definitions with /hooks in Codex; untrusted hooks are skipped");
    }
    for (const [id, root, what] of [
      ["openclaw", path.join(homedir(), ".openclaw"), "digest into its workspace AGENTS.md"],
      ["hermes", path.join(homedir(), ".hermes"), "digest into ~/.hermes/SOUL.md"],
    ]) {
      if (existsSync(root) && (await confirm(`Install ${id} L1 digest (${what}) + label?`, true))) {
        const args = ["scripts/install-digest.mjs", "--agent", id, "--repo-path", ROOT, "--repo-slug", ctx.slug];
        if (DRY) args.push("--dry-run");
        run("node", args, { inherit: true, allowFail: true });
        info(`${id} is L1 — also export RXAI_AMP_AGENT=${id} in the environment ${id} runs under (never globally)`);
      }
    }
    if (await confirm("Install this repo's pre-commit secret/privacy scan hook?", true)) {
      if (DRY) info("[dry-run] would: bash scripts/install-agent-hooks.sh");
      else {
        const r = run("bash", ["scripts/install-agent-hooks.sh"], { allowFail: true });
        if (r.ok) ok("secret/privacy scan hook installed");
        else warn(r.stderr || r.stdout || "hook installer declined (foreign hook present?)");
      }
    }
    // CAPTURE floor — the deterministic source of work boundaries for every
    // agent (§15.1). Scan the agents' own configs, then offer the install.
    await offerCaptureFloor();
    while (!YES && !DRY) {
      const p = await ask("Path to another WORKING repo to add the AMP capture hook (Enter to finish)", "");
      if (!p) break;
      const r = run("bash", ["scripts/install-agent-hooks.sh", "--capture", p], { allowFail: true });
      if (r.ok) ok(`capture hook installed in ${p}`);
      else warn(r.stderr || r.stdout);
    }
  },
  verify: () => true,
};

const stepValidate = {
  id: "validate", title: "First compile + end-to-end test", required: false,
  async run() {
    if (DRY) { info("[dry-run] would: dispatch index-scheduler, poll green, post canonical test issue, verify REGION-Test.md"); return; }

    const dispatch = async () => {
      const ran = await retry(() => gh(["workflow", "run", "index-scheduler.yml", "--repo", ctx.slug]).ok,
        { attempts: 5, delayMs: 6000 }).catch(() => false);
      if (!ran) throw new Error(`could not dispatch index-scheduler — run it at https://github.com/${ctx.slug}/actions`);
      await sleepMs(10000);
      const green = await retry(() => {
        const runs = ghJson(["run", "list", "--repo", ctx.slug, "--workflow=index-scheduler.yml", "--limit", "1", "--json", "status,conclusion"]);
        const r0 = runs && runs[0];
        if (r0 && r0.status === "completed") return r0.conclusion === "success" ? true : (() => { throw new Error(`scheduler run: ${r0.conclusion}`); })();
        return false;
      }, { attempts: 48, delayMs: 5000 });
      if (!green) throw new Error("scheduler did not finish within 4 min");
    };

    info("dispatching Index Scheduler…");
    await dispatch();
    ok("index-scheduler run green");
    const idx = remoteFileRaw("INDEX.md");
    if (idx.ok && /\*\*Last Compiled:\*\*/.test(idx.stdout)) ok("remote INDEX.md compiled");

    if (has("--no-test-issue")) { info("--no-test-issue: skipping e2e test issue"); }
    else if (await confirm("Post the canonical end-to-end test issue?", true)) {
      const t = nowIso();
      const body = `## Metadata\n- **Thread-ID:** ${t.slice(0, 10)}-001\n- **From:** human\n- **To:** all\n- **Region:** Test\n- **Place:** setup\n- **Type:** intent\n- **Posted:** ${t}\n\n## Message\nConfirming that the indexer can see this issue (posted by npm run setup).\n\n## Expected Action\n- [x] Acknowledge only\n`;
      let r = gh(["issue", "create", "--repo", ctx.slug,
        "--title", "[FROM:human→all][REGION:Test][PLACE:setup][TYPE:intent] First end-to-end test",
        "--body", body, "--label", "unindexed"]);
      if (!r.ok) r = gh(["issue", "create", "--repo", ctx.slug,
        "--title", "[FROM:human→all][REGION:Test][PLACE:setup][TYPE:intent] First end-to-end test", "--body", body]);
      if (!r.ok) { warn(`test issue failed: ${r.stderr.slice(0, 120)}`); return; }
      const num = r.stdout.match(/\/issues\/(\d+)/)?.[1];
      ok(`test issue #${num} created`);

      info("waiting for not-indexed-tracker (~90 s)…");
      const tracked = await retry(() => {
        const ni = remoteFileRaw("not_indexed.md");
        return ni.ok && new RegExp(`#${num}\\b`).test(ni.stdout);
      }, { attempts: 36, delayMs: 5000 }).catch(() => false);
      if (tracked) ok(`#${num} landed in not_indexed.md`);
      else warn("tracker did not pick the issue up within 3 min — check Actions");

      info("re-dispatching scheduler to fold it into the index…");
      await dispatch();
      const region = await retry(() => remoteFileRaw("REGION-Test.md").ok, { attempts: 6, delayMs: 5000 }).catch(() => false);
      if (region) ok("REGION-Test.md exists — system is live 🎉");
      else warn("REGION-Test.md not found yet");
    }
    apply("git pull --ff-only (sync local clone with compiled remote)", () =>
      run("git", ["pull", "--ff-only"], { allowFail: true }));
  },
  verify: () => DRY || (() => {
    const runs = ghJson(["run", "list", "--repo", ctx.slug, "--workflow=index-scheduler.yml", "--limit", "1", "--json", "conclusion"]);
    return Boolean(runs && runs[0] && runs[0].conclusion === "success");
  })(),
};

const STEPS = [stepPreflight, stepResolveRepo, stepBuild, stepSeedReset, stepPush,
  stepActionsPerms, stepLabels, stepRepoWorkflows, stepPat, stepMcp, stepLifecycle, stepValidate];

// --------------------------------------------------------------- checklist --

function printChecklist() {
  banner("Verification checklist");
  const settingsPath = path.join(homedir(), ".claude", "settings.json");
  const boxes = [
    ["repo pushed (remote PROTOCOL.md reachable)", () => remoteFileRaw("PROTOCOL.md").ok],
    ["Actions workflow permissions = read+write", () => stepActionsPerms.verify()],
    ["local build artifacts (dist/) present", () => stepBuild.verify()],
    ["labels seeded (unindexed + type:*)", () => stepLabels.verify()],
    ["Index Scheduler latest run green", () => stepValidate.verify()],
    ["remote INDEX.md has Last Compiled", () => { const r = remoteFileRaw("INDEX.md"); return r.ok && /\*\*Last Compiled:\*\*/.test(r.stdout); }],
    ["librarian configured (secret set or workflow disabled)", () => {
      const secrets = ghJson(["secret", "list", "--repo", ctx.slug, "--json", "name"]) || [];
      if (secrets.some((s) => s.name === "PERSONAL_ACCESS_TOKEN")) return true;
      const wfs = ghJson(["workflow", "list", "--repo", ctx.slug, "--all", "--json", "path,state"]) || [];
      const lib = wfs.find((w) => w.path.endsWith("amp-librarian.yml"));
      return lib ? lib.state !== "active" : true;
    }],
    ["agent PAT stored (Keychain/.env)", () => keychainHasToken()],
    ["secret/privacy scan hook installed in this repo", () =>
      existsSync(path.join(ROOT, ".git", "hooks", "pre-commit.d", "10-secret-scan")) || existsSync(path.join(ROOT, ".git", "hooks", "pre-commit"))],
    ["Claude lifecycle hooks in ~/.claude/settings.json", () =>
      existsSync(settingsPath) && readFileSync(settingsPath, "utf8").includes("adapters/claude-code")],
    ["agy lifecycle hooks in ~/.gemini/config/hooks.json", () => {
      const f = path.join(homedir(), ".gemini", "config", "hooks.json");
      return existsSync(f) && readFileSync(f, "utf8").includes("adapters/agy");
    }],
    ["codex L2 hooks + skill/digest fallback", () => {
      const home = path.join(homedir(), ".codex");
      if (!existsSync(home)) return true; // Codex not installed → not owed
      const md = path.join(home, "AGENTS.md");
      const hooks = path.join(home, "hooks.json");
      return existsSync(path.join(home, "skills", "rxai-amp", "SKILL.md")) &&
        existsSync(md) && readFileSync(md, "utf8").includes("rxai-amp-digest") &&
        existsSync(hooks) && readFileSync(hooks, "utf8").includes("adapters/codex/hooks");
    }],
    ["openclaw L1 digest (workspace AGENTS.md)", () => {
      const home = path.join(homedir(), ".openclaw");
      if (!existsSync(home)) return true; // not installed → not owed
      let workspace = path.join(home, "workspace");
      try {
        const cfg = JSON.parse(readFileSync(path.join(home, "openclaw.json"), "utf8"));
        if (typeof cfg?.agents?.defaults?.workspace === "string") workspace = cfg.agents.defaults.workspace;
      } catch { /* conventional default */ }
      const md = path.join(workspace, "AGENTS.md");
      return existsSync(md) && readFileSync(md, "utf8").includes("rxai-amp-digest");
    }],
    ["hermes L1 digest (~/.hermes/SOUL.md)", () => {
      const home = path.join(homedir(), ".hermes");
      if (!existsSync(home)) return true; // not installed → not owed
      const soul = path.join(home, "SOUL.md");
      return existsSync(soul) && readFileSync(soul, "utf8").includes("rxai-amp-digest");
    }],
    ["capture floor in every active agent repo (else no CAPTURE prompt ever)", () => {
      const repos = discoverWorkingRepos().filter((r) => r.active);
      const missing = repos.filter((r) => !r.hasFloor);
      if (missing.length > 0) info(`missing in ${missing.length}/${repos.length}: ${missing.slice(0, 3).map((r) => r.dir).join(", ")}${missing.length > 3 ? " …" : ""}`);
      return repos.length > 0 && missing.length === 0;
    }],
  ];
  let failures = 0;
  for (const [label, probe] of boxes) {
    let pass = false;
    try { pass = Boolean(probe()); } catch { pass = false; }
    process.stdout.write(`  [${pass ? "x" : " "}] ${label}\n`);
    if (!pass) failures++;
  }
  return failures;
}

// -------------------------------------------------------------------- main --

async function main() {
  if (process.platform === "win32") {
    fail("setup currently supports macOS/Linux only (bash hooks + Keychain). PRs welcome.");
    process.exit(1);
  }
  banner(`RxAi AMP setup${DRY ? " (dry-run)" : ""}`);

  const only = (flag("--only") || "").split(",").filter(Boolean);
  const skip = (flag("--skip") || "").split(",").filter(Boolean);

  if (has("--verify")) {
    await stepResolveRepo.run().catch((e) => { fail(String(e.message || e)); process.exit(1); });
    process.exit(printChecklist() > 0 ? 1 : 0);
  }

  for (const step of STEPS) {
    // --only always keeps the cheap context-establishing steps, or nothing downstream can run.
    const contextSteps = ["preflight", "resolve-repo"];
    if (only.length && !only.includes(step.id) && !contextSteps.includes(step.id)) continue;
    if (skip.includes(step.id)) { info(`skipping ${step.id}`); continue; }
    banner(`${step.title}  (${step.id})`);
    try {
      await step.run();
    } catch (e) {
      const msg = String(e.message || e);
      if (step.required) { fail(msg); process.exit(1); }
      warn(`${step.id}: ${msg} — continuing (fail-soft)`);
      ctx.todo.push(`retry: npm run setup -- --only ${step.id} --repo ${ctx.slug ?? "<owner/name>"}`);
    }
  }

  if (!DRY) {
    const failures = printChecklist();
    if (ctx.todo.length) {
      banner("Still on you (human-only or skipped)");
      for (const t of ctx.todo) process.stdout.write(`  - ${t}\n`);
    }
    banner(failures === 0 ? "Your agents now share a memory." : `${failures} checklist box(es) open — see above`);
    info("Docs: README.md (Quick start + full guide) · PROTOCOL.md (source of truth)");
  } else {
    banner("Dry-run complete — nothing was changed");
  }
}

main().catch((e) => { fail(String(e && e.stack || e)); process.exit(1); });
