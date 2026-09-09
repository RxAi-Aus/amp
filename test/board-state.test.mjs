// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// AMP Board — board/lib/state.mjs pure reducer + board/lib/store.mjs persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BOARD_SCHEMA,
  STATUSES,
  TERMINAL_RUN_STATUSES,
  TransitionError,
  emptyState,
  newTask,
  reduce,
  columnOf,
} from "../board/lib/state.mjs";
import { openStore, withLock, LockBusyError } from "../board/lib/store.mjs";

const T0 = "2026-09-02T04:00:00.000Z";
const T1 = "2026-09-02T04:01:00.000Z";
const T2 = "2026-09-02T04:02:00.000Z";

function seeded() {
  const task = newTask({ region: "Sample", title: "Do a thing", description: "desc", linkedIssue: 337, assignee: "codex" }, T0, "t_1");
  return { state: reduce(emptyState(T0), { type: "task/create", task, at: T0 }), task };
}

function run(role = "worker", agent = "fake", runId = "r_1") {
  return { runId, role, agent, trigger: "ui", startedAt: T1, pid: 4242, logPath: `/tmp/${runId}.log` };
}

function start(state, id, role = "worker", agent = "fake", runId = "r_1") {
  return reduce(state, { type: "run/start", id, run: run(role, agent, runId), actor: "user", at: T1 });
}

function end(state, id, runId, { exitCode = 0, result = null, error = null } = {}) {
  return reduce(state, { type: "run/end", id, runId, exitCode, endedAt: T2, result, error, actor: "system", at: T2 });
}

test("emptyState carries the schema and defaults", () => {
  const s = emptyState(T0);
  assert.equal(s.schema, BOARD_SCHEMA);
  assert.equal(BOARD_SCHEMA, "rxai-amp/board@1");
  assert.deepEqual(s.settings, { concurrency: 2, timeoutMin: 30, defaultAgent: "claudecowork", yolo: false });
  assert.deepEqual(s.tasks, []);
  assert.deepEqual(s.projects, {});
});

test("STATUSES enumerates every column state", () => {
  assert.deepEqual(STATUSES, ["queued", "running", "blocked", "failed", "finished", "reviewing", "approval", "done"]);
  assert.deepEqual(TERMINAL_RUN_STATUSES, ["finished", "blocked", "failed", "approval"]);
  assert.equal(columnOf("queued"), 3);
  assert.equal(columnOf("blocked"), 3);
  assert.equal(columnOf("reviewing"), 4);
  assert.equal(columnOf("approval"), 5);
  assert.equal(columnOf("done"), 5);
});

test("newTask generates ids and normalises fields", () => {
  const t = newTask({ region: "Sample", title: "  x  ", description: undefined, linkedIssue: "337" }, T0);
  assert.match(t.id, /^t_[0-9a-z]+$/);
  assert.equal(t.title, "x");
  assert.equal(t.description, "");
  assert.equal(t.linkedIssue, 337);
  assert.equal(t.status, "queued");
  assert.equal(t.assignee, null);
  assert.equal(t.reviewer, null);
  assert.deepEqual(t.history, []);
  assert.deepEqual(t.runs, []);
  assert.throws(() => newTask({ region: "Sample", title: "" }, T0), /title/);
  assert.throws(() => newTask({ region: "", title: "x" }, T0), /region/);
});

test("reduce is pure: the input state is never mutated", () => {
  const { state, task } = seeded();
  const frozen = JSON.stringify(state);
  const next = start(state, task.id);
  assert.equal(JSON.stringify(state), frozen);
  assert.notEqual(next.tasks[0].status, state.tasks[0].status);
});

test("create → queued with a history entry", () => {
  const { state } = seeded();
  const t = state.tasks[0];
  assert.equal(t.status, "queued");
  assert.deepEqual(t.history[0], { at: T0, actor: "user", from: null, to: "queued", note: "" });
  assert.throws(() => reduce(state, { type: "task/create", task: t, at: T0 }), /exists/);
});

