// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * state.mjs — AMP Board task state machine.
 *
 * Pure reducer: reduce(state, action) → new state. Never mutates its input,
 * never touches the filesystem. Illegal transitions throw TransitionError
 * (HTTP 409 upstream). Columns 3–5 of the board are entirely this state;
 * the memory repo is never written by the board.
 *
 *   —         → queued      task/create
 *   queued    → running     run/start (role worker)
 *   running   → finished    run/end  status:done (or exit 0 without JSON)
 *   running   → blocked     run/end  status:blocked
 *   running   → failed      run/end  non-zero exit / timeout / spawn error
 *   running   → queued      task/cancel
 *   blocked|failed → queued task/retry
 *   finished  → reviewing   run/start (role reviewer)
 *   reviewing → approval    run/end  with a verdict
 *   reviewing → finished    run/end  without a verdict / failure, task/cancel
 *   approval  → done        task/approve
 *   approval  → queued      task/reject
 *   queued|blocked|failed|finished|approval|done → (deleted)  task/delete
 *
 * Invariant: at most one open run (endedAt === null) per task.
 */

export const BOARD_SCHEMA = "rxai-amp/board@1";
export const STATUSES = ["queued", "running", "blocked", "failed", "finished", "reviewing", "approval", "done"];
export const ACTIVE_STATUSES = ["running", "reviewing"];
export const TERMINAL_RUN_STATUSES = ["finished", "blocked", "failed", "approval"];
export const ROLES = ["worker", "reviewer"];
export const ACTORS = ["user", "scheduler", "system"];
export const DEFAULT_SETTINGS = Object.freeze({ concurrency: 2, timeoutMin: 30, defaultAgent: "claudecowork", yolo: false });

const COLUMN = { queued: 3, running: 3, blocked: 3, failed: 3, finished: 4, reviewing: 4, approval: 5, done: 5 };
export function columnOf(status) {
  return COLUMN[status] ?? null;
}

export class TransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransitionError";
    this.status = 409;
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function emptyState(at = nowIso()) {
  return { schema: BOARD_SCHEMA, updatedAt: at, settings: { ...DEFAULT_SETTINGS }, projects: {}, tasks: [] };
}

function rand4() {
  return Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
}

export function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${rand4()}`;
}

function cleanText(v) {
  return typeof v === "string" ? v.trim() : "";
}

function cleanIssue(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError("linkedIssue must be a positive integer");
  return n;
}

function cleanAgent(v, field) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(v)) throw new ValidationError(`${field} must be an agent name`);
  return v;
}

export function newTask(input, at = nowIso(), id = makeId("t")) {
  const region = cleanText(input.region);
  const title = cleanText(input.title);
  if (!region) throw new ValidationError("region is required");
  if (!title) throw new ValidationError("title is required");
  return {
    id,
    region,
    title,
    description: cleanText(input.description),
    linkedIssue: cleanIssue(input.linkedIssue),
    status: "queued",
    assignee: cleanAgent(input.assignee, "assignee"),
    reviewer: cleanAgent(input.reviewer, "reviewer"),
    createdAt: at,
    updatedAt: at,
    result: null,
    review: null,
    rejection: null,
    pendingRun: null,
    history: [],
    runs: [],
  };
}

// ---------------------------------------------------------------------------

function findTask(state, id) {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw new TransitionError(`task ${id} not found`);
  return idx;
}

function openRun(task) {
  return task.runs.find((r) => r.endedAt === null) || null;
}

function withTask(state, idx, task, at) {
  const tasks = state.tasks.slice();
  tasks[idx] = { ...task, updatedAt: at ?? task.updatedAt };
  return { ...state, updatedAt: at ?? state.updatedAt, tasks };
}

function transition(task, to, { at, actor = "user", note = "" }) {
  return {
    ...task,
    status: to,
    history: [...task.history, { at, actor, from: task.status, to, note }],
  };
}

function expect(task, allowed, what) {
  if (!allowed.includes(task.status)) {
    throw new TransitionError(`${what}: task ${task.id} is ${task.status}, expected ${allowed.join("|")}`);
  }
}

function summariseResult(result) {
  if (!result || typeof result !== "object") return null;
  return {
    summary: typeof result.summary === "string" ? result.summary : "",
    issue: cleanIssueLoose(result.issue),
    notes: typeof result.notes === "string" ? result.notes : "",
  };
}

function cleanIssueLoose(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function endWorkerRun(task, run, action) {
  const { exitCode, error, result } = action;
  const at = action.at ?? action.endedAt;
  const actor = action.actor ?? `worker:${run.agent}`;
  const status = result && typeof result === "object" ? result.status : null;
  if (error || (exitCode !== 0 && exitCode !== null && exitCode !== undefined) || (exitCode === null && !result)) {
    const note = error || `exit ${exitCode}`;
    return transition({ ...task, result: summariseResult(result) ?? task.result }, "failed", { at, actor, note });
  }
  if (status === "blocked") {
    return transition({ ...task, result: summariseResult(result) }, "blocked", { at, actor, note: result.notes || result.summary || "blocked" });
  }
  // status:"done", or exit 0 without JSON (runner supplies the fallback summary)
  const summary = summariseResult(result) ?? { summary: "", issue: null, notes: "no result JSON" };
  return transition({ ...task, result: summary }, "finished", {
    at,
    actor,
    note: summary.issue ? `posted issue #${summary.issue}` : "",
  });
}

