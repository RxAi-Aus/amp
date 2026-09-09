// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// AMP Board — board/cli.mjs pull mode: standalone (server down) and
// server-delegating (server up), both with the dev-only `fake` adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emptyState, newTask, reduce } from "../board/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const clone = path.join(here, "fixtures/board/clone");
const cli = path.join(root, "board/cli.mjs");

function seedHome(tasks) {
  const home = mkdtempSync(path.join(tmpdir(), "amp-board-cli-"));
  let s = emptyState("2026-09-02T00:00:00.000Z");
  tasks.forEach((t, i) => {
    const at = `2026-09-02T00:00:0${i}.000Z`;
    s = reduce(s, { type: "task/create", task: newTask({ region: "Sample", ...t }, at, `t_seed${i}`), at });
  });
  writeFileSync(path.join(home, "board.json"), JSON.stringify(s));
  return home;
}

function runCli(args, home, extraEnv = {}) {
  const r = spawnSync(process.execPath, [cli, ...args, "--clone", clone], {
    env: { ...process.env, RXAI_AMP_HOME: home, AMP_BOARD_PORT: "1", ...extraEnv }, // port 1: nothing listens → standalone
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const board = (home) => JSON.parse(readFileSync(path.join(home, "board.json"), "utf8"));

test("next: empty queue prints 'nothing to do', exits 0 and spawns nothing", () => {
  const home = seedHome([{ title: "for codex", assignee: "codex" }]);
  try {
    const r = runCli(["next", "--agent", "fake"], home);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /nothing to do/);
    assert.equal(board(home).tasks[0].runs.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("next (standalone): claims the oldest matching task, runs it, exits 0 on done", () => {
  const home = seedHome([
    { title: "older [fake:sleep=100][fake:issue=7]", assignee: "fake" },
    { title: "newer [fake:sleep=100]", assignee: "fake" },
  ]);
  try {
    const r = runCli(["next", "--agent", "fake"], home);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /claimed t_seed0 "older/);
    assert.match(r.out, /standalone/);
    assert.match(r.out, /fake worker starting task t_seed0/); // log tail streamed to stdout
    assert.match(r.out, /t_seed0 → finished/);
    const b = board(home);
    assert.equal(b.tasks[0].status, "finished");
    assert.equal(b.tasks[0].result.issue, 7);
    assert.equal(b.tasks[0].runs[0].trigger, "pull");
    assert.equal(b.tasks[1].status, "queued");
    assert.equal(b.tasks[1].runs.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("next (standalone): failed worker exits 1; --max drains several; --role reviewer pulls finished tasks", () => {
  const home = seedHome([
    { title: "boom [fake:exit=2][fake:sleep=50]", assignee: "fake" },
    { title: "ok [fake:sleep=50]", assignee: "fake" },
  ]);
  try {
    const fail = runCli(["next", "--agent", "fake"], home);
    assert.equal(fail.code, 1);
    assert.match(fail.out, /t_seed0 → failed/);
    const ok = runCli(["next", "--agent", "fake", "--max", "3"], home);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(board(home).tasks[1].status, "finished");
    // nobody is the reviewer yet
    assert.match(runCli(["next", "--agent", "fake", "--role", "reviewer"], home).out, /nothing to do/);
    const b = board(home);
    b.tasks[1].reviewer = "fake";
    writeFileSync(path.join(home, "board.json"), JSON.stringify(b));
    const rev = runCli(["next", "--agent", "fake", "--role", "reviewer"], home);
    assert.equal(rev.code, 0, rev.err);
    assert.match(rev.out, /t_seed1 → approval/);
    assert.equal(board(home).tasks[1].review.verdict, "approve");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("next --dry-run reports the claim without running; unknown agent exits 2", () => {
  const home = seedHome([{ title: "dry", assignee: "fake" }]);
  try {
    const r = runCli(["next", "--agent", "fake", "--dry-run"], home);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /would claim t_seed0 "dry"/);
    assert.match(r.out, /argv:/);
    assert.equal(board(home).tasks[0].status, "queued");
    assert.equal(runCli(["next", "--agent", "nope"], home).code, 2);
    assert.equal(runCli(["next"], home).code, 2);
    assert.equal(runCli(["bogus"], home).code, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status prints per-agent queue counts", () => {
  const home = seedHome([
    { title: "a", assignee: "fake" },
    { title: "b", assignee: "fake" },
    { title: "c", assignee: "codex" },
    { title: "d" },
  ]);
  try {
    const r = runCli(["status"], home);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /fake\s+queued 2/);
    assert.match(r.out, /codex\s+queued 1/);
    assert.match(r.out, /\(unassigned\)\s+queued 1/);
    assert.match(r.out, /tasks: 4/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("next delegates to a running server via POST /api/pull and waits for the outcome", async () => {
  const home = seedHome([{ title: "via server [fake:sleep=300]", assignee: "fake" }]);
  const server = spawn(process.execPath, [path.join(root, "board/server.mjs"), "--clone", clone, "--port", "0"], {
    env: { ...process.env, RXAI_AMP_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = "";
      server.stdout.on("data", (d) => {
        out += d.toString();
        const m = out.match(/127\.0\.0\.1:(\d+)/);
        if (m) resolve(m[1]);
      });
      server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
      setTimeout(() => reject(new Error("server did not start")), 8000);
    });
    const r = runCli(["next", "--agent", "fake", "--port", port], home);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /claimed t_seed0 .* via server/);
    assert.match(r.out, /t_seed0 → finished/);
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/t_seed0`);
    const { task } = await res.json();
    assert.equal(task.status, "finished");
    assert.equal(task.runs[0].trigger, "pull");
    assert.match(runCli(["next", "--agent", "fake", "--port", port], home).out, /nothing to do/);
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
    rmSync(home, { recursive: true, force: true });
  }
});
