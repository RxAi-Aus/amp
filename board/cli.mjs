#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * cli.mjs — AMP Board pull mode (the scheduler entry point).
 *
 *   node board/cli.mjs next --agent <name> [--role reviewer] [--max N] [--dry-run]
 *                            [--clone <path>] [--port <n>]
 *   node board/cli.mjs status [--clone <path>]
 *
 * `next` claims the oldest queued task assigned to <agent> (or, with
 * --role reviewer, the oldest finished task whose reviewer is <agent>) and
 * runs it to completion. When the board server is reachable it delegates
 * via POST /api/pull so the server stays the single runner and SSE stays
 * live; otherwise it runs standalone under board.json.lock.
 *
 * No task → prints "nothing to do", exits 0, spawns nothing (deterministic
 * Node, zero idle cost — an LLM starts only when a queued task exists).
 * Exit 0 on done/blocked/verdict, 1 on failed.
 */

import { existsSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ampHome, resolveConfig } from "../adapters/lib/amp-config.mjs";
import { ADAPTERS, buildArgv } from "./lib/agents.mjs";
import { DEFAULT_PORT } from "./lib/http.mjs";
import { createRunner } from "./lib/runner.mjs";
import { ACTIVE_STATUSES, pickNext } from "./lib/state.mjs";
import { openStore } from "./lib/store.mjs";

const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function flag(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

function usage(code) {
  process.stderr.write(
    "usage: board/cli.mjs next --agent <name> [--role reviewer] [--max N] [--dry-run] [--clone <path>] [--port <n>]\n" +
      "       board/cli.mjs status [--clone <path>]\n",
  );
  process.exit(code);
}

function resolveClone(argv) {
  const config = resolveConfig();
  const clone = flag(argv, "--clone") ? path.resolve(flag(argv, "--clone")) : config && config.repoPath;
  if (!clone || !existsSync(clone)) {
    process.stderr.write("AMP Board: no memory clone found (pass --clone or set RXAI_AMP_REPO / ~/.rxai-amp/config.json).\n");
    process.exit(1);
  }
  return { clone, home: ampHome(), config };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return body && typeof body.schema === "string" && body.schema.startsWith("rxai-amp/board@");
  } catch {
    return false;
  }
}

function tailer(logPath) {
  let offset = 0;
  return () => {
    let fd;
    try {
      fd = openSync(logPath, "r");
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      const n = readSync(fd, buf, 0, buf.length, offset);
      offset += n;
      process.stdout.write(buf.subarray(0, n).toString("utf8"));
    } finally {
      closeSync(fd);
    }
  };
}

function outcomeExit(task, role) {
  if (role === "worker") return task.status === "failed" ? 1 : 0;
  return task.status === "approval" ? 0 : 1;
}

// ---------------------------------------------------------------------------

async function viaServer({ port, agent, role }) {
  const post = await fetch(`http://127.0.0.1:${port}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, role }),
  });
  const body = await post.json();
  if (!post.ok) {
    process.stderr.write(`server refused pull: ${body.error || post.status}\n`);
    return 1;
  }
  if (!body.task) {
    process.stdout.write(`${body.reason || "nothing to do"}\n`);
    return body.reason === "busy" ? 0 : 0;
  }
  const task = body.task;
  const run = task.runs.at(-1);
  process.stdout.write(`claimed ${task.id} "${task.title}" via server (run ${run.runId}, ${role} ${agent})\n`);
  const tail = run.logPath ? tailer(run.logPath) : () => {};
  for (;;) {
    tail();
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`);
    if (!res.ok) {
      process.stderr.write(`task ${task.id} disappeared\n`);
      return 1;
    }
    const { task: current } = await res.json();
    if (!ACTIVE_STATUSES.includes(current.status)) {
      tail();
      process.stdout.write(`${task.id} → ${current.status}\n`);
      return outcomeExit(current, role);
    }
    await sleep(500);
  }
}

