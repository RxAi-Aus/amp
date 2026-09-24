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
  MATCH_THRESHOLD,
  collectCandidates,
  compactIndex,
  compactNotIndexed,
  excerptOf,
  matchPrompt,
  termFrequencies,
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
  assert.match(skill, /Conformance L2 — required, not optional/);
  assert.doesNotMatch(skill, /L1 fallback/);
  const summary = readFileSync(path.join(root, "adapters/codex/skills/rxai-amp/examples/session-summary.md"), "utf8");
  assert.match(summary, /\[FROM:codex→self\]\[REGION:codex-diary\]/);
});

test("codex installer merges L2 hooks without replacing foreign hooks", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-codex-install-"));
  const codexHome = path.join(home, "codex");
  const ampHome = path.join(home, "amp");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    path.join(codexHome, "hooks.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "foreign-stop" }] }] } })
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const args = [
    path.join(root, "scripts/install-codex.mjs"),
    "--repo-path", root,
    "--repo-slug", "test-owner/test-memory",
    "--codex-home", codexHome,
    "--no-label",
  ];
  const env = { ...process.env, RXAI_AMP_HOME: ampHome };
  execFileSync("node", args, { env, encoding: "utf8" });
  execFileSync("node", args, { env, encoding: "utf8" }); // idempotent

  const installed = JSON.parse(readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(installed.hooks).sort(), ["PostToolUse", "SessionEnd", "SessionStart", "Stop"]);
  assert.equal(installed.hooks.Stop.length, 2);
  assert.equal(installed.hooks.Stop[0].hooks[0].command, "foreign-stop");
  for (const event of ["SessionStart", "PostToolUse", "SessionEnd"]) {
    assert.equal(installed.hooks[event].length, 1, `${event} duplicated on reinstall`);
  }
  for (const groups of Object.values(installed.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.command === "foreign-stop") continue;
        assert.match(hook.command, /RXAI_AMP_AGENT='codex'/);
        const script = hook.command.match(/'([^']*adapters\/codex\/hooks\/[^']+)'$/)?.[1];
        assert.ok(script && existsSync(script), `missing installed hook target: ${hook.command}`);
      }
    }
  }
});

// The Claude Code installer registers all five lifecycle events — SessionEnd
// included, since Stop no longer closes the ledger — keeps foreign hooks and
// other settings, and is idempotent. HOME is redirected so the test never
// touches the real ~/.claude.
test("claude-code installer registers the five lifecycle hooks and keeps foreign ones", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-claude-install-"));
  const claudeDir = path.join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "foreign-stop" }] }] }, model: "keep-me" })
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const args = [path.join(root, "scripts/install-claude-hooks.mjs"), "--repo-path", root, "--repo-slug", "test-owner/test-memory"];
  const env = { ...process.env, HOME: home, RXAI_AMP_HOME: path.join(home, "amp") };
  execFileSync("node", args, { env, encoding: "utf8" });
  execFileSync("node", args, { env, encoding: "utf8" }); // idempotent
  const settings = JSON.parse(readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
  assert.equal(settings.model, "keep-me");
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(settings.hooks.Stop.length, 2, "foreign Stop entry lost or ours duplicated");
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "foreign-stop");
  for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd", "PostToolUse"]) {
    assert.equal(settings.hooks[event].length, 1, `${event} duplicated on reinstall`);
    const script = settings.hooks[event][0].hooks[0].command.match(/^node "(.+)"$/)?.[1];
    assert.ok(script && existsSync(script), `missing installed hook target for ${event}`);
  }
  assert.match(settings.hooks.SessionEnd[0].hooks[0].command, /adapters\/claude-code\/hooks\/session-end\.mjs/);
});

for (const hook of ["session-start", "post-tool-use", "stop", "session-end"]) {
  test(`codex ${hook} hook is fail-soft when AMP is disabled`, () => {
    const out = execFileSync("node", [path.join(root, "adapters/codex/hooks", `${hook}.mjs`)], {
      input: JSON.stringify({ session_id: "disabled", cwd: root, hook_event_name: "test" }),
      encoding: "utf8",
      env: { ...process.env, AMP_DISABLE: "1" },
      timeout: 20_000,
    });
    assert.equal(out, "");
  });
}

