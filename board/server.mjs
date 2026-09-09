#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * server.mjs — AMP Board: five-column task board over RxAi AMP memory.
 *
 *   node board/server.mjs [--port 7345] [--clone <memory clone>]
 *                         [--concurrency N] [--timeout-min N]
 *
 * Zero dependencies, no build. Binds 127.0.0.1 only and rejects any
 * non-loopback Host header. Columns 1–2 read local files from the memory
 * clone (never GitHub); columns 3–5 live in ~/.rxai-amp/board.json. The
 * board never writes memory issues — agents do, via the rxai-amp skill.
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ampHome, resolveConfig } from "../adapters/lib/amp-config.mjs";
import { availableAgents } from "./lib/agents.mjs";
import { DEFAULT_PORT, HttpError, createSse, isLoopbackHost, json, noContent, readBody, serveStatic, throttleByKey } from "./lib/http.mjs";
import { invalidateIssueCache, isSafeRegion, listProjects, readIssue, readRegion, readWeights } from "./lib/memory.mjs";
import { createRunner } from "./lib/runner.mjs";
import { BOARD_SCHEMA, STATUSES, newTask } from "./lib/state.mjs";
import { openStore } from "./lib/store.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");

const LOG_CHUNK_BYTES = 64 * 1024;
const RUN_ID_RE = /^r_[0-9a-z]+$/;
const TASK_ID_RE = /^t_[0-9a-z]+$/;