async function standalone({ clone, home, agent, role, dryRun }) {
  const store = openStore(path.join(home, "board.json"));
  if (dryRun) {
    const next = pickNext(store.state, { agent, role });
    if (!next) {
      process.stdout.write("nothing to do\n");
      return 0;
    }
    const built = buildArgv(agent, { prompt: "<prompt>", cwd: clone, clone, logPath: path.join(home, "board-runs", "r_dryrun.log"), role, yolo: Boolean(store.state.settings.yolo) });
    process.stdout.write(`would claim ${next.id} "${next.title}" (${role} ${agent})\nargv: ${JSON.stringify(built.argv.map((a) => (a.length > 80 ? `${a.slice(0, 77)}...` : a)))}\n`);
    return 0;
  }
  const runner = createRunner({
    store,
    clone,
    home,
    emit: (event, data) => {
      if (event === "warn") process.stderr.write(`[board] ${data.message}\n`);
    },
  });
  runner.recover();
  const { task, reason } = runner.claim({ agent, role, trigger: "pull" });
  if (!task) {
    process.stdout.write(`${reason || "nothing to do"}\n`);
    return 0;
  }
  const run = task.runs.at(-1);
  process.stdout.write(`claimed ${task.id} "${task.title}" standalone (run ${run.runId}, ${role} ${agent})\n`);
  const tail = tailer(run.logPath);
  for (;;) {
    tail();
    const current = store.state.tasks.find((t) => t.id === task.id);
    if (!current || !ACTIVE_STATUSES.includes(current.status)) {
      tail();
      process.stdout.write(`${task.id} → ${current ? current.status : "deleted"}\n`);
      runner.shutdown();
      return current ? outcomeExit(current, role) : 1;
    }
    await sleep(500);
  }
}

export async function next(argv) {
  const agent = flag(argv, "--agent");
  if (!agent || !AGENT_RE.test(agent)) usage(2);
  if (!ADAPTERS[agent]) {
    process.stderr.write(`unknown agent: ${agent} (known: ${Object.keys(ADAPTERS).join(", ")})\n`);
    return 2;
  }
  const role = flag(argv, "--role", "worker") === "reviewer" ? "reviewer" : "worker";
  const max = Math.max(1, Number(flag(argv, "--max", 1)) || 1);
  const dryRun = argv.includes("--dry-run");
  const port = Number(flag(argv, "--port", process.env.AMP_BOARD_PORT || DEFAULT_PORT));
  const { clone, home } = resolveClone(argv);

  let worst = 0;
  for (let i = 0; i < max; i++) {
    const code = !dryRun && (await serverUp(port)) ? await viaServer({ port, agent, role }) : await standalone({ clone, home, agent, role, dryRun });
    worst = Math.max(worst, code);
    if (code !== 0 || dryRun) break;
    // Stop early when the queue is drained (standalone/server both print it).
    const store = openStore(path.join(home, "board.json"));
    if (!pickNext(store.state, { agent, role })) break;
  }
  return worst;
}

export function status(argv) {
  const { clone, home } = resolveClone(argv);
  const store = openStore(path.join(home, "board.json"));
  const byAgent = new Map();
  const bump = (agent, key) => {
    const row = byAgent.get(agent) || { queued: 0, running: 0, awaitingReview: 0, reviewing: 0 };
    row[key] += 1;
    byAgent.set(agent, row);
  };
  for (const t of store.state.tasks) {
    if (t.status === "queued") bump(t.assignee || "(unassigned)", "queued");
    if (t.status === "running") bump(t.assignee || "?", "running");
    if (t.status === "finished") bump(t.reviewer || "(no reviewer)", "awaitingReview");
    if (t.status === "reviewing") bump(t.reviewer || "?", "reviewing");
  }
  const lines = [`board: ${path.join(home, "board.json")}`, `clone: ${clone}`, `tasks: ${store.state.tasks.length} (updated ${store.state.updatedAt})`];
  const rows = [...byAgent.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) lines.push("queue: empty");
  for (const [agent, r] of rows) lines.push(`${agent.padEnd(18)} queued ${r.queued}  running ${r.running}  awaiting-review ${r.awaitingReview}  reviewing ${r.reviewing}`);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const [, , command, ...rest] = process.argv;
  const argv = [command, ...rest];
  if (command === "next") next(argv).then((code) => process.exit(code), (err) => { process.stderr.write(`${err.stack || err}\n`); process.exit(1); });
  else if (command === "status") process.exit(status(argv));
  else usage(2);
}