test("run/start moves queued→running and records the run + assignee", () => {
  const { state, task } = seeded();
  const s = start(state, task.id);
  const t = s.tasks[0];
  assert.equal(t.status, "running");
  assert.equal(t.assignee, "fake");
  assert.equal(t.runs.length, 1);
  assert.equal(t.runs[0].endedAt, null);
  assert.equal(t.pendingRun, null);
  assert.equal(s.updatedAt, T1);
  assert.deepEqual(t.history.at(-1), { at: T1, actor: "user", from: "queued", to: "running", note: "worker fake (ui)" });
});

test("invariant: at most one open run per task", () => {
  const { state, task } = seeded();
  const s = start(state, task.id);
  assert.throws(() => start(s, task.id, "worker", "fake", "r_2"), TransitionError);
});

test("worker run/end: done → finished with result; blocked → blocked; failure → failed", () => {
  const { state, task } = seeded();
  const running = start(state, task.id);
  const done = end(running, task.id, "r_1", { result: { status: "done", summary: "did it", issue: 351, notes: "" } });
  assert.equal(done.tasks[0].status, "finished");
  assert.deepEqual(done.tasks[0].result, { summary: "did it", issue: 351, notes: "" });
  assert.equal(done.tasks[0].runs[0].endedAt, T2);
  assert.equal(done.tasks[0].runs[0].exitCode, 0);

  const blocked = end(running, task.id, "r_1", { result: { status: "blocked", summary: "need creds", issue: null, notes: "n" } });
  assert.equal(blocked.tasks[0].status, "blocked");
  assert.equal(blocked.tasks[0].result.summary, "need creds");

  const failed = end(running, task.id, "r_1", { exitCode: 1, error: "exit 1" });
  assert.equal(failed.tasks[0].status, "failed");
  assert.equal(failed.tasks[0].runs[0].error, "exit 1");
  assert.match(failed.tasks[0].history.at(-1).note, /exit 1/);

  // exit 0 with no result JSON still counts as done (runner supplies the fallback summary)
  const noJson = end(running, task.id, "r_1", { exitCode: 0, result: null });
  assert.equal(noJson.tasks[0].status, "finished");
});

test("run/end with an unknown runId is rejected; a second end is idempotent-safe", () => {
  const { state, task } = seeded();
  const running = start(state, task.id);
  assert.throws(() => end(running, task.id, "r_nope"), TransitionError);
  const done = end(running, task.id, "r_1", { result: { status: "done", summary: "x" } });
  assert.throws(() => end(done, task.id, "r_1"), TransitionError);
});

test("cancel: running→queued, run marked cancelled, later run/end does not re-transition", () => {
  const { state, task } = seeded();
  const running = start(state, task.id);
  const cancelled = reduce(running, { type: "task/cancel", id: task.id, at: T2 });
  assert.equal(cancelled.tasks[0].status, "queued");
  assert.equal(cancelled.tasks[0].runs[0].cancelled, true);
  assert.equal(cancelled.tasks[0].runs[0].endedAt, null);
  const ended = end(cancelled, task.id, "r_1", { exitCode: null, error: "SIGTERM" });
  assert.equal(ended.tasks[0].status, "queued");
  assert.equal(ended.tasks[0].runs[0].endedAt, T2);
  // now it can be started again
  assert.equal(start(ended, task.id, "worker", "fake", "r_2").tasks[0].status, "running");
});

test("retry: blocked/failed → queued keeps history and assignee", () => {
  const { state, task } = seeded();
  const failed = end(start(state, task.id), task.id, "r_1", { exitCode: 2, error: "boom" });
  const retried = reduce(failed, { type: "task/retry", id: task.id, at: T2 });
  assert.equal(retried.tasks[0].status, "queued");
  assert.equal(retried.tasks[0].assignee, "fake");
  assert.equal(retried.tasks[0].history.length, 4);
  assert.throws(() => reduce(state, { type: "task/retry", id: task.id, at: T2 }), TransitionError);
});

