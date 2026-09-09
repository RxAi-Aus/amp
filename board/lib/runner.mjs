// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * runner.mjs — the one run loop shared by board/server.mjs and board/cli.mjs:
 *   claim → build prompt → spawn adapter → parse trailer → reduce → save.
 *
 * Owns concurrency (settings.concurrency), timeouts (settings.timeoutMin),
 * cancel (SIGTERM → SIGKILL), pendingRun draining, startup recovery, and
 * pull-mode claims under board.json.lock. Emits "task" and "log" events
 * through the injected emit() so the server can fan them out over SSE.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { readIssue } from "./memory.mjs";
import { makeId, nowIso, openRunOf, pickNext, ROLES } from "./state.mjs";
import { ADAPTERS, buildArgv, buildReviewerPrompt, buildWorkerPrompt, parseAdapterOutput, readResultFile, spawnRun } from "./agents.mjs";

const FALLBACK_SUMMARY_CHARS = 2000;
const ORPHAN_POLL_MS = 5000;

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function issueExcerpt(issue) {
  if (!issue) return null;
  const wanted = ["Message", "Context Pointer", "Summary", "Recall", "Outcome"];
  const parts = [];
  if (issue.frontmatter && issue.frontmatter.title) parts.push(`Title: ${issue.frontmatter.title}`);
  for (const s of issue.sections) if (wanted.includes(s.name) && s.body) parts.push(`${s.name}: ${s.body}`);
  const last = issue.comments.at(-1);
  if (last) parts.push(`Latest comment (${last.author}, ${last.at}${last.outcome ? `, outcome ${last.outcome}` : ""}): ${last.body.slice(0, 600)}`);
  return parts.join("\n");
}

