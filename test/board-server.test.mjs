// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// AMP Board — end-to-end over HTTP with the dev-only `fake` adapter:
// board/server.mjs + runner.mjs + http.mjs against the fixture clone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BOARD_SCHEMA, emptyState, newTask, reduce } from "../board/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const clone = path.join(here, "fixtures/board/clone");

let home;
let server;
let base;
let stderrBuf = "";

async function api(method, route, body, headers = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** fetch() drops a custom Host header, so the DNS-rebinding guard is probed with node:http. */
function rawGet(route, host) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + route);
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, method: "GET", headers: { Host: host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(fn, { timeout = 8000, every = 60 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, every));
  }
}

async function taskById(id) {
  const { json } = await api("GET", `/api/tasks/${id}`);
  return json && json.task;
}

async function waitStatus(id, status) {
  return waitFor(async () => {
    const t = await taskById(id);
    return t && t.status === status ? t : null;
  });
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "amp-board-home-"));
  // Pre-seed a task whose worker run was left open by a dead pid — the
  // server must mark it failed with "server restarted" on startup.
  const t = newTask({ region: "Sample", title: "orphan", assignee: "fake" }, "2026-09-02T00:00:00.000Z", "t_orphan");
  let s = reduce(emptyState("2026-09-02T00:00:00.000Z"), { type: "task/create", task: t, at: "2026-09-02T00:00:00.000Z" });
  s = reduce(s, {
    type: "run/start",
    id: "t_orphan",
    run: { runId: "r_orphan", role: "worker", agent: "fake", trigger: "ui", startedAt: "2026-09-02T00:00:01.000Z", pid: 2147483000, logPath: null },
    actor: "user",
    at: "2026-09-02T00:00:01.000Z",
  });
  writeFileSync(path.join(home, "board.json"), JSON.stringify(s));

  server = spawn(process.execPath, [path.join(root, "board/server.mjs"), "--clone", clone, "--port", "0"], {
    env: { ...process.env, RXAI_AMP_HOME: home, AMP_DISABLE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => (stderrBuf += d.toString()));
  base = await new Promise((resolve, reject) => {
    let out = "";
    server.stdout.on("data", (d) => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    server.on("exit", (code) => reject(new Error(`server exited ${code}: ${stderrBuf}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out} ${stderrBuf}`)), 8000);
  });
});

after(async () => {
  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

test("GET /api/config describes clone, agents and settings", async () => {
  const { status, json } = await api("GET", "/api/config");
  assert.equal(status, 200);
  assert.equal(json.clone, clone);
  assert.equal(json.schema, BOARD_SCHEMA);
  assert.equal(json.lastCompiled, "2026-09-02T02:35:40Z");
  const fake = json.agents.find((a) => a.name === "fake");
  assert.equal(fake.available, true);
  assert.equal(json.agents.find((a) => a.name === "openclaw").available, false);
  assert.equal(json.settings.concurrency, 2);
  assert.equal(typeof json.gitClean === "boolean" || json.gitClean === null, true);
});

test("non-loopback Host header is rejected with 400; static assets are served", async () => {
  assert.equal(await rawGet("/api/config", "evil.com"), 400);
  assert.equal(await rawGet("/", "evil.com:8080"), 400);
  assert.equal(await rawGet("/api/config", "localhost:1"), 200);
  const index = await api("GET", "/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.match(index.text, /AMP Board/);
  const md = await api("GET", "/lib/markdown.mjs");
  assert.equal(md.status, 200);
  assert.match(md.headers.get("content-type"), /javascript/);
  assert.match(md.text, /renderSafeMarkdown/);
  assert.equal((await api("GET", "/../package.json")).status, 404);
  assert.equal((await api("GET", "/lib/../server.mjs")).status, 404);
  assert.equal((await api("GET", "/nope.js")).status, 404);
});

test("startup recovery marks the orphaned run failed", async () => {
  const t = await taskById("t_orphan");
  assert.equal(t.status, "failed");
  assert.equal(t.runs[0].error, "server restarted");
  assert.equal(t.history.at(-1).note, "server restarted");
});

test("GET /api/projects lists regions with memory counts, task badges and settings", async () => {
  const { status, json } = await api("GET", "/api/projects");
  assert.equal(status, 200);
  assert.deepEqual(json.projects.map((p) => p.region), ["Empty", "Sample"]);
  const s = json.projects[1];
  assert.equal(s.issueCount, 4);
  assert.equal(s.activeCount, 4);
  assert.equal(s.archivedCount, 2);
  assert.equal(s.unindexedCount, 1);
  assert.equal(s.tasks.failed, 1);
  assert.equal(s.workdir, null);
});

test("GET /api/projects/:region/issues returns grouped rows; bad names are rejected", async () => {
  const { status, json } = await api("GET", "/api/projects/Sample/issues");
  assert.equal(status, 200);
  assert.equal(json.places.length, 3);
  assert.equal(json.places[0].types[0].type, "intent");
  assert.equal(json.unindexed[0].n, 395);
  assert.equal(json.archived.length, 2);
  assert.equal((await api("GET", "/api/projects/Nope/issues")).status, 404);
  assert.equal((await api("GET", "/api/projects/..%2F..%2Fetc/issues")).status, 400);
});

test("GET /api/issues/:n returns the parsed OKF body", async () => {
  const { status, json } = await api("GET", "/api/issues/337");
  assert.equal(status, 200);
  assert.equal(json.issue.frontmatter.title, "Publish one release note per sprint");
  assert.equal(json.issue.comments.length, 4);
  assert.equal(json.issue.region, "Sample");
  assert.equal((await api("GET", "/api/issues/999")).status, 404);
  assert.equal((await api("GET", "/api/issues/abc")).status, 400);
});

test("task CRUD validates input", async () => {
  assert.equal((await api("POST", "/api/tasks", { region: "Sample" })).status, 400);
  assert.equal((await api("POST", "/api/tasks", { region: "Sample", title: "x", linkedIssue: "abc" })).status, 400);
  const created = await api("POST", "/api/tasks", { region: "Sample", title: "  Edit me  ", description: "d", linkedIssue: 337, assignee: "fake" });
  assert.equal(created.status, 201);
  const id = created.json.task.id;
  assert.equal(created.json.task.status, "queued");
  assert.equal(created.json.task.title, "Edit me");
  const patched = await api("PATCH", `/api/tasks/${id}`, { title: "Edited", assignee: "codex" });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.task.assignee, "codex");
  assert.equal((await api("PATCH", `/api/tasks/${id}`, { assignee: "not an agent!" })).status, 400);
  assert.equal((await api("DELETE", `/api/tasks/${id}`)).status, 204);
  assert.equal((await api("GET", `/api/tasks/${id}`)).status, 404);
  assert.equal((await api("POST", `/api/tasks/${id}/approve`)).status, 404);
});

test("happy path: add → assign fake → finished → review fake → approval → approve → done", async () => {
  const created = await api("POST", "/api/tasks", { region: "Sample", title: "Ship it [fake:issue=351][fake:sleep=200]", description: "acceptance", assignee: "fake" });
  const id = created.json.task.id;
  const assigned = await api("POST", `/api/tasks/${id}/assign`, { agent: "fake" });
  assert.equal(assigned.status, 200, assigned.text);
  assert.equal(assigned.json.task.status, "running");
  assert.equal(assigned.json.task.runs.length, 1);
  const runId = assigned.json.task.runs[0].runId;
  assert.ok(assigned.json.task.runs[0].pid > 0);

  const finished = await waitStatus(id, "finished");
  assert.deepEqual(finished.result, { summary: "fake run ok", issue: 351, notes: "" });
  assert.equal(finished.runs[0].exitCode, 0);
  assert.equal(finished.runs[0].endedAt !== null, true);

  const log = await api("GET", `/api/runs/${runId}/log?offset=0`);
  assert.equal(log.status, 200);
  assert.match(log.json.chunk, /fake worker starting task/);
  assert.match(log.json.chunk, /\[err\] fake stderr line/);
  assert.ok(log.json.next > 0);
  const tail = await api("GET", `/api/runs/${runId}/log?offset=${log.json.next}`);
  assert.equal(tail.json.chunk, "");
  assert.equal(tail.json.done, true);
  assert.equal((await api("GET", "/api/runs/r_nope/log")).status, 404);
  assert.equal((await api("GET", "/api/runs/..%2Fx/log")).status, 400);

  // finished → running is illegal → 409
  assert.equal((await api("POST", `/api/tasks/${id}/assign`, { agent: "fake" })).status, 409);

  const review = await api("POST", `/api/tasks/${id}/review`, { agent: "fake" });
  assert.equal(review.status, 200, review.text);
  assert.equal(review.json.task.status, "reviewing");
  const approval = await waitStatus(id, "approval");
  assert.deepEqual(approval.review, { verdict: "approve", notes: "fake review ok" });
  assert.equal(approval.reviewer, "fake");

  const done = await api("POST", `/api/tasks/${id}/approve`);
  assert.equal(done.status, 200);
  assert.equal(done.json.task.status, "done");
  assert.equal((await api("POST", `/api/tasks/${id}/approve`)).status, 409);
});

test("reject returns the task to Waiting with the note and history intact", async () => {
  const created = await api("POST", "/api/tasks", { region: "Sample", title: "Needs work [fake:reject][fake:sleep=100]", assignee: "fake" });
  const id = created.json.task.id;
  await api("POST", `/api/tasks/${id}/assign`, {});
  await waitStatus(id, "finished");
  await api("POST", `/api/tasks/${id}/review`, { agent: "fake" });
  const approval = await waitStatus(id, "approval");
  assert.equal(approval.review.verdict, "reject");
  const rejected = await api("POST", `/api/tasks/${id}/reject`, { note: "redo the tests" });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.task.status, "queued");
  assert.equal(rejected.json.task.assignee, "fake");
  assert.equal(rejected.json.task.rejection, "redo the tests");
  assert.equal(rejected.json.task.history.at(-1).note, "redo the tests");
  assert.equal(rejected.json.task.history.length, 6);
});

test("blocked and failed workers land in column 3 and Retry re-queues them", async () => {
  const blocked = await api("POST", "/api/tasks", { region: "Sample", title: "Blocked [fake:blocked][fake:sleep=100]", assignee: "fake" });
  await api("POST", `/api/tasks/${blocked.json.task.id}/assign`, {});
  const b = await waitStatus(blocked.json.task.id, "blocked");
  assert.equal(b.result.notes, "needs input from the user");
  const retried = await api("POST", `/api/tasks/${b.id}/retry`);
  assert.equal(retried.json.task.status, "queued");

  const failed = await api("POST", "/api/tasks", { region: "Sample", title: "Fails [fake:exit=3][fake:sleep=100]", assignee: "fake" });
  await api("POST", `/api/tasks/${failed.json.task.id}/assign`, {});
  const f = await waitStatus(failed.json.task.id, "failed");
  assert.equal(f.runs[0].error, "exit 3");
  assert.equal((await api("POST", `/api/tasks/${f.id}/retry`)).json.task.status, "queued");

  // exit 0 with no JSON still finishes, with the fallback summary
  const nojson = await api("POST", "/api/tasks", { region: "Sample", title: "Quiet [fake:nojson][fake:sleep=100]", assignee: "fake" });
  await api("POST", `/api/tasks/${nojson.json.task.id}/assign`, {});
  const q = await waitStatus(nojson.json.task.id, "finished");
  assert.equal(q.result.notes, "no result JSON");
  assert.match(q.result.summary, /fake worker working/);
});

test("cancel kills the child and returns the task to queued", async () => {
  const created = await api("POST", "/api/tasks", { region: "Sample", title: "Slow [fake:sleep=20000]", assignee: "fake" });
  const id = created.json.task.id;
  const assigned = await api("POST", `/api/tasks/${id}/assign`, {});
  const pid = assigned.json.task.runs[0].pid;
  await new Promise((r) => setTimeout(r, 150));
  const cancelled = await api("POST", `/api/tasks/${id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.task.status, "queued");
  await waitFor(async () => (await taskById(id)).runs[0].endedAt !== null);
  await waitFor(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal((await taskById(id)).runs[0].cancelled, true);
  assert.equal((await api("POST", `/api/tasks/${id}/cancel`)).status, 409);
  assert.equal((await api("DELETE", `/api/tasks/${id}`)).status, 204);
});

test("concurrency: the second assign waits as pendingRun and auto-starts when a slot frees", async () => {
  assert.equal((await api("PATCH", "/api/settings", { concurrency: 1 })).status, 200);
  assert.equal((await api("PATCH", "/api/settings", { concurrency: 0 })).status, 400);
  const a = await api("POST", "/api/tasks", { region: "Sample", title: "A [fake:sleep=600]", assignee: "fake" });
  const b = await api("POST", "/api/tasks", { region: "Sample", title: "B [fake:sleep=100]", assignee: "fake" });
  const ra = await api("POST", `/api/tasks/${a.json.task.id}/assign`, {});
  assert.equal(ra.json.task.status, "running");
  const rb = await api("POST", `/api/tasks/${b.json.task.id}/assign`, {});
  assert.equal(rb.status, 202, rb.text);
  assert.equal(rb.json.task.status, "queued");
  assert.equal(rb.json.task.pendingRun.role, "worker");
  assert.equal((await api("DELETE", `/api/tasks/${a.json.task.id}`)).status, 409);
  await waitStatus(a.json.task.id, "finished");
  await waitStatus(b.json.task.id, "finished");
  const done = await taskById(b.json.task.id);
  assert.equal(done.pendingRun, null);
  assert.equal(done.runs.length, 1);
  await api("PATCH", "/api/settings", { concurrency: 2 });
});

test("POST /api/pull claims the oldest queued task for that agent, or nothing", async () => {
  assert.deepEqual((await api("POST", "/api/pull", { agent: "codex" })).json, { task: null, reason: "nothing to do" });
  // Earlier tests leave re-queued fake tasks behind; clear them so "oldest" is unambiguous.
  for (const t of (await api("GET", "/api/tasks")).json.tasks) if (t.status === "queued") await api("DELETE", `/api/tasks/${t.id}`);
  assert.deepEqual((await api("POST", "/api/pull", { agent: "fake" })).json, { task: null, reason: "nothing to do" });
  const first = await api("POST", "/api/tasks", { region: "Sample", title: "Pull me first [fake:sleep=100]", assignee: "fake" });
  await new Promise((r) => setTimeout(r, 5));
  const second = await api("POST", "/api/tasks", { region: "Sample", title: "Pull me second [fake:sleep=100]", assignee: "fake" });
  const pulled = await api("POST", "/api/pull", { agent: "fake" });
  assert.equal(pulled.status, 200, pulled.text);
  assert.equal(pulled.json.task.id, first.json.task.id);
  assert.equal(pulled.json.task.status, "running");
  assert.equal(pulled.json.task.runs[0].trigger, "pull");
  await waitStatus(first.json.task.id, "finished");
  // reviewer role pulls finished tasks whose reviewer matches
  assert.equal((await api("POST", "/api/pull", { agent: "fake", role: "reviewer" })).json.task, null);
  await api("PATCH", `/api/tasks/${first.json.task.id}`, { reviewer: "fake" });
  const reviewPull = await api("POST", "/api/pull", { agent: "fake", role: "reviewer" });
  assert.equal(reviewPull.json.task.status, "reviewing");
  await waitStatus(first.json.task.id, "approval");
  assert.equal((await api("POST", "/api/pull", { agent: "bad name!" })).status, 400);
  await api("DELETE", `/api/tasks/${second.json.task.id}`);
});

test("PATCH /api/projects/:region validates the working directory", async () => {
  assert.equal((await api("PATCH", "/api/projects/Sample", { workdir: "/definitely/not/here" })).status, 400);
  assert.equal((await api("PATCH", "/api/projects/Sample", { workdir: "relative/path" })).status, 400);
  const dir = path.join(home, "work");
  mkdirSync(dir);
  const ok = await api("PATCH", "/api/projects/Sample", { workdir: dir, notes: "agents run here" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.project, { region: "Sample", workdir: dir, notes: "agents run here" });
  const projects = (await api("GET", "/api/projects")).json.projects;
  assert.equal(projects.find((p) => p.region === "Sample").workdir, dir);
  // A worker for this region now runs inside the workdir.
  const t = await api("POST", "/api/tasks", { region: "Sample", title: "Where am I [fake:sleep=100]", assignee: "fake" });
  const r = await api("POST", `/api/tasks/${t.json.task.id}/assign`, {});
  await waitStatus(t.json.task.id, "finished");
  const log = await api("GET", `/api/runs/${r.json.task.runs[0].runId}/log`);
  assert.ok(log.json.chunk.includes(`in ${realpathSync(dir)}`), log.json.chunk);
  assert.equal((await api("PATCH", "/api/projects/Sample", { workdir: null })).json.project.workdir, null);
  assert.equal((await api("PATCH", "/api/projects/..%2Fx", { notes: "n" })).status, 400);
});

test("GET /api/events streams task events", async () => {
  const controller = new AbortController();
  const res = await fetch(base + "/api/events", { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const readUntil = async (re) => {
    for (;;) {
      if (re.test(buf)) return buf;
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buf += decoder.decode(value, { stream: true });
    }
  };
  await readUntil(/event: hello/);
  const created = await api("POST", "/api/tasks", { region: "Sample", title: "SSE task", assignee: "fake" });
  const seen = await readUntil(new RegExp(`event: task\\ndata: .*${created.json.task.id}`));
  assert.match(seen, /"status":"queued"/);
  controller.abort();
  await api("DELETE", `/api/tasks/${created.json.task.id}`);
});

test("POST /api/refresh reports a non-git clone without crashing", async () => {
  const { status, json } = await api("POST", "/api/refresh");
  assert.equal(status, 200);
  assert.equal(json.ok, false);
  assert.match(json.error, /git/);
});

test("no stray board.json.tmp or lock is left behind", async () => {
  assert.equal(existsSync(path.join(home, "board.json")), true);
  assert.equal(existsSync(path.join(home, "board.json.tmp")), false);
  assert.equal(existsSync(path.join(home, "board.json.lock")), false);
});