test("review flow: finished → reviewing → approval → done; reject returns to queued", () => {
  const { state, task } = seeded();
  const finished = end(start(state, task.id), task.id, "r_1", { result: { status: "done", summary: "s", issue: 351 } });
  const reviewing = start(finished, task.id, "reviewer", "fake", "r_2");
  assert.equal(reviewing.tasks[0].status, "reviewing");
  assert.equal(reviewing.tasks[0].reviewer, "fake");
  assert.equal(reviewing.tasks[0].runs[1].role, "reviewer");

  const approval = end(reviewing, task.id, "r_2", { result: { verdict: "reject", notes: "needs tests" } });
  assert.equal(approval.tasks[0].status, "approval");
  assert.deepEqual(approval.tasks[0].review, { verdict: "reject", notes: "needs tests" });

  const done = reduce(approval, { type: "task/approve", id: task.id, at: T2 });
  assert.equal(done.tasks[0].status, "done");

  const rejected = reduce(approval, { type: "task/reject", id: task.id, note: "redo", at: T2 });
  assert.equal(rejected.tasks[0].status, "queued");
  assert.equal(rejected.tasks[0].assignee, "fake");
  assert.equal(rejected.tasks[0].rejection, "redo");
  assert.equal(rejected.tasks[0].history.at(-1).note, "redo");
});

test("reviewer failure/timeout/cancel returns the task to finished with a note", () => {
  const { state, task } = seeded();
  const finished = end(start(state, task.id), task.id, "r_1", { result: { status: "done", summary: "s" } });
  const reviewing = start(finished, task.id, "reviewer", "fake", "r_2");
  const back = end(reviewing, task.id, "r_2", { exitCode: 1, error: "exit 1" });
  assert.equal(back.tasks[0].status, "finished");
  assert.match(back.tasks[0].history.at(-1).note, /exit 1/);
  const noVerdict = end(reviewing, task.id, "r_2", { exitCode: 0, result: null });
  assert.equal(noVerdict.tasks[0].status, "finished");
  const cancelled = reduce(reviewing, { type: "task/cancel", id: task.id, at: T2 });
  assert.equal(cancelled.tasks[0].status, "finished");
});

test("every illegal transition throws TransitionError (409)", () => {
  const { state, task } = seeded();
  const id = task.id;
  const err = (fn) => assert.throws(fn, (e) => e instanceof TransitionError && e.status === 409);
  err(() => reduce(state, { type: "task/approve", id, at: T2 }));
  err(() => reduce(state, { type: "task/reject", id, note: "n", at: T2 }));
  err(() => reduce(state, { type: "task/cancel", id, at: T2 }));
  err(() => start(state, id, "reviewer")); // queued → reviewing not allowed
  const running = start(state, id);
  err(() => reduce(running, { type: "task/delete", id }));
  err(() => reduce(running, { type: "task/retry", id, at: T2 }));
  err(() => reduce(running, { type: "task/approve", id, at: T2 }));
  const finished = end(running, id, "r_1", { result: { status: "done", summary: "s" } });
  err(() => start(finished, id, "worker", "fake", "r_2")); // finished → running not allowed
  err(() => reduce(finished, { type: "task/retry", id, at: T2 }));
  err(() => reduce(finished, { type: "task/approve", id, at: T2 }));
  const approval = end(start(finished, id, "reviewer", "fake", "r_2"), id, "r_2", { result: { verdict: "approve", notes: "" } });
  err(() => start(approval, id, "worker", "fake", "r_3"));
  err(() => start(approval, id, "reviewer", "fake", "r_3"));
  const done = reduce(approval, { type: "task/approve", id, at: T2 });
  err(() => reduce(done, { type: "task/approve", id, at: T2 }));
  err(() => reduce(done, { type: "task/reject", id, note: "", at: T2 }));
  err(() => start(done, id));
  assert.throws(() => reduce(state, { type: "task/approve", id: "t_missing", at: T2 }), /not found/);
  assert.throws(() => reduce(state, { type: "bogus" }), /unknown action/);
});

