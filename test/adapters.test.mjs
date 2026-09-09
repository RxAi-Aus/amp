// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// PROTOCOL.md §15.5 — adapter wiring: hook templates must point at files that
// exist, keep their identity/placeholder contract, and stay fail-soft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLedger, obligations, openLedger, recordBoundary, saveLedger, surfaceIssue } from "../adapters/lib/amp-ledger.mjs";
import {
  collectCandidates,
  compactIndex,
  compactNotIndexed,
  excerptOf,
  parseNotIndexed,
  parseRegionFile,
  regionMatches,
} from "../adapters/lib/amp-recall.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agyHooks = JSON.parse(readFileSync(path.join(root, "adapters/agy/hooks.json"), "utf8"));

/** Every command in an agy hooks.json entry, flattened. */
function commands(entry) {
  return Object.values(entry).flatMap((handlers) => handlers.map((h) => h.command));
}

test("agy hooks.json registers RECALL and CAPTURE under one owned key", () => {
  assert.deepEqual(Object.keys(agyHooks), ["rxai-amp"]);
  assert.deepEqual(Object.keys(agyHooks["rxai-amp"]).sort(), ["PreInvocation", "Stop"]);
});

test("agy hook commands are placeholder-rooted, agy-identified, and point at real files", () => {
  for (const command of commands(agyHooks["rxai-amp"])) {
    assert.match(command, /^RXAI_AMP_AGENT=agy node "__AMP_ROOT__\//, `identity/placeholder: ${command}`);
    const relative = command.match(/__AMP_ROOT__\/([^"]+)/)[1];
    assert.ok(existsSync(path.join(root, relative)), `missing hook script: ${relative}`);
  }
});

test("agy hooks stay inside agy's default 30 s timeout budget", () => {
  for (const handlers of Object.values(agyHooks["rxai-amp"])) {
    for (const handler of handlers) {
      assert.ok(handler.timeout > 0 && handler.timeout <= 30, `timeout out of range: ${handler.timeout}`);
    }
  }
});

// §15.5 fail-soft: agy parses stdout as JSON, so every exit must emit an
// object — and a disabled/unresolvable AMP must never block the loop.
for (const hook of ["pre-invocation", "stop"]) {
  test(`agy ${hook} hook emits {} and exits 0 when AMP is disabled`, () => {
    const out = execFileSync("node", [path.join(root, "adapters/agy/hooks", `${hook}.mjs`)], {
      input: JSON.stringify({ conversationId: "test", workspacePaths: [root] }),
      encoding: "utf8",
      env: { ...process.env, AMP_DISABLE: "1" },
      timeout: 20_000,
    });
    assert.deepEqual(JSON.parse(out), {});
  });

  test(`agy ${hook} hook emits {} on garbage input`, () => {
    const out = execFileSync("node", [path.join(root, "adapters/agy/hooks", `${hook}.mjs`)], {
      input: "not json at all",
      encoding: "utf8",
      env: { ...process.env, AMP_DISABLE: "1" },
      timeout: 20_000,
    });
    assert.deepEqual(JSON.parse(out), {});
  });
}

test("codex skill mirror keeps the rxai-amp identity and posts as codex", () => {
  const skill = readFileSync(path.join(root, "adapters/codex/skills/rxai-amp/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: rxai-amp\n/);
  assert.match(skill, /## Codex specifics/);
  // L1 has no trigger: the skill must say so, or Codex waits for a checkpoint
  // that can never arrive.
  assert.match(skill, /nothing will trigger you/i);
  const summary = readFileSync(path.join(root, "adapters/codex/skills/rxai-amp/examples/session-summary.md"), "utf8");
  assert.match(summary, /\[FROM:codex→self\]\[REGION:codex-diary\]/);
});

// Every L1 digest must carry the three obligations, the sentinels the
// installers splice on, and its agent's own identity (a copied digest that
// still names another agent would post into the wrong diary).
for (const agent of ["codex", "openclaw", "hermes"]) {
  test(`${agent} digest carries the three obligations, sentinels and identity`, () => {
    const digest = readFileSync(path.join(root, `adapters/${agent}/digest.md`), "utf8");
    assert.match(digest, /^<!-- rxai-amp-digest v1/);
    assert.match(digest.trimEnd(), /<!-- \/rxai-amp-digest -->$/);
    for (const obligation of ["RECALL", "CAPTURE", "OUTCOME"]) {
      assert.match(digest, new RegExp(`\\*\\*${obligation}\\*\\*`), `digest is missing ${obligation}`);
    }
    assert.match(digest, new RegExp(`\\*\\*\`${agent}\`\\*\\*`), "digest must name its own agent");
    for (const other of ["codex", "openclaw", "hermes"].filter((a) => a !== agent)) {
      assert.ok(!digest.includes(`${other}-diary`), `digest leaks ${other}'s diary region`);
    }
  });
}

test("agy skill mirror keeps the rxai-amp identity and the gh (not MCP) write path", () => {
  const skill = readFileSync(path.join(root, "adapters/agy/skills/rxai-amp/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: rxai-amp\n/);
  assert.match(skill, /gh issue create/);
  assert.match(skill, /No GitHub MCP server in agy/);
  // The sender in the examples must be agy, or agy posts into another
  // agent's diary Region (PROTOCOL.md §2 identity).
  const summary = readFileSync(path.join(root, "adapters/agy/skills/rxai-amp/examples/session-summary.md"), "utf8");
  assert.match(summary, /\[FROM:agy→self\]\[REGION:agy-diary\]/);
});

// §15.1 CAPTURE floor: the Claude Code PostToolUse observer records a
// boundary for a real `git commit` and for nothing else — a command whose
// text merely contains "git" and "commit" (e.g. reading
// adapters/git-hooks/post-commit) must not create a capture obligation.
test("claude-code post-tool-use records boundaries only for real git commit commands", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-hook-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // Isolate from the developer's own AMP setup: fresh home, slug-only config.
  const { AMP_DISABLE: _disable, RXAI_AMP_REPO: _repo, ...baseEnv } = process.env;
  const env = { ...baseEnv, RXAI_AMP_HOME: home, RXAI_AMP_SLUG: "test-owner/test-memory" };

  const cases = [
    ['git commit -m "fix: thing"', 1],
    ["git -C /tmp/repo commit -am wip", 1],
    ["git -c user.name=x commit --amend --no-edit", 1],
    ["git add -A && git commit -m x", 1],
    ["git commit --dry-run", 0],
    ["cat adapters/git-hooks/post-commit", 0],
    ["git log --grep commit", 0],
    ["git commit-tree HEAD^{tree}", 0],
    ["npm run hooks:install:capture -- ./repo", 0],
  ];

  for (const [command, expected] of cases) {
    const sessionId = `t-${Math.random().toString(36).slice(2)}`;
    execFileSync("node", [path.join(root, "adapters/claude-code/hooks/post-tool-use.mjs")], {
      input: JSON.stringify({ session_id: sessionId, cwd: root, tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
      env,
      timeout: 20_000,
    });
    const ledgerFile = path.join(home, "sessions", `${sessionId}.json`);
    const boundaries = existsSync(ledgerFile)
      ? JSON.parse(readFileSync(ledgerFile, "utf8")).capture.boundaries.length
      : 0;
    assert.equal(boundaries, expected, `command: ${command}`);
  }
});

// §15.1 RECALL, issue #442 — repo-aware recall: the injected excerpt must be
// the whole `## Message` section (capped), and candidates must rank
// intent-first with fresh unindexed rows and branch-matching Places ahead.
test("amp-recall excerptOf returns the whole Message section, not its first line", () => {
  const body =
    "## Metadata\n- **From:** x\n\n## Message\n**Finding.**\n\nSecond paragraph.\n\n1. one\n2. two\n\n## Expected Action\n- [x] Execute task\n";
  assert.equal(excerptOf(body), "**Finding.**\n\nSecond paragraph.\n\n1. one\n2. two");
  assert.equal(excerptOf("## Message\nline one\nline two"), "line one\nline two");
  // No Message section: Metadata is dropped, the rest is kept.
  assert.equal(excerptOf("## Metadata\n- a\n\n## Summary\nno message section"), "## Summary\nno message section");
  const capped = excerptOf("## Message\n" + "x".repeat(2000), 100);
  assert.ok(capped.length <= 102 && capped.endsWith(" …"), `cap not applied: ${capped.length}`);
});

test("amp-recall parses REGION pointer tables and not_indexed rows", () => {
  const region = [
    "# Region: Acme - Pointer Table",
    "",
    "## Place: adapters",
    "",
    "  ### Type: intent",
    "  | Issue | Summary | Comments | Weight | Last Updated |",
    "  |-------|---------|----------|--------|-------------|",
    "  | #416 | Count only real git commits | 3 | 0.8587 | 2026-09-05 |",
    "",
    "  ### Type: facts",
    "  | Issue | Summary | Comments | Weight | Last Updated |",
    "  |-------|---------|----------|--------|-------------|",
    "  | #397 | Clone relocated | 0 | 0.4877 | 2026-09-02 |",
    "",
    "## Place: board",
    "",
    "  ### Type: intent",
    "  | Issue | Summary | Comments | Weight | Last Updated |",
    "  |-------|---------|----------|--------|-------------|",
    "  | #395 | AMP Board | 0 | 0.61 | 2026-09-01 |",
    "",
  ].join("\n");
  assert.deepEqual(
    parseRegionFile(region, "Acme").map(({ issue, place, type, weight }) => ({ issue, place, type, weight })),
    [
      { issue: 416, place: "adapters", type: "intent", weight: 0.8587 },
      { issue: 397, place: "adapters", type: "facts", weight: 0.4877 },
      { issue: 395, place: "board", type: "intent", weight: 0.61 },
    ]
  );
  const rows = parseNotIndexed(
    "| Issue | From | Region | Place | Type | Posted |\n|---|---|---|---|---|---|\n| #412 | codex | codex-diary | sessions | intent | 2026-09-04T09:37:54Z |\n"
  );
  assert.deepEqual(rows.map(({ issue, region, place, type, weight, source }) => ({ issue, region, place, type, weight, source })), [
    { issue: 412, region: "codex-diary", place: "sessions", type: "intent", weight: 1, source: "unindexed" },
  ]);
});

test("amp-recall matches regions to repo names and ranks candidates intent-first", (t) => {
  assert.ok(regionMatches("AgentMemory", ["githubMemoryAgent", "AgentMemory"]));
  assert.ok(regionMatches("Acme", ["acme-web"]));
  assert.ok(!regionMatches("AgentMemory", ["acme-mobile"]));

  const clone = mkdtempSync(path.join(tmpdir(), "amp-recall-test-"));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  writeFileSync(
    path.join(clone, "REGION-Acme.md"),
    [
      "## Place: adapters",
      "  ### Type: intent",
      "  | #10 | older intent | 0 | 0.5 | 2026-09-01 |",
      "  ### Type: facts",
      "  | #11 | strong fact | 0 | 0.9 | 2026-09-01 |",
      "## Place: feature-x",
      "  ### Type: intent",
      "  | #12 | branch intent | 0 | 0.3 | 2026-09-01 |",
      "",
    ].join("\n")
  );
  writeFileSync(path.join(clone, "not_indexed.md"), "| #20 | codex | Acme | sessions | facts | 2026-09-04T09:37:54Z |\n");
  writeFileSync(path.join(clone, "REGION-Other.md"), "## Place: p\n  ### Type: intent\n  | #99 | unrelated | 0 | 1.0 | 2026-09-01 |\n");
  const ranked = collectCandidates(clone, { names: ["acme-web"], branch: "feature-x" }).map((c) => c.issue);
  // intent (#12 matches branch, then #10 by weight) → facts (#20 unindexed = 1.0, then #11); #99 is another region.
  assert.deepEqual(ranked, [12, 10, 20, 11]);
});

// §15.1 OUTCOME / §15.2 — memories an adapter injects at session start are
// recorded `via: "inject"` and never create an obligation by themselves;
// only issues the agent fetched (CLI, MCP observer, pre-`via` ledgers) do.
test("amp-ledger tells injected memories from agent-fetched ones in obligations", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-ledger-test-"));
  const previousHome = process.env.RXAI_AMP_HOME;
  process.env.RXAI_AMP_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.RXAI_AMP_HOME;
    else process.env.RXAI_AMP_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const id = "ledger-via-test";
  openLedger(id);
  surfaceIssue(id, 442, "[…][TYPE:intent] injected", "inject");
  surfaceIssue(id, 416, "[…][TYPE:intent] injected too", "inject");
  let o = obligations(loadLedger(id));
  assert.deepEqual(
    { trivial: o.trivial, fetched: o.fetched.length, injected: o.injected.length, unmarked: o.unmarked.length },
    { trivial: true, fetched: 0, injected: 2, unmarked: 0 }
  );

  // The agent fetches one of the injected issues itself → agent-surfaced.
  surfaceIssue(id, 442, "[…][TYPE:intent] injected");
  o = obligations(loadLedger(id));
  assert.equal(o.trivial, false);
  assert.deepEqual(o.unmarked.map((s) => s.issue), [442]);
  assert.equal(loadLedger(id).recall.surfaced.find((s) => s.issue === 442).via, "agent");

  // The CLI defaults to "agent" and accepts --via inject.
  execFileSync(
    "node",
    [path.join(root, "adapters/lib/amp-ledger.mjs"), "surface", id, "12", "--via", "inject", "[…] title words"],
    { env: { ...process.env, RXAI_AMP_HOME: home }, encoding: "utf8" }
  );
  const twelve = loadLedger(id).recall.surfaced.find((s) => s.issue === 12);
  assert.deepEqual({ via: twelve.via, title: twelve.title }, { via: "inject", title: "[…] title words" });

  // Ledgers written before `via` existed count as agent-fetched.
  const legacy = loadLedger(id);
  legacy.recall.surfaced = [{ issue: 47, title: "old", disposition: "unknown", outcome_posted: null }];
  saveLedger(legacy);
  o = obligations(loadLedger(id));
  assert.deepEqual({ fetched: o.fetched.length, trivial: o.trivial }, { fetched: 1, trivial: false });

  // A boundary makes the session meaningful regardless of recall.
  recordBoundary(id, "acme-web", "abc1234", "feat: x");
  assert.equal(obligations(loadLedger(id)).meaningful, true);
});

// Regression from the 2026-09-06 A/B run: with repo-aware recall every
// session in a repo that has memories was blocked once at Stop, because
// injected memories were ledgered like agent fetches. A ledger holding only
// injected surfaces and no boundaries must let the Stop hook exit 0 with no
// block; one the agent fetched itself still gets the single checkpoint.
test("claude-code stop hook does not block a session whose only recall was injected", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-stop-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // No token in the environment: the remote-verify step must not run.
  const { AMP_DISABLE: _d, RXAI_AMP_REPO: _r, GH_TOKEN: _g, GITHUB_TOKEN: _gt, GITHUB_PERSONAL_ACCESS_TOKEN: _gp, ...baseEnv } =
    process.env;
  const env = { ...baseEnv, RXAI_AMP_HOME: home, RXAI_AMP_SLUG: "test-owner/test-memory" };
  const ledgerCli = path.join(root, "adapters/lib/amp-ledger.mjs");
  const ledger = (...args) => execFileSync("node", [ledgerCli, ...args], { env, encoding: "utf8" });
  const runStop = (sessionId) =>
    execFileSync("node", [path.join(root, "adapters/claude-code/hooks/stop.mjs")], {
      input: JSON.stringify({ session_id: sessionId, stop_hook_active: false, cwd: root }),
      encoding: "utf8",
      env,
      timeout: 20_000,
    });
  const ledgerOf = (sessionId) => JSON.parse(readFileSync(path.join(home, "sessions", `${sessionId}.json`), "utf8"));

  const quiet = "stop-injected-only";
  ledger("open", quiet);
  ledger("surface", quiet, "442", "--via", "inject", "injected intent");
  ledger("surface", quiet, "416", "--via", "inject", "injected intent");
  assert.equal(runStop(quiet), "");
  assert.equal(ledgerOf(quiet).status, "closed");

  const fetched = "stop-agent-fetched";
  ledger("open", fetched);
  ledger("surface", fetched, "442", "--via", "inject", "injected intent");
  ledger("surface", fetched, "401", "fetched pattern");
  const out = JSON.parse(runStop(fetched));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Recalled this session: #401 \(fetched pattern\)\./);
  assert.match(out.reason, /Injected at session start: #442 \(injected intent\)\./);
  assert.equal(ledgerOf(fetched).capture.nagged, true);
  // Block once: the re-entry passes.
  assert.equal(runStop(fetched), "");
});

// §15.1 RECALL budget — with a matched Region the navigation layer is
// rendered around it (matched Region verbatim, the rest one line, an empty
// not_indexed.md one line), and the injected memories are ledgered via
// "inject" so the Stop hook lets the session end quietly.
test("amp-recall compactIndex keeps matched Regions verbatim and collapses the rest", () => {
  const index = [
    "# Agent Memory Index",
    "",
    "**Last Compiled:** 2026-09-06T06:12:58Z  ",
    "",
    "---",
    "",
    "## Region: Acme",
    "  > Active threads: #10 (w:0.5).  ",
    "",
    "## Region: Other",
    "  > Active threads: #99 (w:1), #98 (w:0.4).  ",
    "  > Archived: 2 issues. See REGION-Other.md for full table.  ",
    "",
    "## Region: Quiet",
    "  > Active threads: none.  ",
    "",
  ].join("\n");
  assert.equal(
    compactIndex(index, ["acme"]),
    [
      "# Agent Memory Index",
      "",
      "**Last Compiled:** 2026-09-06T06:12:58Z",
      "",
      "## Region: Acme",
      "  > Active threads: #10 (w:0.5).",
      "",
      "Other Regions (2; pointer tables in REGION-<name>.md): Other (#99 #98); Quiet (no active threads).",
      "",
    ].join("\n")
  );
  assert.equal(compactIndex(index, []), index); // nothing matched → verbatim
  assert.equal(compactIndex("no regions here", ["acme"]), "no regions here");

  const rows = "# Not Yet Indexed\n\n**Unindexed Issue Count:** 1\n\n| #443 | codex | R | p | facts | t |\n";
  assert.equal(compactNotIndexed(rows), rows);
  assert.equal(
    compactNotIndexed(
      "# Not Yet Indexed\n\n**Since Last Index Compile:** 2026-09-06T06:12:58Z\n**Unindexed Issue Count:** 0\n\n| Issue | From |\n|---|---|\n"
    ),
    "# Not Yet Indexed — empty (0 issues since the last compile at 2026-09-06T06:12:58Z)\n"
  );
});

test("claude-code session-start compacts the navigation layer and ledgers injected memories via inject", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-start-home-"));
  const clone = mkdtempSync(path.join(tmpdir(), "amp-start-clone-"));
  const work = mkdtempSync(path.join(tmpdir(), "amp-start-work-"));
  const cwd = path.join(work, "acme-web");
  mkdirSync(cwd);
  t.after(() => {
    for (const dir of [home, clone, work]) rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    path.join(clone, "INDEX.md"),
    [
      "# Agent Memory Index",
      "",
      "**Last Compiled:** 2026-09-06T06:12:58Z  ",
      "**Total Issues Indexed:** 3  ",
      "",
      "---",
      "",
      "## Region: Acme",
      "  > **Summary:** Summary not yet generated for this Region.  ",
      "  > Active threads: #10 (w:0.5).  ",
      "",
      "## Region: Other",
      "  > Active threads: #99 (w:1), #98 (w:0.4).  ",
      "",
    ].join("\n")
  );
  writeFileSync(path.join(clone, "REGION-Acme.md"), "## Place: adapters\n  ### Type: intent\n  | #10 | acme intent | 0 | 0.5 | 2026-09-01 |\n");
  writeFileSync(
    path.join(clone, "not_indexed.md"),
    "# Not Yet Indexed\n\n**Since Last Index Compile:** 2026-09-06T06:12:58Z\n**Unindexed Issue Count:** 0\n\n| Issue | From | Region | Place | Type | Posted |\n|-------|------|------|------|------|--------|\n"
  );
  // Clone path only, no slug: nothing is fetched from GitHub (bodies stay "not fetched").
  const { AMP_DISABLE: _d, RXAI_AMP_SLUG: _s, GH_TOKEN: _g, GITHUB_TOKEN: _gt, GITHUB_PERSONAL_ACCESS_TOKEN: _gp, ...baseEnv } =
    process.env;
  const env = { ...baseEnv, RXAI_AMP_HOME: home, RXAI_AMP_REPO: clone };
  const sessionId = "start-compact-test";
  const out = execFileSync("node", [path.join(root, "adapters/claude-code/hooks/session-start.mjs")], {
    input: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: "SessionStart", source: "startup" }),
    encoding: "utf8",
    env,
    timeout: 20_000,
  });
  assert.match(out, /\*\*Last Compiled:\*\* 2026-09-06T06:12:58Z/);
  assert.match(out, /## Region: Acme\n.*\n.*Active threads: #10/);
  assert.doesNotMatch(out, /## Region: Other/);
  assert.match(out, /Other Regions \(1; pointer tables in REGION-<name>\.md\): Other \(#99 #98\)\./);
  assert.match(out, /--- not_indexed\.md ---\n# Not Yet Indexed — empty \(0 issues since the last compile at 2026-09-06T06:12:58Z\)\n/);
  assert.match(out, /--- Memories for this repo \(acme-web\)/);
  assert.match(out, /#10 \[intent · adapters · w:0\.50\] acme intent/);
  const ledgerFile = path.join(home, "sessions", `${sessionId}.json`);
  assert.deepEqual(JSON.parse(readFileSync(ledgerFile, "utf8")).recall.surfaced.map((s) => [s.issue, s.via]), [[10, "inject"]]);

  // …and the Stop hook lets this session end without a checkpoint.
  const stop = execFileSync("node", [path.join(root, "adapters/claude-code/hooks/stop.mjs")], {
    input: JSON.stringify({ session_id: sessionId, stop_hook_active: false, cwd }),
    encoding: "utf8",
    env,
    timeout: 20_000,
  });
  assert.equal(stop, "");
  assert.equal(JSON.parse(readFileSync(ledgerFile, "utf8")).status, "closed");
});