function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function boot(argv = process.argv) {
  const config = resolveConfig();
  const clone = flag("--clone") ? path.resolve(flag("--clone")) : config && config.repoPath;
  if (!clone || !existsSync(clone)) {
    process.stderr.write(
      "AMP Board: no memory clone found.\n" +
        "  Pass --clone <path to your RxAi AMP memory clone>, set RXAI_AMP_REPO, or run `npm run setup` to write ~/.rxai-amp/config.json.\n",
    );
    process.exit(1);
  }
  const home = ampHome();
  const store = openStore(path.join(home, "board.json"));
  const overrides = {};
  if (flag("--concurrency")) overrides.concurrency = Number(flag("--concurrency"));
  if (flag("--timeout-min")) overrides.timeoutMin = Number(flag("--timeout-min"));
  if (Object.keys(overrides).length) store.dispatch({ type: "settings/update", patch: overrides });

  const sse = createSse();
  const emitLog = throttleByKey((runId, data) => sse.send("log", data), 250);
  const emit = (event, data) => {
    if (event === "log") {
      if (data.done) sse.send("log", data);
      else emitLog(data.runId, data);
    } else sse.send(event, data);
  };
  const runner = createRunner({ store, clone, home, emit });
  runner.recover();
  runner.drainPending();

  return { config, clone, home, store, sse, runner, port: Number(flag("--port", DEFAULT_PORT)) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Two paths naming the same directory.
 *
 * Comparing resolved path strings looked equivalent but is not: realpath
 * resolves symlinks without normalising case, so on a case-insensitive volume
 * a clone reached as `/Volumes/X/Foo…` fails to match git's own
 * `/Volumes/X/foo…` and a perfectly good repository root is rejected.
 * Identity is the thing actually being asked about, so compare identity.
 */
function sameDirectory(a, b) {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

async function gitStatus(clone) {
  try {
    // The clone must be a repository root — never pull a parent repo by accident.
    const { stdout: top } = await execFileAsync("git", ["-C", clone, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
    if (!sameDirectory(top.trim(), clone)) return { clean: null, error: "clone is not a git repository root" };
    const { stdout } = await execFileAsync("git", ["-C", clone, "status", "--porcelain"], { timeout: 10_000 });
    return { clean: stdout.trim() === "", error: null };
  } catch (err) {
    return { clean: null, error: `git status failed: ${(err.stderr || err.message || "").toString().trim()}` };
  }
}

function taskBadges(tasks, region) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of tasks) if (t.region === region) counts[t.status] = (counts[t.status] || 0) + 1;
  return counts;
}

function readLogChunk(file, offset) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return { offset, next: offset, chunk: "", size: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.min(Math.max(0, offset), size);
    const len = Math.min(LOG_CHUNK_BYTES, size - start);
    const buf = Buffer.alloc(len);
    const read = len > 0 ? readSync(fd, buf, 0, len, start) : 0;
    return { offset: start, next: start + read, chunk: buf.subarray(0, read).toString("utf8"), size };
  } finally {
    closeSync(fd);
  }
}

function validWorkdir(dir) {
  if (dir === null || dir === undefined || dir === "") return null;
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new HttpError(400, "workdir must be an absolute path");
  try {
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new HttpError(400, "workdir must be an existing directory");
  }
  return path.resolve(dir);
}

function requireTask(store, id) {
  if (!TASK_ID_RE.test(id)) throw new HttpError(400, "bad task id");
  const task = store.state.tasks.find((t) => t.id === id);
  if (!task) throw new HttpError(404, `task ${id} not found`);
  return task;
}

function requireRegion(name) {
  let decoded;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    throw new HttpError(400, "bad region");
  }
  if (!isSafeRegion(decoded)) throw new HttpError(400, "bad region");
  return decoded;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createApp(ctx) {
  const { clone, home, store, sse, runner, config } = ctx;
  const staticFiles = {
    "/": path.join(publicDir, "index.html"),
    "/index.html": path.join(publicDir, "index.html"),
    "/app.js": path.join(publicDir, "app.js"),
    "/styles.css": path.join(publicDir, "styles.css"),
    "/lib/markdown.mjs": path.join(here, "lib", "markdown.mjs"),
    "/favicon.svg": path.join(publicDir, "favicon.svg"),
  };

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route("GET", /^\/api\/config$/, async () => {
    const git = await gitStatus(clone);
    return {
      schema: BOARD_SCHEMA,
      clone,
      home,
      repoSlug: config ? config.repoSlug : null,
      agents: availableAgents(),
      settings: store.state.settings,
      gitClean: git.clean,
      gitError: git.error,
      lastCompiled: readWeights(clone).lastCompiled,
      port: ctx.port,
    };
  });

  route("GET", /^\/api\/projects$/, async () => {
    const projects = listProjects(clone).map((p) => {
      const settings = store.state.projects[p.region] || { workdir: null, notes: "" };
      return { ...p, workdir: settings.workdir || null, notes: settings.notes || "", tasks: taskBadges(store.state.tasks, p.region) };
    });
    return { projects, updatedAt: store.state.updatedAt };
  });

  route("GET", /^\/api\/projects\/([^/]+)\/issues$/, async (_req, m) => {
    const region = requireRegion(m[1]);
    const data = readRegion(clone, region);
    if (!data) throw new HttpError(404, `region ${region} not found`);
    return data;
  });

  route("PATCH", /^\/api\/projects\/([^/]+)$/, async (_req, m, body) => {
    const region = requireRegion(m[1]);
    const patch = {};
    if ("workdir" in body) patch.workdir = validWorkdir(body.workdir);
    if ("notes" in body) patch.notes = typeof body.notes === "string" ? body.notes : "";
    store.dispatch({ type: "project/update", region, patch });
    const p = store.state.projects[region];
    sse.send("project", { region, ...p });
    return { project: { region, workdir: p.workdir, notes: p.notes } };
  });

  route("GET", /^\/api\/issues\/(\d+)$/, async (_req, m) => {
    const issue = readIssue(clone, Number(m[1]));
    if (!issue) throw new HttpError(404, `issue #${m[1]} not compiled locally`);
    const { file, ...rest } = issue;
    return { issue: rest };
  });
  route("GET", /^\/api\/issues\/[^/]+$/, async () => {
    throw new HttpError(400, "issue number must be numeric");
  });

  route("GET", /^\/api\/tasks$/, async (req) => {
    const region = new URL(req.url, "http://127.0.0.1").searchParams.get("region");
    const tasks = region ? store.state.tasks.filter((t) => t.region === region) : store.state.tasks;
    return { tasks, settings: store.state.settings, updatedAt: store.state.updatedAt };
  });

  route("POST", /^\/api\/tasks$/, async (_req, _m, body) => {
    const task = newTask(body);
    store.dispatch({ type: "task/create", task });
    const created = store.state.tasks.find((t) => t.id === task.id);
    sse.send("task", created);
    return { status: 201, body: { task: created } };
  });

  route("GET", /^\/api\/tasks\/([^/]+)$/, async (_req, m) => ({ task: requireTask(store, m[1]) }));

  route("PATCH", /^\/api\/tasks\/([^/]+)$/, async (_req, m, body) => {
    const task = requireTask(store, m[1]);
    store.dispatch({ type: "task/update", id: task.id, patch: body });
    const updated = requireTask(store, task.id);
    sse.send("task", updated);
    return { task: updated };
  });

  route("DELETE", /^\/api\/tasks\/([^/]+)$/, async (_req, m) => {
    const task = requireTask(store, m[1]);
    store.dispatch({ type: "task/delete", id: task.id });
    sse.send("task", { ...task, deleted: true });
    return { status: 204 };
  });

  route("POST", /^\/api\/tasks\/([^/]+)\/assign$/, async (_req, m, body) => {
    const task = requireTask(store, m[1]);
    const { task: updated, pending } = runner.start(task.id, { role: "worker", agent: body.agent, trigger: "ui", actor: "user" });
    return { status: pending ? 202 : 200, body: { task: updated, pending } };
  });

  route("POST", /^\/api\/tasks\/([^/]+)\/review$/, async (_req, m, body) => {
    const task = requireTask(store, m[1]);
    const { task: updated, pending } = runner.start(task.id, { role: "reviewer", agent: body.agent, trigger: "ui", actor: "user" });
    return { status: pending ? 202 : 200, body: { task: updated, pending } };
  });

  route("POST", /^\/api\/tasks\/([^/]+)\/cancel$/, async (_req, m) => ({ task: runner.cancel(requireTask(store, m[1]).id) }));

  for (const [action, type] of [["retry", "task/retry"], ["approve", "task/approve"], ["reject", "task/reject"]]) {
    route("POST", new RegExp(`^/api/tasks/([^/]+)/${action}$`), async (_req, m, body) => {
      const task = requireTask(store, m[1]);
      store.dispatch({ type, id: task.id, note: body.note });
      const updated = requireTask(store, task.id);
      sse.send("task", updated);
      return { task: updated };
    });
  }

  route("POST", /^\/api\/pull$/, async (_req, _m, body) => {
    if (typeof body.agent !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(body.agent)) throw new HttpError(400, "agent is required");
    const role = body.role === "reviewer" ? "reviewer" : "worker";
    return runner.claim({ agent: body.agent, role, trigger: "pull" });
  });

  route("PATCH", /^\/api\/settings$/, async (_req, _m, body) => {
    store.dispatch({ type: "settings/update", patch: body });
    sse.send("settings", store.state.settings);
    runner.drainPending();
    return { settings: store.state.settings };
  });

  route("GET", /^\/api\/runs\/([^/]+)\/log$/, async (req, m) => {
    let runId;
    try {
      runId = decodeURIComponent(m[1]);
    } catch {
      throw new HttpError(400, "bad run id");
    }
    if (!RUN_ID_RE.test(runId)) throw new HttpError(400, "bad run id");
    const found = runner.logPathFor(runId);
    if (!found) throw new HttpError(404, `run ${runId} not found`);
    const offset = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("offset") || 0);
    const chunk = readLogChunk(found.logPath, Number.isFinite(offset) ? offset : 0);
    return { ...chunk, runId, done: found.run.endedAt !== null };
  });

  route("POST", /^\/api\/refresh$/, async () => {
    const git = await gitStatus(clone);
    if (git.error) return { ok: false, error: git.error };
    if (!git.clean) return { ok: false, dirty: true, error: "worktree dirty, pull skipped" };
    try {
      const { stdout } = await execFileAsync("git", ["-C", clone, "pull", "--ff-only"], { timeout: 60_000 });
      invalidateIssueCache(clone);
      sse.send("memory", { at: new Date().toISOString() });
      return { ok: true, output: stdout.trim() };
    } catch (err) {
      return { ok: false, error: `git pull failed: ${(err.stderr || err.message || "").toString().trim()}` };
    }
  });

  return async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!isLoopbackHost(req.headers.host)) return json(res, 400, { error: "bad Host header" });
    try {
      if (req.method === "GET" && url.pathname === "/api/events") {
        return sse.handle(req, res, { tasks: store.state.tasks.length, at: new Date().toISOString() });
      }
      if (req.method === "GET" || req.method === "HEAD") {
        if (serveStatic(res, url.pathname, staticFiles)) return;
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        const body = req.method === "GET" || req.method === "HEAD" ? {} : await readBody(req);
        const out = await r.handler(req, m, body);
        if (out && typeof out === "object" && "status" in out && ("body" in out || out.status === 204)) {
          return out.status === 204 ? noContent(res) : json(res, out.status, out.body);
        }
        return json(res, 200, out);
      }
      json(res, 404, { error: `no route: ${req.method} ${url.pathname}` });
    } catch (err) {
      const status = Number(err.status) || 500;
      if (status >= 500) process.stderr.write(`[board] ${req.method} ${url.pathname}: ${err.stack || err}\n`);
      json(res, status, { error: err.message || String(err), kind: err.name });
    }
  };
}

// ---------------------------------------------------------------------------

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const ctx = boot();
  const server = createServer(createApp(ctx));
  server.listen(ctx.port, "127.0.0.1", () => {
    const { port } = server.address();
    ctx.port = port;
    process.stdout.write(`AMP Board listening on http://127.0.0.1:${port}  (clone: ${ctx.clone}, state: ${path.join(ctx.home, "board.json")})\n`);
  });
  const stop = () => {
    ctx.runner.shutdown();
    ctx.sse.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 6000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