export function createRunner({ store, clone, home, emit = () => {}, env = process.env, adapters = ADAPTERS, killGraceMs = 5000 }) {
  const active = new Map(); // taskId → { runId, role, agent, run }
  const orphans = new Map(); // runId → { taskId, pid, timer }
  const runsDir = path.join(home, "board-runs");

  const settings = () => store.state.settings;
  const findTask = (id) => store.state.tasks.find((t) => t.id === id) || null;
  const emitTask = (id) => {
    const task = findTask(id);
    if (task) emit("task", task);
    return task;
  };

  function workdirFor(task) {
    const project = store.state.projects[task.region];
    const dir = project && project.workdir;
    if (dir && path.isAbsolute(dir)) {
      try {
        if (statSync(dir).isDirectory()) return dir;
      } catch {
        /* fall back to the clone */
      }
    }
    return clone;
  }

  function promptFor(task, role, agent) {
    if (role === "worker") {
      const issue = task.linkedIssue ? readIssue(clone, task.linkedIssue) : null;
      return buildWorkerPrompt({ task, clone, agent, issueExcerpt: issue ? issueExcerpt(issue) : null });
    }
    const posted = task.result && task.result.issue ? readIssue(clone, task.result.issue) : null;
    return buildReviewerPrompt({ task, clone, agent, issueBody: posted ? posted.raw : null });
  }

  function validateAgent(agent) {
    if (!adapters[agent]) throw Object.assign(new Error(`unknown agent: ${agent}`), { status: 400 });
    return agent;
  }

  /** Spawn now. Caller has already checked the slot. Returns the updated task. */
  function launch(task, role, agent, trigger, actor) {
    validateAgent(agent);
    const runId = makeId("r");
    const logPath = path.join(runsDir, `${runId}.log`);
    const cwd = workdirFor(task);
    const prompt = promptFor(task, role, agent);
    const built = buildArgv(agent, { prompt, cwd, clone, logPath, role, yolo: Boolean(settings().yolo) });
    const childEnv = { ...env, RXAI_AMP_AGENT: agent, AMP_BOARD_TASK: task.id };
    // A headless `claude -p` refuses to start inside another Claude Code
    // session; the board is a separate process, so drop that marker only.
    delete childEnv.CLAUDECODE;

    const run = spawnRun({
      argv: built.argv,
      cwd,
      env: childEnv,
      logPath,
      timeoutMs: Math.max(1, Number(settings().timeoutMin) || 30) * 60_000,
      killGraceMs,
      onLog: (offset) => emit("log", { runId, taskId: task.id, offset }),
    });

    store.dispatch({
      type: "run/start",
      id: task.id,
      run: { runId, role, agent, trigger, startedAt: nowIso(), pid: run.child ? run.child.pid : null, logPath },
      actor,
    });
    active.set(task.id, { runId, role, agent, run });
    emit("run", { runId, taskId: task.id, role, agent, started: true });

    run.done.then((d) => finish(task.id, runId, role, agent, built, d)).catch((err) => {
      finish(task.id, runId, role, agent, built, { exitCode: null, stdout: "", error: `runner: ${err.message}`, timedOut: false, cancelled: false });
    });
    return emitTask(task.id);
  }

  function finish(taskId, runId, role, agent, built, d) {
    active.delete(taskId);
    const fileText = readResultFile(built.resultFile);
    let result = parseAdapterOutput(agent, { stdout: d.stdout, fileText }, role);
    if (role === "worker" && !result && !d.error && d.exitCode === 0) {
      result = { status: "done", summary: (d.stdout || "").trim().slice(-FALLBACK_SUMMARY_CHARS), issue: null, notes: "no result JSON" };
    }
    try {
      store.locked(() =>
        store.dispatch({
          type: "run/end",
          id: taskId,
          runId,
          exitCode: d.exitCode,
          endedAt: nowIso(),
          result,
          error: d.cancelled ? "cancelled" : d.error,
          actor: `${role}:${agent}`,
        }),
      );
    } catch (err) {
      // Task deleted meanwhile, or the run was already closed by recovery.
      emit("warn", { runId, taskId, message: err.message });
    }
    emit("log", { runId, taskId, offset: null, done: true });
    emitTask(taskId);
    drainPending();
  }

  function slotsFree() {
    return Math.max(0, (Number(settings().concurrency) || 1) - active.size);
  }

  /**
   * start(taskId, { role, agent, trigger, actor }) → { task, pending }
   * Queues as pendingRun when concurrency is full.
   */
  function start(taskId, { role = "worker", agent, trigger = "ui", actor = "user" }) {
    if (!ROLES.includes(role)) throw Object.assign(new Error("role must be worker|reviewer"), { status: 400 });
    const task = findTask(taskId);
    if (!task) throw Object.assign(new Error(`task ${taskId} not found`), { status: 404 });
    const chosen = validateAgent(agent || (role === "worker" ? task.assignee : task.reviewer) || settings().defaultAgent);
    if (slotsFree() === 0) {
      store.dispatch({ type: "task/pending", id: taskId, role, agent: chosen, trigger });
      return { task: emitTask(taskId), pending: true };
    }
    return { task: launch(task, role, chosen, trigger, actor), pending: false };
  }

  function drainPending() {
    const waiting = store.state.tasks
      .filter((t) => t.pendingRun && !openRunOf(t))
      .sort((a, b) => a.pendingRun.at.localeCompare(b.pendingRun.at));
    for (const t of waiting) {
      if (slotsFree() === 0) return;
      try {
        launch(t, t.pendingRun.role, t.pendingRun.agent, t.pendingRun.trigger, "system");
      } catch (err) {
        store.dispatch({ type: "task/pending", id: t.id, role: null });
        emit("warn", { taskId: t.id, message: `pending run failed to start: ${err.message}` });
      }
    }
  }

  function cancel(taskId) {
    const task = findTask(taskId);
    if (!task) throw Object.assign(new Error(`task ${taskId} not found`), { status: 404 });
    store.dispatch({ type: "task/cancel", id: taskId });
    const entry = active.get(taskId);
    if (entry) entry.run.cancel();
    return emitTask(taskId);
  }

  /**
   * Pull-mode claim (cli next / POST /api/pull). Under the lock so a
   * standalone CLI and the server cannot both take the same task.
   * → { task, reason } — task null when nothing matched or no slot is free.
   */
  function claim({ agent, role = "worker", trigger = "pull" }) {
    validateAgent(agent);
    if (!ROLES.includes(role)) throw Object.assign(new Error("role must be worker|reviewer"), { status: 400 });
    return store.locked(() => {
      store.reload();
      const next = pickNext(store.state, { agent, role });
      if (!next) return { task: null, reason: "nothing to do" };
      if (slotsFree() === 0) return { task: null, reason: "busy" };
      return { task: launch(next, role, agent, trigger, "scheduler"), reason: null };
    });
  }

  /** Startup: close runs whose process is gone; watch the ones still alive. */
  function recover() {
    const livePids = [];
    for (const t of store.state.tasks) {
      const run = openRunOf(t);
      if (run && pidAlive(run.pid)) livePids.push(run.pid);
    }
    store.dispatch({ type: "system/recover", livePids, at: nowIso() });
    for (const t of store.state.tasks) {
      const run = openRunOf(t);
      if (run && run.pid && livePids.includes(run.pid)) watchOrphan(t.id, run);
    }
    return store.state;
  }

  // A run started by a previous server process: we cannot reattach to its
  // stdout, so poll the pid and close the run when it exits.
  function watchOrphan(taskId, run) {
    const timer = setInterval(() => {
      if (pidAlive(run.pid)) return;
      clearInterval(timer);
      orphans.delete(run.runId);
      try {
        store.locked(() =>
          store.dispatch({ type: "run/end", id: taskId, runId: run.runId, exitCode: null, endedAt: nowIso(), result: null, error: "orphaned run ended (server restarted)", actor: "system" }),
        );
      } catch {
        /* already closed */
      }
      emitTask(taskId);
    }, ORPHAN_POLL_MS);
    timer.unref();
    orphans.set(run.runId, { taskId, pid: run.pid, timer });
  }

  function shutdown() {
    for (const { run } of active.values()) run.cancel();
    for (const { timer } of orphans.values()) clearInterval(timer);
  }

  function logPathFor(runId) {
    for (const t of store.state.tasks) {
      const r = t.runs.find((x) => x.runId === runId);
      if (r) return { task: t, run: r, logPath: r.logPath || path.join(runsDir, `${runId}.log`), exists: r.logPath ? existsSync(r.logPath) : false };
    }
    return null;
  }

  return {
    start,
    cancel,
    claim,
    recover,
    drainPending,
    shutdown,
    logPathFor,
    runsDir,
    activeCount: () => active.size,
    isActive: (taskId) => active.has(taskId),
    slotsFree,
  };
}
