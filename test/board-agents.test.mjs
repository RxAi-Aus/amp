// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// AMP Board — board/lib/agents.mjs: adapter table, prompts, result extraction,
// and the spawn loop (exercised with the dev-only `fake` adapter).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ADAPTERS,
  AGENT_NAMES,
  SECTION_16_GUARD,
  availableAgents,
  buildArgv,
  buildReviewerPrompt,
  buildWorkerPrompt,
  extractResultJson,
  parseAdapterOutput,
  spawnRun,
} from "../board/lib/agents.mjs";

const fence = (obj) => "```json\n" + JSON.stringify(obj) + "\n```";

test("AGENT_NAMES lists the five assignable agents (fake is dev-only, listed last)", () => {
  assert.deepEqual(AGENT_NAMES, ["claudecowork", "codex", "agy", "hermes", "openclaw", "fake"]);
  for (const name of AGENT_NAMES) {
    assert.equal(typeof ADAPTERS[name].build, "function", name);
    assert.equal(typeof ADAPTERS[name].bin, "string", name);
  }
});

test("extractResultJson picks the last fenced JSON that carries the role key", () => {
  const worker = { status: "done", summary: "s", issue: 351, notes: "" };
  const text = `prose\n${fence({ status: "blocked", summary: "old" })}\nmore\n${fence(worker)}\ntrailing prose that is not json`;
  assert.deepEqual(extractResultJson(text, "worker"), worker);
  assert.equal(extractResultJson(text, "reviewer"), null);
  const reviewer = { verdict: "approve", notes: "fine" };
  assert.deepEqual(extractResultJson(`${fence(reviewer)}\n${fence({ status: "done" })}`, "reviewer"), reviewer);
});

test("extractResultJson skips invalid JSON and fences without the key", () => {
  const good = { status: "done", summary: "ok", issue: null, notes: "" };
  const text = "```json\n{ not json\n```\n" + fence(good) + "\n```\n{\"foo\":1}\n```";
  assert.deepEqual(extractResultJson(text, "worker"), good);
  assert.equal(extractResultJson("no fences here {\"status\":\"done\"}", "worker"), null);
  assert.equal(extractResultJson("", "worker"), null);
  assert.equal(extractResultJson(null, "worker"), null);
  // unlabeled fence and CRLF line endings are fine
  assert.deepEqual(extractResultJson("```\r\n{\"status\":\"done\",\"summary\":\"x\"}\r\n```\r\n", "worker"), { status: "done", summary: "x" });
});

test("parseAdapterOutput unwraps each agent's envelope", () => {
  const inner = { status: "done", summary: "s", issue: 1, notes: "" };
  const claude = JSON.stringify({ type: "result", subtype: "success", result: `done!\n${fence(inner)}` });
  assert.deepEqual(parseAdapterOutput("claudecowork", { stdout: claude }, "worker"), inner);
  // Envelope that already carries the fields directly (json-schema style)
  assert.deepEqual(parseAdapterOutput("agy", { stdout: JSON.stringify(inner) }, "worker"), inner);
  // Nested envelope: any string value is searched
  assert.deepEqual(parseAdapterOutput("agy", { stdout: JSON.stringify({ response: { text: fence(inner) } }) }, "worker"), inner);
  // codex: -o file first, stdout fallback
  assert.deepEqual(parseAdapterOutput("codex", { stdout: "chatter", fileText: fence(inner) }, "worker"), inner);
  assert.deepEqual(parseAdapterOutput("codex", { stdout: fence(inner), fileText: null }, "worker"), inner);
  // hermes/openclaw/fake: plain stdout tail
  assert.deepEqual(parseAdapterOutput("hermes", { stdout: `noise\n${fence(inner)}` }, "worker"), inner);
  assert.equal(parseAdapterOutput("hermes", { stdout: "nothing" }, "worker"), null);
  // Non-JSON stdout on a JSON-envelope agent still falls back to fence scanning
  assert.deepEqual(parseAdapterOutput("claudecowork", { stdout: `not json ${fence(inner)}` }, "worker"), inner);
});