test("codex keeps a trivial turn ledger open until SessionEnd", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-codex-lifecycle-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { AMP_DISABLE: _d, RXAI_AMP_REPO: _r, GH_TOKEN: _g, GITHUB_TOKEN: _gt, GITHUB_PERSONAL_ACCESS_TOKEN: _gp, ...baseEnv } =
    process.env;
  const env = { ...baseEnv, RXAI_AMP_HOME: home, RXAI_AMP_SLUG: "test-owner/test-memory", RXAI_AMP_AGENT: "codex" };
  const sessionId = "codex-multiturn";
  const ledgerCli = path.join(root, "adapters/lib/amp-ledger.mjs");
  execFileSync("node", [ledgerCli, "open", sessionId, "--agent", "codex"], { env, encoding: "utf8" });

  const run = (hook, extra = {}) => execFileSync("node", [path.join(root, "adapters/codex/hooks", `${hook}.mjs`)], {
    input: JSON.stringify({ session_id: sessionId, cwd: root, ...extra }),
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(run("stop", { stop_hook_active: false }), "");
  let ledger = JSON.parse(readFileSync(path.join(home, "sessions", `${sessionId}.json`), "utf8"));
  assert.equal(ledger.status, "open");

  run("session-end", { reason: "other" });
  ledger = JSON.parse(readFileSync(path.join(home, "sessions", `${sessionId}.json`), "utf8"));
  assert.equal(ledger.status, "closed");
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
  // agy has run at L2 since v2.9.1; the mirror must not tell it otherwise.
  assert.match(skill, /agy runs at L2/);
  assert.doesNotMatch(skill, /No §15 lifecycle hooks for agy/);
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

// §15.1 RECALL, issue #442 — repo-aware recall: the injected excerpt is the
// summary tier (v2.11) — `## Now` when present, else the opening prose of
// `## Message` up to its first list — and candidates must rank intent-first
// with fresh unindexed rows and branch-matching Places ahead.
test("amp-recall excerptOf injects the opening prose of Message and never its lists", () => {
  const body =
    "## Metadata\n- **From:** x\n\n## Message\n**Finding.**\n\nSecond paragraph.\n\n1. one\n2. two\n\nAfter the list.\n\n## Expected Action\n- [x] Execute task\n";
  assert.equal(excerptOf(body), "**Finding.** Second paragraph.");
  assert.equal(excerptOf("## Message\nline one\nline two"), "line one line two");
  // A Message that opens with a list has no prose to inject: "" lets the
  // caller say so instead of turning the list into a to-do list.
  assert.equal(excerptOf("## Message\n- decision one\n- decision two\n"), "");
  // No Message section: Metadata is dropped, a leading heading is skipped.
  assert.equal(excerptOf("## Metadata\n- a\n\n## Summary\nno message section"), "no message section");
  const capped = excerptOf("## Message\n" + "word ".repeat(200), 100);
  assert.ok(capped.length <= 102 && capped.endsWith(" …"), `cap not applied: ${capped.length}`);
  assert.doesNotMatch(capped, /wor …$/, "cap must fall on a word boundary");
});

test("amp-recall excerptOf prefers the author's ## Now section, list markers dropped", () => {
  const body =
    "## Metadata\n- **From:** x\n\n## Context Pointer\n> prior #41\n\n## Now\nGoal: replace cookie sessions with OAuth.\n- State: PKCE chosen, not started.\n\n## Message\n- decision one\n- decision two\n";
  assert.equal(excerptOf(body), "Goal: replace cookie sessions with OAuth. State: PKCE chosen, not started.");
  // An empty Now falls through to the Message rule.
  assert.equal(excerptOf("## Now\n\n## Message\nprose here\n- list"), "prose here");
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
  // Quiet turn, not a closed session: Stop fires every turn, SessionEnd closes.
  assert.equal(ledgerOf(quiet).status, "open");

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

// Stop fires after every assistant turn on Claude Code, not at session end.
// Found 2026-09-24: closing the ledger on a quiet first turn silenced the
// checkpoint for the rest of the session (13 of 167 closed ledgers on one
// machine received commits after closed_at). A quiet turn must leave the
// ledger open, a later commit must still be caught once, SessionEnd closes,
// and activity on a closed ledger reopens it.
test("claude-code ledger survives a quiet first turn: Stop keeps it open, SessionEnd closes it", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-lifecycle-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { AMP_DISABLE: _d, RXAI_AMP_REPO: _r, GH_TOKEN: _g, GITHUB_TOKEN: _gt, GITHUB_PERSONAL_ACCESS_TOKEN: _gp, ...baseEnv } =
    process.env;
  const env = { ...baseEnv, RXAI_AMP_HOME: home, RXAI_AMP_SLUG: "test-owner/test-memory" };
  const sessionId = "multi-turn";
  const ledgerCli = path.join(root, "adapters/lib/amp-ledger.mjs");
  const ledger = (...args) => execFileSync("node", [ledgerCli, ...args], { env, encoding: "utf8" });
  const hook = (file, extra = {}) =>
    execFileSync("node", [path.join(root, "adapters/claude-code/hooks", file)], {
      input: JSON.stringify({ session_id: sessionId, cwd: root, ...extra }),
      encoding: "utf8",
      env,
      timeout: 20_000,
    });
  const ledgerOf = () => JSON.parse(readFileSync(path.join(home, "sessions", `${sessionId}.json`), "utf8"));

  ledger("open", sessionId);
  ledger("surface", sessionId, "442", "--via", "inject", "--tier", "pointer", "injected intent");
  // Turn 1: a question, no commit. Nothing owed, and the ledger stays open.
  assert.equal(hook("stop.mjs", { stop_hook_active: false }), "");
  assert.equal(ledgerOf().status, "open");
  // Turn 2 commits. The checkpoint must still fire, once.
  ledger("boundary", sessionId, "acme-web", "abc1234", "feat: x");
  const out = JSON.parse(hook("stop.mjs", { stop_hook_active: false }));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /recorded 1 work boundary but no memory write/);
  assert.equal(hook("stop.mjs", { stop_hook_active: false }), "");
  assert.equal(ledgerOf().status, "open");
  // SessionEnd closes; activity afterwards (a resumed session) reopens.
  hook("session-end.mjs", { hook_event_name: "SessionEnd", reason: "other" });
  assert.equal(ledgerOf().status, "closed");
  ledger("boundary", sessionId, "acme-web", "def5678", "feat: y");
  assert.equal(ledgerOf().status, "open");
  assert.equal(ledgerOf().closed_at, null);
  assert.equal(ledgerOf().capture.boundaries.length, 2);
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

  // …and the Stop hook passes this turn without a checkpoint, leaving the
  // ledger open for the turns that follow.
  const stop = execFileSync("node", [path.join(root, "adapters/claude-code/hooks/stop.mjs")], {
    input: JSON.stringify({ session_id: sessionId, stop_hook_active: false, cwd }),
    encoding: "utf8",
    env,
    timeout: 20_000,
  });
  assert.equal(stop, "");
  assert.equal(JSON.parse(readFileSync(ledgerFile, "utf8")).status, "open");
});

test("amp-recall compactIndex keeps v2.10 titles and ignores refs inside them", () => {
  const index = [
    "# Agent Memory Index",
    "",
    "---",
    "",
    "## Region: Acme",
    "  > Active threads: #10 Retry with rebase on push race (w:0.5).  ",
    "",
    "## Region: Other",
    "  > Active threads: #99 Fix #47 regression (w:1), #98 Seed labels (w:0.4).  ",
    "",
  ].join("\n");
  const out = compactIndex(index, ["acme"]);
  // the matched Region keeps its title verbatim -- that is the whole point
  assert.match(out, /#10 Retry with rebase on push race \(w:0\.5\)/);
  // the collapsed Region lists only the two pointers, not the #47 inside a title
  assert.match(out, /Other \(#99 #98\)/);
  assert.doesNotMatch(out, /#47/);
});

// §15.1 task-aware stage (v2.11): the prompt decides which pointers expand.
test("amp-recall matchPrompt scores stemmed overlap, CJK bigrams and explicit refs; stopwords and project names never match", () => {
  const rows = [
    { issue: 10, summary: "Image derivation pipeline for uploads", region: "Acme", place: "image-pipeline", type: "pattern", weight: 0.5, source: "index" },
    { issue: 11, summary: "Invitation email SMTP gotchas", region: "Acme", place: "email", type: "pattern", weight: 0.4, source: "index" },
    { issue: 12, summary: "邀請信寄送流程", region: "Acme", place: "email", type: "facts", weight: 0.3, source: "index" },
  ];
  const ids = (m) => m.matched.map((x) => x.issue);
  assert.deepEqual(ids(matchPrompt("How are uploaded images derived?", rows)), [10]);
  assert.deepEqual(ids(matchPrompt("What does the payments module do?", rows)), []);
  assert.deepEqual(ids(matchPrompt("tell me about the email invitation", rows)), [11, 12]);
  assert.deepEqual(ids(matchPrompt("邀請信為什麼寄不出去", rows)), [12]);
  assert.deepEqual(ids(matchPrompt("see #11 for the reason", rows)), [11]);
  assert.deepEqual(matchPrompt("see #11 for the reason", rows).matched[0].hits, ["#11"]);
  // Stopwords and the project's own identifiers are not evidence.
  assert.deepEqual(ids(matchPrompt("the acme email", rows, { ignore: new Set(["acme", "email"]) })), []);
  assert.deepEqual(ids(matchPrompt("the and for with", rows)), []);
  // Already-expanded records are skipped; the limit applies after ranking.
  assert.deepEqual(ids(matchPrompt("email invitation", rows, { exclude: new Set([11]) })), [12]);
  assert.deepEqual(ids(matchPrompt("email invitation", rows, { limit: 1 })), [11]);
});

// §15.1 task-aware recall (v2.11): on a runtime with a prompt stage the
// SessionStart hook injects pointers only; UserPromptSubmit expands to the
// summary tier just the records the prompt overlaps, each once per session;
// a prompt no memory covers injects nothing; the Stop hook still owes nothing.
// A runtime without a prompt stage (the Codex shims) gets summaries at start.
test("claude-code session-start injects pointers and user-prompt-submit expands only the matching records, once", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-prompt-home-"));
  const clone = mkdtempSync(path.join(tmpdir(), "amp-prompt-clone-"));
  const work = mkdtempSync(path.join(tmpdir(), "amp-prompt-work-"));
  const cwd = path.join(work, "acme-web");
  mkdirSync(cwd);
  t.after(() => {
    for (const dir of [home, clone, work]) rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    path.join(clone, "INDEX.md"),
    ["# Agent Memory Index", "", "**Last Compiled:** 2026-09-23T00:00:00Z  ", "", "---", "", "## Region: Acme", "  > Active threads: #10 (w:0.5), #11 (w:0.4).  ", ""].join("\n")
  );
  writeFileSync(
    path.join(clone, "REGION-Acme.md"),
    "## Place: adapters\n  ### Type: intent\n  | #10 | Count only real git commits as capture boundaries | 0 | 0.5 | 2026-09-01 |\n\n## Place: email\n  ### Type: pattern\n  | #11 | Invitation email SMTP gotcha | 0 | 0.4 | 2026-09-01 |\n"
  );
  writeFileSync(
    path.join(clone, "not_indexed.md"),
    "# Not Yet Indexed\n\n**Since Last Index Compile:** 2026-09-23T00:00:00Z\n**Unindexed Issue Count:** 0\n\n| Issue | From | Region | Place | Type | Posted |\n|-------|------|------|------|------|--------|\n"
  );
  // #10's body is in the local cache (fresh): read without network. #11 is not.
  mkdirSync(path.join(clone, ".rxai-cache", "issues"), { recursive: true });
  writeFileSync(
    path.join(clone, ".rxai-cache", "issues", "10.json"),
    JSON.stringify({
      cached_at: new Date().toISOString(),
      repo: "acme/memory",
      issue: {
        number: 10,
        state: "open",
        title: "[FROM:codex→all][REGION:Acme][PLACE:adapters][TYPE:intent] Count only real git commits as capture boundaries",
        body: "## Metadata\n- **From:** codex\n\n## Now\nGoal: record a boundary only for a real git commit.\n\n## Message\n- decision one\n- decision two\n",
      },
    })
  );
  const {
    AMP_DISABLE: _d, RXAI_AMP_SLUG: _s, RXAI_AMP_RUNTIME: _r, RXAI_AMP_RECALL_TIER: _t,
    GH_TOKEN: _g, GITHUB_TOKEN: _gt, GITHUB_PERSONAL_ACCESS_TOKEN: _gp, ...baseEnv
  } = process.env;
  const env = { ...baseEnv, RXAI_AMP_HOME: home, RXAI_AMP_REPO: clone };
  const hook = (file, input, extraEnv = {}) =>
    execFileSync("node", [path.join(root, "adapters/claude-code/hooks", file)], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...env, ...extraEnv },
      timeout: 20_000,
    });
  const surfaced = (id) =>
    JSON.parse(readFileSync(path.join(home, "sessions", `${id}.json`), "utf8")).recall.surfaced.map((s) => [s.issue, s.via, s.tier]);

  const sessionId = "prompt-stage-test";
  const start = hook("session-start.mjs", { session_id: sessionId, cwd, hook_event_name: "SessionStart", source: "startup" });
  assert.match(start, /#10 \[intent · adapters · w:0\.50\] \[FROM:codex→all\].*Count only real git commits/, "cached title on the pointer");
  assert.match(start, /#11 \[pattern · email · w:0\.40\] Invitation email SMTP gotcha/);
  assert.doesNotMatch(start, /Goal: record a boundary/, "no summary at session start on a prompt-stage runtime");
  assert.match(start, /Pointers only: the summaries of whichever records match your prompt arrive with it/);
  assert.deepEqual(surfaced(sessionId), [[10, "inject", "pointer"], [11, "inject", "pointer"]]);

  // A prompt no memory covers injects nothing.
  const control = { session_id: sessionId, cwd, hook_event_name: "UserPromptSubmit", prompt: "How does the payments module charge cards?" };
  assert.equal(hook("user-prompt-submit.mjs", control), "");
  assert.deepEqual(surfaced(sessionId), [[10, "inject", "pointer"], [11, "inject", "pointer"]]);

  // A prompt overlapping #10 (adapters, count, commits): its summary, and only it.
  const ask = { ...control, prompt: "Why do the adapters count commits twice?" };
  const expanded = hook("user-prompt-submit.mjs", ask);
  assert.match(expanded, /^=== RxAi AMP shared memory — task-aware RECALL/);
  assert.match(expanded, /1 of 2 open record\(s\) for acme-web match this prompt:/);
  assert.match(expanded, /#10 \[intent · adapters · w:0\.50 · matched: count, commit, adapter\]/);
  assert.match(expanded, /\n  Goal: record a boundary only for a real git commit\.\n/);
  assert.doesNotMatch(expanded, /#11/);
  assert.match(expanded, /=== end AMP memory ===\n$/);
  assert.deepEqual(surfaced(sessionId), [[10, "inject", "summary"], [11, "inject", "pointer"]]);
  // The expansion fetched the body (from the cache here), so the ledger now
  // carries the fetched, tagged title instead of the index's title line.
  assert.match(JSON.parse(readFileSync(path.join(home, "sessions", `${sessionId}.json`), "utf8")).recall.surfaced[0].title, /^\[FROM:codex→all\]/);

  // The same prompt again: already expanded, nothing more.
  assert.equal(hook("user-prompt-submit.mjs", ask), "");

  // An explicit ref expands #11 without any term overlap; no cache and no
  // slug, so the body is not fetched and the block says how to.
  const named = hook("user-prompt-submit.mjs", { ...control, prompt: "what happened in #11?" });
  assert.match(named, /#11 \[pattern · email · w:0\.40 · matched: #11\] Invitation email SMTP gotcha/);
  assert.match(named, /\(body not fetched — run: gh issue view 11\)/);
  assert.deepEqual(surfaced(sessionId), [[10, "inject", "summary"], [11, "inject", "summary"]]);

  // Injected memories, whatever their tier, owe nothing at Stop.
  assert.equal(hook("stop.mjs", { session_id: sessionId, stop_hook_active: false, cwd }), "");

  // A runtime without a prompt stage starts at the summary tier.
  const codex = hook("session-start.mjs", { session_id: "prompt-stage-codex", cwd, hook_event_name: "SessionStart", source: "startup" }, { RXAI_AMP_RUNTIME: "codex" });
  assert.match(codex, /\n  Goal: record a boundary only for a real git commit\.\n/);
  assert.doesNotMatch(codex, /Pointers only/);
  assert.deepEqual(surfaced("prompt-stage-codex"), [[10, "inject", "summary"], [11, "inject", "summary"]]);

  // …and the override wins on either runtime.
  const forced = hook("session-start.mjs", { session_id: "prompt-stage-forced", cwd, hook_event_name: "SessionStart", source: "startup" }, { RXAI_AMP_RECALL_TIER: "pointer", RXAI_AMP_RUNTIME: "codex" });
  assert.match(forced, /Pointers only/);
});

// §15.3 (v2.12): L1 is folderless-only. No skill mirror or digest may send a
// hook-capable agent to walk the index by hand, and none may tell the agent
// to check AMP_DISABLE itself — the flag is consumed by the hooks.
test("skill mirrors and digests never prescribe manual index navigation or an AMP_DISABLE self-check", () => {
  const files = [
    ".claude/skills/rxai-amp/SKILL.md",
    ".agents/skills/rxai-amp/SKILL.md",
    "adapters/codex/skills/rxai-amp/SKILL.md",
    "adapters/agy/skills/rxai-amp/SKILL.md",
    "adapters/codex/digest.md",
    "adapters/openclaw/digest.md",
    "adapters/hermes/digest.md",
    ".claude/commands/amp.md",
  ];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /AMP_DISABLE=1`? (means|in the environment means|switches)/, `${file} tells the agent to act on AMP_DISABLE`);
    assert.doesNotMatch(text, /then\s+only the `REGION-\*\.md` files/, `${file} still walks Region files for recall`);
    assert.doesNotMatch(text, /Load only the `REGION-\*\.md` files relevant/, `${file} still walks Region files for recall`);
    assert.match(text, /(never walk the index by hand|do\s+not read the index or Region files by hand|Do not\s+load `REGION-\*\.md` files to find\s+memories|Never load a `REGION-\*\.md` to find memories)/i, `${file} does not rule out the Region walk`);
  }
});


// §15.5 chain, never clobber — inside our own key too. A user who hangs a
// sound hook on the "rxai-amp" Stop event must keep it across reinstalls
// (found 2026-09-23: the previous {...hooks, ...ours} merge deleted it).
test("agy installer keeps foreign entries inside its own rxai-amp key and stays idempotent", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-agy-install-"));
  const configRoot = path.join(home, "config");
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    path.join(configRoot, "hooks.json"),
    JSON.stringify({
      "rxai-amp": { Stop: [{ type: "command", command: "afplay-foreign" }] },
      other: { Stop: [{ type: "command", command: "other-stop" }] },
    })
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const args = [path.join(root, "scripts/install-agy-hooks.mjs"), "--repo-path", root, "--repo-slug", "test-owner/test-memory", "--config-root", configRoot];
  const env = { ...process.env, RXAI_AMP_HOME: path.join(home, "amp") };
  execFileSync("node", args, { env, encoding: "utf8" });
  execFileSync("node", args, { env, encoding: "utf8" }); // idempotent
  const installed = JSON.parse(readFileSync(path.join(configRoot, "hooks.json"), "utf8"));
  assert.deepEqual(installed.other, { Stop: [{ type: "command", command: "other-stop" }] });
  assert.equal(installed["rxai-amp"].Stop.length, 2, "foreign Stop entry lost or ours duplicated");
  assert.equal(installed["rxai-amp"].Stop[0].command, "afplay-foreign", "user's entry must keep first place");
  assert.match(installed["rxai-amp"].Stop[1].command, /adapters\/agy\/hooks\/stop\.mjs/);
  assert.equal(installed["rxai-amp"].PreInvocation.length, 1);
  assert.match(installed["rxai-amp"].PreInvocation[0].command, /adapters\/agy\/hooks\/pre-invocation\.mjs/);
});


// Weighted overlap: a title that shares only the project's everyday words with
// the prompt must not expand (measured 2026-09-23: a Cloud Functions record
// matched every task of a Firebase app, control task included); a Place token
// or a store-rare word is evidence on its own.
test("amp-recall matchPrompt weighs Place tokens and rare terms, and ignores everyday vocabulary", () => {
  const store = [
    { issue: 20, summary: "Google Workspace SMTP setup on Cloud Functions v2", region: "Acme", place: "email-auth", type: "pattern", weight: 0.4, source: "index" },
    { issue: 21, summary: "Preserve fallback uploads; derive WebP source", region: "Acme", place: "image-pipeline", type: "pattern", weight: 0.4, source: "index" },
    { issue: 22, summary: "Cloud Functions cold start on payments", region: "Acme", place: "payments", type: "facts", weight: 0.3, source: "index" },
    { issue: 23, summary: "Cloud Functions region for scheduled jobs", region: "Acme", place: "jobs", type: "facts", weight: 0.3, source: "index" },
    { issue: 24, summary: "Move image thumbnails to a Cloud Function", region: "Acme", place: "image-pipeline", type: "events", weight: 0.2, source: "index" },
  ];
  const freq = termFrequencies(store);
  assert.equal(MATCH_THRESHOLD, 2);
  const ids = (m) => m.matched.map((x) => x.issue);
  // "cloud" and "function" are generic software vocabulary: 0.5 each, whatever the store says.
  assert.deepEqual(ids(matchPrompt("How do the cloud functions handle refunds?", [store[0], store[1]], { freq })), []);
  assert.deepEqual(ids(matchPrompt("How do the cloud functions handle refunds?", [store[0]])), [], "no corpus does not make generic words count");
  // A Place token alone is enough.
  assert.deepEqual(ids(matchPrompt("Where is the invitation email sent from?", [store[0], store[1]], { freq })), [20]);
  // A rare title word alone is enough.
  assert.deepEqual(ids(matchPrompt("Why do we keep a WebP copy?", [store[0], store[1]], { freq })), [21]);
  // Four everyday words add up to the threshold; three do not.
  const row = { issue: 30, summary: "cloud function region jobs", region: "Acme", place: "misc", type: "facts", weight: 0.3, source: "index" };
  const dense = termFrequencies([...store, row, ...store.map((r, i) => ({ ...r, issue: 40 + i, summary: "cloud function region jobs" }))]);
  assert.deepEqual(ids(matchPrompt("cloud function region", [row], { freq: dense })), []);
  assert.deepEqual(ids(matchPrompt("cloud function region jobs", [row], { freq: dense })), [30]);
  // A non-generic title word that is not rare in the store counts 1: two are needed.
  const common = termFrequencies([...store, ...store.map((r, i) => ({ ...r, issue: 50 + i, summary: "nodemailer retry policy" }))]);
  assert.deepEqual(ids(matchPrompt("does nodemailer retry?", [{ issue: 60, summary: "nodemailer retry policy", region: "Acme", place: "misc", type: "facts", weight: 0.3, source: "index" }], { freq: common })), [60]);
  assert.deepEqual(ids(matchPrompt("does nodemailer work?", [{ issue: 60, summary: "nodemailer retry policy", region: "Acme", place: "misc", type: "facts", weight: 0.3, source: "index" }], { freq: common })), []);
});