function endReviewerRun(task, run, action) {
  const { exitCode, error, result } = action;
  const at = action.at ?? action.endedAt;
  const actor = action.actor ?? `reviewer:${run.agent}`;
  const verdict = result && typeof result === "object" ? result.verdict : null;
  if (!error && (verdict === "approve" || verdict === "reject")) {
    const review = { verdict, notes: typeof result.notes === "string" ? result.notes : "" };
    return transition({ ...task, review }, "approval", { at, actor, note: `verdict: ${verdict}` });
  }
  const note = error || (exitCode === 0 ? "reviewer returned no verdict" : `exit ${exitCode}`);
  return transition(task, "finished", { at, actor, note });
}

function applyPatch(task, patch) {
  const next = { ...task };
  if ("title" in patch) {
    const title = cleanText(patch.title);
    if (!title) throw new ValidationError("title is required");
    next.title = title;
  }
  if ("description" in patch) next.description = cleanText(patch.description);
  if ("linkedIssue" in patch) next.linkedIssue = cleanIssue(patch.linkedIssue);
  if ("assignee" in patch) {
    if (openRun(task)) throw new TransitionError(`task ${task.id}: assignee is frozen while a run is open`);
    next.assignee = cleanAgent(patch.assignee, "assignee");
  }
  if ("reviewer" in patch) {
    if (openRun(task) && task.status === "reviewing") throw new TransitionError(`task ${task.id}: reviewer is frozen while reviewing`);
    next.reviewer = cleanAgent(patch.reviewer, "reviewer");
  }
  return next;
}

function validateSettings(patch) {
  const out = {};
  if ("concurrency" in patch) {
    const n = Number(patch.concurrency);
    if (!Number.isInteger(n) || n < 1 || n > 16) throw new ValidationError("concurrency must be an integer 1–16");
    out.concurrency = n;
  }
  if ("timeoutMin" in patch) {
    const n = Number(patch.timeoutMin);
    if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) throw new ValidationError("timeoutMin must be > 0 and ≤ 1440");
    out.timeoutMin = n;
  }
  if ("defaultAgent" in patch) out.defaultAgent = cleanAgent(patch.defaultAgent, "defaultAgent") ?? DEFAULT_SETTINGS.defaultAgent;
  if ("yolo" in patch) out.yolo = Boolean(patch.yolo);
  return out;
}