test("delete is allowed only when no run is active", () => {
  const { state, task } = seeded();
  assert.deepEqual(reduce(state, { type: "task/delete", id: task.id }).tasks, []);
  const running = start(state, task.id);
  assert.throws(() => reduce(running, { type: "task/delete", id: task.id }), TransitionError);
  const failed = end(running, task.id, "r_1", { exitCode: 1, error: "x" });
  assert.deepEqual(reduce(failed, { type: "task/delete", id: task.id }).tasks, []);
});

test("task/update patches editable fields only; assignee frozen while a run is open", () => {
  const { state, task } = seeded();
  const s = reduce(state, {
    type: "task/update",
    id: task.id,
    patch: { title: "New", description: "d2", linkedIssue: null, assignee: "agy", reviewer: "codex", status: "done", bogus: 1 },
    at: T1,
  });
  const t = s.tasks[0];
  assert.equal(t.title, "New");
  assert.equal(t.description, "d2");
  assert.equal(t.linkedIssue, null);
  assert.equal(t.assignee, "agy");
  assert.equal(t.reviewer, "codex");
  assert.equal(t.status, "queued");
  assert.equal("bogus" in t, false);
  const running = start(state, task.id);
  assert.throws(() => reduce(running, { type: "task/update", id: task.id, patch: { assignee: "agy" }, at: T1 }), TransitionError);
  assert.equal(reduce(running, { type: "task/update", id: task.id, patch: { title: "ok" }, at: T1 }).tasks[0].title, "ok");
  assert.throws(() => reduce(state, { type: "task/update", id: task.id, patch: { title: "   " }, at: T1 }), /title/);
});

test("pendingRun is recorded when concurrency is full and cleared on start", () => {
  const { state, task } = seeded();
  const pending = reduce(state, { type: "task/pending", id: task.id, role: "worker", agent: "fake", trigger: "ui", at: T1 });
  assert.deepEqual(pending.tasks[0].pendingRun, { role: "worker", agent: "fake", trigger: "ui", at: T1 });
  assert.equal(pending.tasks[0].status, "queued");
  const cleared = reduce(pending, { type: "task/pending", id: task.id, role: null, at: T1 });
  assert.equal(cleared.tasks[0].pendingRun, null);
  assert.equal(start(pending, task.id).tasks[0].pendingRun, null);
  assert.throws(() => reduce(start(state, task.id), { type: "task/pending", id: task.id, role: "worker", agent: "fake", at: T1 }), TransitionError);
});

test("system/recover fails open runs whose pid is gone and leaves live ones alone", () => {
  const a = newTask({ region: "S", title: "a" }, T0, "t_a");
  const b = newTask({ region: "S", title: "b" }, T0, "t_b");
  let s = reduce(emptyState(T0), { type: "task/create", task: a, at: T0 });
  s = reduce(s, { type: "task/create", task: b, at: T0 });
  s = reduce(s, { type: "run/start", id: "t_a", run: { ...run("worker", "fake", "r_a"), pid: 111 }, actor: "user", at: T1 });
  s = reduce(s, { type: "run/start", id: "t_b", run: { ...run("worker", "fake", "r_b"), pid: 222 }, actor: "user", at: T1 });
  s = end(s, "t_b", "r_b", { result: { status: "done", summary: "s" } });
  s = reduce(s, { type: "run/start", id: "t_b", run: { ...run("reviewer", "fake", "r_b2"), pid: 333 }, actor: "user", at: T1 });
  const r = reduce(s, { type: "system/recover", livePids: [333], at: T2 });
  assert.equal(r.tasks[0].status, "failed");
  assert.equal(r.tasks[0].runs[0].endedAt, T2);
  assert.equal(r.tasks[0].runs[0].error, "server restarted");
  assert.equal(r.tasks[1].status, "reviewing"); // pid 333 still alive
  const r2 = reduce(s, { type: "system/recover", livePids: [], at: T2 });
  assert.equal(r2.tasks[1].status, "finished");
  assert.equal(r2.tasks[1].history.at(-1).note, "server restarted");
});