test("buildWorkerPrompt names the region file, the linked issue and the trailer contract", () => {
  const task = { id: "t_1", region: "Sample", title: "Ship it", description: "Acceptance: tests pass", linkedIssue: 337 };
  const p = buildWorkerPrompt({ task, clone: "/mem/clone", agent: "codex", issueExcerpt: "Summary: publish weekly" });
  assert.match(p, /\/mem\/clone\/REGION-Sample\.md/);
  assert.match(p, /issue #337/);
  assert.match(p, /Summary: publish weekly/);
  assert.match(p, /Ship it/);
  assert.match(p, /Acceptance: tests pass/);
  assert.match(p, /\[FROM:codex→any\]\[REGION:Sample\]/);
  assert.match(p, /rxai-amp/);
  assert.match(p, /"status":\s*"done\|blocked"/);
  assert.match(p, /AMP_BOARD_TASK|t_1/);
  const noIssue = buildWorkerPrompt({ task: { ...task, linkedIssue: null }, clone: "/c", agent: "agy" });
  assert.doesNotMatch(noIssue, /issue #/);
});

test("buildReviewerPrompt carries the worker summary, issue body or its absence, and forbids edits", () => {
  const task = { id: "t_1", region: "Sample", title: "Ship it", description: "Acceptance: tests pass", result: { summary: "I shipped", issue: 351, notes: "" } };
  const withBody = buildReviewerPrompt({ task, clone: "/c", agent: "claudecowork", issueBody: "## Message\nbody text" });
  assert.match(withBody, /I shipped/);
  assert.match(withBody, /#351/);
  assert.match(withBody, /body text/);
  assert.match(withBody, /do not modify/i);
  assert.match(withBody, /"verdict":\s*"approve\|reject"/);
  const noBody = buildReviewerPrompt({ task, clone: "/c", agent: "claudecowork", issueBody: null });
  assert.match(noBody, /not yet in local clone/);
});

test("prompts never embed environment values", () => {
  process.env.AMP_BOARD_TEST_CANARY = "hunter2-canary-value";
  try {
    const task = { id: "t_1", region: "Sample", title: "x", description: "y", linkedIssue: null, result: { summary: "s", issue: null } };
    assert.doesNotMatch(buildWorkerPrompt({ task, clone: "/c", agent: "codex" }), /hunter2/);
    assert.doesNotMatch(buildReviewerPrompt({ task, clone: "/c", agent: "codex" }), /hunter2/);
  } finally {
    delete process.env.AMP_BOARD_TEST_CANARY;
  }
});

test("buildArgv keeps the prompt as one argv element and honours yolo", () => {
  const base = { prompt: "do; rm -rf / && echo $HOME", cwd: "/work", clone: "/mem", logPath: "/logs/r_1.log", role: "worker" };
  const claude = buildArgv("claudecowork", { ...base, yolo: false });
  assert.equal(claude.argv[0], "claude");
  assert.ok(claude.argv.includes(base.prompt));
  assert.ok(claude.argv.includes("--add-dir") && claude.argv.includes("/mem"));
  assert.ok(claude.argv.includes("--permission-mode"));
  assert.ok(!claude.argv.includes("--dangerously-skip-permissions"));
  assert.ok(claude.argv.includes(SECTION_16_GUARD));
  assert.ok(buildArgv("claudecowork", { ...base, yolo: true }).argv.includes("--dangerously-skip-permissions"));

  const codex = buildArgv("codex", base);
  assert.deepEqual(codex.argv.slice(0, 2), ["codex", "exec"]);
  assert.ok(codex.argv.includes("-C") && codex.argv.includes("/work"));
  assert.ok(codex.argv.includes("workspace-write"));
  assert.equal(codex.resultFile, "/logs/r_1.log.last.md");
  assert.ok(codex.argv.includes(codex.resultFile));
  assert.ok(buildArgv("codex", { ...base, yolo: true }).argv.includes("danger-full-access"));

  const agy = buildArgv("agy", base);
  assert.equal(agy.argv[0], "agy");
  assert.ok(agy.argv.includes("--print-timeout"));
  assert.ok(agy.argv.includes("--add-dir") && agy.argv.includes("/mem"));

  const hermes = buildArgv("hermes", base);
  assert.deepEqual(hermes.argv.slice(0, 3), ["hermes", "-z", base.prompt]);
  assert.ok(buildArgv("hermes", { ...base, yolo: true }).argv.includes("--yolo"));

  const openclaw = buildArgv("openclaw", base);
  assert.deepEqual(openclaw.argv.slice(0, 2), ["openclaw", "agent"]);

  const fake = buildArgv("fake", base);
  assert.equal(fake.argv[0], process.execPath);
  assert.equal(fake.argv[1], "-e");
  assert.throws(() => buildArgv("nope", base), /unknown agent/);
});

test("availableAgents reports openclaw as unavailable until verified and fake as available", () => {
  const list = availableAgents();
  assert.deepEqual(list.map((a) => a.name), AGENT_NAMES);
  const byName = Object.fromEntries(list.map((a) => [a.name, a]));
  assert.equal(byName.openclaw.available, false);
  assert.equal(byName.openclaw.verified, false);
  assert.equal(byName.fake.available, true);
  for (const a of list) assert.equal(typeof a.available, "boolean");
});

async function runFake(extraEnv, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "amp-board-run-"));
  const logPath = path.join(dir, "r_test.log");
  const built = buildArgv("fake", { prompt: "p", cwd: dir, clone: dir, logPath, role: opts.role || "worker", yolo: false });
  const run = spawnRun({
    argv: built.argv,
    cwd: dir,
    env: { ...process.env, ...extraEnv, RXAI_AMP_AGENT: "fake", AMP_BOARD_TASK: "t_x" },
    logPath,
    timeoutMs: opts.timeoutMs ?? 10_000,
    killGraceMs: 200,
  });
  return { dir, logPath, run, built };
}

test("spawnRun (fake): streams to the log, returns exit code and stdout tail with the trailer", async () => {
  const { dir, logPath, run } = await runFake({});
  try {
    assert.ok(run.child.pid > 0);
    const done = await run.done;
    assert.equal(done.exitCode, 0);
    assert.equal(done.timedOut, false);
    assert.equal(done.cancelled, false);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /fake worker starting/);
    assert.match(log, /\[err\] fake stderr line/);
    assert.deepEqual(extractResultJson(done.stdout, "worker"), { status: "done", summary: "fake run ok", issue: null, notes: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnRun (fake): AMP_FAKE_RESULT / AMP_FAKE_EXIT drive the outcome; reviewer default is approve", async () => {
  const blocked = await runFake({ AMP_FAKE_RESULT: JSON.stringify({ status: "blocked", summary: "need creds", issue: null, notes: "n" }) });
  try {
    const d = await blocked.run.done;
    assert.equal(extractResultJson(d.stdout, "worker").status, "blocked");
  } finally {
    rmSync(blocked.dir, { recursive: true, force: true });
  }
  const failing = await runFake({ AMP_FAKE_EXIT: "3" });
  try {
    assert.equal((await failing.run.done).exitCode, 3);
  } finally {
    rmSync(failing.dir, { recursive: true, force: true });
  }
  const reviewer = await runFake({}, { role: "reviewer" });
  try {
    assert.deepEqual(extractResultJson((await reviewer.run.done).stdout, "reviewer"), { verdict: "approve", notes: "fake review ok" });
  } finally {
    rmSync(reviewer.dir, { recursive: true, force: true });
  }
});

test("spawnRun: timeout terminates the child; cancel kills it", async () => {
  const slow = await runFake({ AMP_FAKE_SLEEP_MS: "5000" }, { timeoutMs: 300 });
  try {
    const d = await slow.run.done;
    assert.equal(d.timedOut, true);
    assert.notEqual(d.exitCode, 0);
  } finally {
    rmSync(slow.dir, { recursive: true, force: true });
  }
  const cancelled = await runFake({ AMP_FAKE_SLEEP_MS: "5000" });
  try {
    const pid = cancelled.run.child.pid;
    setTimeout(() => cancelled.run.cancel(), 100);
    const d = await cancelled.run.done;
    assert.equal(d.cancelled, true);
    await new Promise((r) => setTimeout(r, 50));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "child should be dead after cancel");
  } finally {
    rmSync(cancelled.dir, { recursive: true, force: true });
  }
});

test("spawnRun: a missing binary resolves with a spawn error instead of throwing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amp-board-run-"));
  try {
    const logPath = path.join(dir, "r.log");
    const run = spawnRun({ argv: ["definitely-not-a-binary-xyz", "--flag"], cwd: dir, env: process.env, logPath, timeoutMs: 1000, killGraceMs: 50 });
    const d = await run.done;
    assert.match(d.error, /ENOENT|spawn/);
    assert.equal(d.exitCode, null);
    assert.equal(existsSync(logPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