// ---------------------------------------------------------------------------

export function reduce(state, action) {
  if (!action || typeof action !== "object") throw new ValidationError("unknown action");
  const at = action.at ?? nowIso();
  switch (action.type) {
    case "task/create": {
      const task = action.task;
      if (!task || typeof task.id !== "string") throw new ValidationError("task/create needs a task");
      if (state.tasks.some((t) => t.id === task.id)) throw new TransitionError(`task ${task.id} already exists`);
      const created = {
        ...task,
        status: "queued",
        history: [{ at, actor: action.actor ?? "user", from: null, to: "queued", note: "" }],
        updatedAt: at,
      };
      return { ...state, updatedAt: at, tasks: [...state.tasks, created] };
    }

    case "task/update": {
      const idx = findTask(state, action.id);
      return withTask(state, idx, applyPatch(state.tasks[idx], action.patch || {}), at);
    }

    case "task/delete": {
      const idx = findTask(state, action.id);
      const task = state.tasks[idx];
      if (openRun(task) || ACTIVE_STATUSES.includes(task.status)) {
        throw new TransitionError(`task ${task.id}: cannot delete while ${task.status}`);
      }
      return { ...state, updatedAt: at, tasks: state.tasks.filter((t) => t.id !== action.id) };
    }

    case "task/pending": {
      const idx = findTask(state, action.id);
      const task = state.tasks[idx];
      if (!action.role) return withTask(state, idx, { ...task, pendingRun: null }, at);
      if (!ROLES.includes(action.role)) throw new ValidationError("role must be worker|reviewer");
      expect(task, action.role === "worker" ? ["queued"] : ["finished"], "pending");
      const pendingRun = { role: action.role, agent: action.agent ?? null, trigger: action.trigger ?? "ui", at };
      return withTask(state, idx, { ...task, pendingRun }, at);
    }

    case "run/start": {
      const idx = findTask(state, action.id);
      const task = state.tasks[idx];
      const run = action.run;
      if (!run || typeof run.runId !== "string" || !ROLES.includes(run.role)) throw new ValidationError("run/start needs {runId, role}");
      if (openRun(task)) throw new TransitionError(`task ${task.id} already has an open run`);
      if (task.runs.some((r) => r.runId === run.runId)) throw new TransitionError(`run ${run.runId} already exists`);
      const to = run.role === "worker" ? "running" : "reviewing";
      expect(task, run.role === "worker" ? ["queued"] : ["finished"], "run/start");
      const record = {
        runId: run.runId,
        role: run.role,
        agent: run.agent ?? null,
        trigger: run.trigger ?? "ui",
        startedAt: run.startedAt ?? at,
        endedAt: null,
        exitCode: null,
        pid: run.pid ?? null,
        logPath: run.logPath ?? null,
        result: null,
        error: null,
        cancelled: false,
      };
      const next = transition(
        {
          ...task,
          pendingRun: null,
          assignee: run.role === "worker" ? (run.agent ?? task.assignee) : task.assignee,
          reviewer: run.role === "reviewer" ? (run.agent ?? task.reviewer) : task.reviewer,
          runs: [...task.runs, record],
        },
        to,
        { at, actor: action.actor ?? "user", note: `${run.role} ${run.agent ?? "?"} (${record.trigger})` },
      );
      return withTask(state, idx, next, at);
    }

    case "run/end": {
      const idx = findTask(state, action.id);
      const task = state.tasks[idx];
      const rIdx = task.runs.findIndex((r) => r.runId === action.runId);
      if (rIdx === -1) throw new TransitionError(`run ${action.runId} not found on task ${task.id}`);
      if (task.runs[rIdx].endedAt !== null) throw new TransitionError(`run ${action.runId} already ended`);
      const endedAt = action.endedAt ?? at;
      const runs = task.runs.slice();
      const run = { ...runs[rIdx], endedAt, exitCode: action.exitCode ?? null, result: action.result ?? null, error: action.error ?? null };
      runs[rIdx] = run;
      let next = { ...task, runs };
      if (!run.cancelled) {
        if (run.role === "worker") {
          expect(task, ["running"], "run/end");
          next = endWorkerRun(next, run, { ...action, at: endedAt });
        } else {
          expect(task, ["reviewing"], "run/end");
          next = endReviewerRun(next, run, { ...action, at: endedAt });
        }
      }
      return withTask(state, idx, next, endedAt);
    }

    case "task/cancel": {
      const idx = findTask(state, action.id);
      const task = state.tasks[idx];
      expect(task, ACTIVE_STATUSES, "cancel");
      const runs = task.runs.map((r) => (r.endedAt === null ? { ...r, cancelled: true } : r));
      const to = task.status === "running" ? "queued" : "finished";
      const next = transition({ ...task, runs }, to, { at, actor: action.actor ?? "user", note: "cancelled" });
      return withTask(state, idx, next, at);
    }

    case "task/retry": {
      const idx = findTask(state, action.id);
      const task = state.tasks[idx];
      expect(task, ["blocked", "failed"], "retry");
      return withTask(state, idx, transition(task, "queued", { at, actor: action.actor ?? "user", note: "retry" }), at);
    }

    case "task/approve": {
      const idx = findTask(state, action.id);
      const task = state.tasks[idx];
      expect(task, ["approval"], "approve");
      return withTask(state, idx, transition(task, "done", { at, actor: "user", note: cleanText(action.note) }), at);
    }

    case "task/reject": {
      const idx = findTask(state, action.id);
      const task = state.tasks[idx];
      expect(task, ["approval"], "reject");
      const note = cleanText(action.note);
      const next = transition({ ...task, rejection: note }, "queued", { at, actor: "user", note });
      return withTask(state, idx, next, at);
    }

    case "system/recover": {
      const live = new Set((action.livePids || []).map(Number));
      let changed = false;
      const tasks = state.tasks.map((task) => {
        const run = openRun(task);
        if (!run || (run.pid && live.has(Number(run.pid)))) return task;
        changed = true;
        const runs = task.runs.map((r) => (r === run ? { ...r, endedAt: at, exitCode: null, error: "server restarted" } : r));
        const base = { ...task, runs };
        if (run.cancelled || !ACTIVE_STATUSES.includes(task.status)) return { ...base, updatedAt: at };
        const to = task.status === "running" ? "failed" : "finished";
        return { ...transition(base, to, { at, actor: "system", note: "server restarted" }), updatedAt: at };
      });
      return changed ? { ...state, updatedAt: at, tasks } : state;
    }

    case "project/update": {
      const region = cleanText(action.region);
      if (!region) throw new ValidationError("region is required");
      const prev = state.projects[region] || { workdir: null, notes: "" };
      const patch = action.patch || {};
      const next = { ...prev };
      if ("workdir" in patch) next.workdir = patch.workdir ? cleanText(patch.workdir) || null : null;
      if ("notes" in patch) next.notes = cleanText(patch.notes);
      return { ...state, updatedAt: at, projects: { ...state.projects, [region]: next } };
    }

    case "settings/update": {
      return { ...state, updatedAt: at, settings: { ...state.settings, ...validateSettings(action.patch || {}) } };
    }

    default:
      throw new ValidationError(`unknown action: ${action.type}`);
  }
}

/** Oldest task matching a pull request (used by the CLI and POST /api/pull). */
export function pickNext(state, { agent, role = "worker" }) {
  const status = role === "reviewer" ? "finished" : "queued";
  const field = role === "reviewer" ? "reviewer" : "assignee";
  return (
    state.tasks
      .filter((t) => t.status === status && t[field] === agent && !openRun(t))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] || null
  );
}

export function openRunOf(task) {
  return openRun(task);
}