test("project/update and settings/update validate their patches", () => {
  const s = reduce(emptyState(T0), { type: "project/update", region: "Sample", patch: { workdir: "/tmp", notes: "n", bogus: 1 }, at: T1 });
  assert.deepEqual(s.projects.Sample, { workdir: "/tmp", notes: "n" });
  const s2 = reduce(s, { type: "project/update", region: "Sample", patch: { workdir: null }, at: T1 });
  assert.deepEqual(s2.projects.Sample, { workdir: null, notes: "n" });
  const s3 = reduce(s2, { type: "settings/update", patch: { concurrency: 3, timeoutMin: 5, yolo: true, defaultAgent: "codex", junk: 1 }, at: T1 });
  assert.deepEqual(s3.settings, { concurrency: 3, timeoutMin: 5, defaultAgent: "codex", yolo: true });
  assert.throws(() => reduce(s3, { type: "settings/update", patch: { concurrency: 0 }, at: T1 }), /concurrency/);
  assert.throws(() => reduce(s3, { type: "settings/update", patch: { timeoutMin: -1 }, at: T1 }), /timeoutMin/);
});

// ---------------------------------------------------------------------------
// store.mjs
// ---------------------------------------------------------------------------

function tmpHome() {
  return mkdtempSync(path.join(tmpdir(), "amp-board-store-"));
}

test("openStore creates the file on first save, writes atomically, reloads on external change", () => {
  const home = tmpHome();
  try {
    const file = path.join(home, "board.json");
    const store = openStore(file, { now: () => T0 });
    assert.equal(store.state.schema, BOARD_SCHEMA);
    assert.equal(existsSync(file), false);

    const task = newTask({ region: "Sample", title: "a" }, T0, "t_a");
    store.dispatch({ type: "task/create", task, at: T0 });
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(`${file}.tmp`), false);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.tasks[0].id, "t_a");

    // Simulate another process writing the file.
    const foreign = { ...onDisk, tasks: [...onDisk.tasks, { ...newTask({ region: "S", title: "b" }, T0, "t_b") }] };
    writeFileSync(file, JSON.stringify(foreign));
    const st = statSync(file);
    utimesSync(file, st.atime, new Date(st.mtimeMs + 5000));
    store.dispatch({ type: "task/create", task: newTask({ region: "S", title: "c" }, T0, "t_c"), at: T0 });
    assert.deepEqual(store.state.tasks.map((t) => t.id), ["t_a", "t_b", "t_c"]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tasks.map((t) => t.id), ["t_a", "t_b", "t_c"]);

    // TransitionError leaves the file untouched.
    const before = readFileSync(file, "utf8");
    assert.throws(() => store.dispatch({ type: "task/approve", id: "t_a", at: T0 }), TransitionError);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("openStore rejects a file with a foreign schema and accepts a fresh one", () => {
  const home = tmpHome();
  try {
    const file = path.join(home, "board.json");
    writeFileSync(file, JSON.stringify({ schema: "something-else" }));
    assert.throws(() => openStore(file), /schema/);
    writeFileSync(file, "{ not json");
    assert.throws(() => openStore(file), /parse/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("withLock holds board.json.lock only during the callback and breaks stale locks", () => {
  const home = tmpHome();
  try {
    const file = path.join(home, "board.json");
    const lock = `${file}.lock`;
    const seen = withLock(file, () => {
      assert.equal(existsSync(lock), true);
      assert.throws(() => withLock(file, () => "nested"), LockBusyError);
      return "ok";
    });
    assert.equal(seen, "ok");
    assert.equal(existsSync(lock), false);

    // A stale lock (older than 10 s) is broken.
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: "2020-01-01T00:00:00Z" }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    assert.equal(withLock(file, () => "recovered"), "recovered");
    assert.equal(existsSync(lock), false);

    // Errors still release the lock.
    assert.throws(() => withLock(file, () => { throw new Error("inner"); }), /inner/);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
