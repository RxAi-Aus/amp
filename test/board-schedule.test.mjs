// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// AMP Board — scripts/install-board-schedule.mjs: plist shape and dry-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlist, labelFor, parseEvery, plistPath } from "../scripts/install-board-schedule.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const script = path.join(root, "scripts/install-board-schedule.mjs");

test("parseEvery accepts m/h/s/d and enforces the 60 s floor", () => {
  assert.equal(parseEvery("30m"), 1800);
  assert.equal(parseEvery("1h"), 3600);
  assert.equal(parseEvery("90s"), 90);
  assert.equal(parseEvery("600"), 600);
  assert.equal(parseEvery("1d"), 86400);
  assert.throws(() => parseEvery("30s"), /at least 60/);
  assert.throws(() => parseEvery("soon"), /--every/);
});

test("labelFor / plistPath follow com.rxai.amp.board.<agent>[.reviewer]", () => {
  assert.equal(labelFor("codex", "worker"), "com.rxai.amp.board.codex");
  assert.equal(labelFor("codex", "reviewer"), "com.rxai.amp.board.codex.reviewer");
  assert.equal(plistPath("agy", "worker", "/Users/x"), "/Users/x/Library/LaunchAgents/com.rxai.amp.board.agy.plist");
});

test("buildPlist wires cli.mjs next with a launchd-safe PATH and per-agent log", () => {
  const plist = buildPlist({ agent: "codex", everySeconds: 1800, home: "/Users/x", nodeBin: "/opt/node/bin/node", root: "/repo", port: 7345 });
  assert.match(plist, /<key>Label<\/key><string>com\.rxai\.amp\.board\.codex<\/string>/);
  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/repo\/board\/cli\.mjs<\/string>\s*<string>next<\/string>\s*<string>--agent<\/string>\s*<string>codex<\/string>\s*<string>--port<\/string>\s*<string>7345<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key><string>\/repo<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>1800<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key><false\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/Users\/x\/\.rxai-amp\/board-runs\/schedule-codex\.log<\/string>/);
  assert.match(plist, /<key>PATH<\/key><string>\/Users\/x\/\.local\/bin:\/opt\/homebrew\/bin:\/opt\/node\/bin:/);
  const reviewer = buildPlist({ agent: "codex", role: "reviewer", everySeconds: 600, home: "/Users/x", nodeBin: "/n", root: "/repo" });
  assert.match(reviewer, /<string>--role<\/string>\s*<string>reviewer<\/string>/);
  assert.match(reviewer, /schedule-codex-reviewer\.log/);
  assert.doesNotMatch(reviewer, /--port/);
});

test("--dry-run prints the plist and launchctl commands without writing", () => {
  const home = mkdtempSync(path.join(tmpdir(), "amp-board-sched-"));
  try {
    const r = spawnSync(process.execPath, [script, "--agent", "fake", "--every", "1m", "--dry-run"], {
      env: { ...process.env, AMP_BOARD_SCHEDULE_HOME: home },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] would write .*com\.rxai\.amp\.board\.fake\.plist/);
    assert.match(r.stdout, /<key>StartInterval<\/key><integer>60<\/integer>/);
    assert.match(r.stdout, /\[dry-run\] launchctl bootstrap gui\/\d+ /);
    assert.equal(existsSync(path.join(home, "Library/LaunchAgents/com.rxai.amp.board.fake.plist")), false);
    const un = spawnSync(process.execPath, [script, "--agent", "fake", "--uninstall", "--dry-run"], {
      env: { ...process.env, AMP_BOARD_SCHEDULE_HOME: home },
      encoding: "utf8",
    });
    assert.equal(un.status, 0);
    assert.match(un.stdout, /\[dry-run\] launchctl bootout/);
    assert.match(un.stdout, /nothing installed/);
    assert.equal(spawnSync(process.execPath, [script, "--every", "1m"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [script, "--agent", "fake", "--every", "5s", "--dry-run"], { encoding: "utf8" }).status, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
