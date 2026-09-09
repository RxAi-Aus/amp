// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isIssueProjection,
  scanContent,
  scanPath,
  scanPublicationArtifact,
} from "../scripts/secret-scan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanner = path.join(root, "scripts/secret-scan.mjs");

test("privacy scan rejects machine-specific home-directory paths", () => {
  const privatePath = ["", "Users", "private-account", "project", "notes.md"].join("/");
  const findings = scanContent("plan.md", `Source: file://${privatePath}`);
  assert.match(findings.join("\n"), /personal home-directory path/);
});

test("privacy scan permits documented placeholder home paths", () => {
  const placeholderPath = ["", "Users", "x", "project"].join("/");
  assert.deepEqual(scanContent("example.md", placeholderPath), []);
});

test("privacy scan rejects a direct personal email but permits public role mailboxes", () => {
  const personalEmail = ["person.name", "real-domain.dev"].join("@");
  assert.match(scanContent("notes.md", personalEmail).join("\n"), /personal email address/);
  assert.deepEqual(scanContent("contact.md", ["hello", "rxai.com.au"].join("@")), []);
});

test("privacy scan rejects labelled personal data without echoing its value", () => {
  const phoneNumber = ["+61", "412", "345", "678"].join(" ");
  const findings = scanContent("profile.md", `Mobile: ${phoneNumber}`);
  assert.match(findings.join("\n"), /possible personal data \(Mobile\)/);
  assert.doesNotMatch(findings.join("\n"), /412/);
});

test("secret scan still rejects credential formats without echoing the credential", () => {
  const token = ["github", "pat", "A".repeat(24)].join("_");
  const findings = scanContent("config.md", token);
  assert.match(findings.join("\n"), /GitHub token/);
  assert.doesNotMatch(findings.join("\n"), new RegExp(token));
});

test("privacy scan rejects files that commonly contain personal or credential data", () => {
  assert.match(scanPath(["backup", "permanent_memory.json"].join("/")).join("\n"), /permanent personal memory/);
  assert.match(scanPath(["logs", "session.log"].join("/")).join("\n"), /sensitive file path/);
  assert.match(scanPath([".rxai-cache", "issues.db"].join("/")).join("\n"), /local AMP issue cache/);
});

test("publication scan rejects issue-derived AMP projections", () => {
  const index = "**Total Issues Indexed:** 2\n";
  const tracker = "**Unindexed Issue Count:** 1\n";
  const weights = JSON.stringify({ "101": { weight: 0.9 }, _last_compile_iso: "2026-09-03T00:00:00Z" });

  assert.match(scanPublicationArtifact("INDEX.md", index).join("\n"), /2 issue-derived memories/);
  assert.match(scanPublicationArtifact("not_indexed.md", tracker).join("\n"), /1 unindexed memories/);
  assert.match(scanPublicationArtifact("REGION-private.md", "").join("\n"), /Region projection/);
  assert.match(scanPublicationArtifact("okf/private/issue-101.md", "").join("\n"), /OKF projection/);
  assert.match(scanPublicationArtifact("weights.json", weights).join("\n"), /1 memory records/);
});

test("publication scan permits an empty AMP template projection", () => {
  assert.deepEqual(scanPublicationArtifact("INDEX.md", "**Total Issues Indexed:** 0\n"), []);
  assert.deepEqual(scanPublicationArtifact("not_indexed.md", "**Unindexed Issue Count:** 0\n"), []);
  assert.deepEqual(scanPublicationArtifact("weights.json", '{"_last_compile_iso":"2026-09-03T00:00:00Z"}'), []);
});

test("isIssueProjection recognises root AMP/OKF projections only", () => {
  for (const file of [
    "INDEX.md",
    "not_indexed.md",
    "weights.json",
    "REGION-private.md",
    "okf/index.md",
    "okf/private/notes/issue-1.md",
    "artifacts/okf/rows.ndjson",
  ]) {
    assert.equal(isIssueProjection(file), true, file);
  }
  for (const file of [
    "README.md",
    "PROTOCOL.md",
    "docs/INDEX.md",
    "compile_index.ts",
    "test/fixtures/board/clone/REGION-Sample.md",
    "test/fixtures/board/clone/okf/Sample/content-pipeline/issue-337.md",
  ]) {
    assert.equal(isIssueProjection(file), false, file);
  }
});

test("working-tree scan skips issue projections but the public gate rejects them", () => {
  const clone = mkdtempSync(path.join(tmpdir(), "amp-projection-test-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: clone, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.name", "index-bot");
    git("config", "user.email", "bot@repo");
    git("config", "commit.gpgsign", "false");

    const privatePath = ["", "Users", "private-account", "project"].join("/");
    const personalEmail = ["person.name", "real-domain.dev"].join("@");
    const memoryText = `Source: file://${privatePath}\nContact: ${personalEmail}\n`;

    mkdirSync(path.join(clone, "okf", "private", "notes"), { recursive: true });
    writeFileSync(path.join(clone, "okf", "private", "notes", "issue-1.md"), memoryText, "utf8");
    writeFileSync(path.join(clone, "REGION-private.md"), memoryText, "utf8");
    writeFileSync(path.join(clone, "INDEX.md"), "**Total Issues Indexed:** 1\n", "utf8");
    writeFileSync(path.join(clone, "README.md"), "# Clean source\n", "utf8");
    git("add", ".");
    git("commit", "-qm", "index compile");

    const run = (flag) => spawnSync(process.execPath, [scanner, flag], { cwd: clone, encoding: "utf8" });

    const tree = run("--all");
    assert.equal(tree.status, 0, tree.stderr);

    const release = run("--public");
    assert.notEqual(release.status, 0);
    assert.match(release.stderr, /OKF projection contains issue-derived memory/);
    assert.match(release.stderr, /Region projection contains issue-derived memory/);
    assert.match(release.stderr, /1 issue-derived memories/);
    assert.match(release.stderr, /personal home-directory path/);
    assert.doesNotMatch(release.stderr, /private-account/);
    assert.doesNotMatch(release.stderr, /real-domain/);

    writeFileSync(path.join(clone, "notes.md"), memoryText, "utf8");
    git("add", "notes.md");
    const staged = run("--staged");
    assert.notEqual(staged.status, 0);
    assert.match(staged.stderr, /notes\.md:\d+ personal home-directory path/);
    assert.doesNotMatch(staged.stderr, /okf\//);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test("the current repository passes the full working-tree privacy gate", () => {
  const output = execFileSync(process.execPath, [scanner, "--all"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(output, /Secret\/privacy scan passed \(all\)/);
});

test("history mode finds personal data removed from the latest tree", () => {
  const clone = mkdtempSync(path.join(tmpdir(), "amp-privacy-test-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: clone, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.name", "index-bot");
    git("config", "user.email", "bot@repo");
    git("config", "commit.gpgsign", "false");

    const privatePath = ["", "Users", "private-account", "project"].join("/");
    writeFileSync(path.join(clone, "plan.md"), `Source: file://${privatePath}\n`, "utf8");
    git("add", "plan.md");
    git("commit", "-qm", "add plan");

    writeFileSync(path.join(clone, "plan.md"), "Source: ./project\n", "utf8");
    git("add", "plan.md");
    git("commit", "-qm", "redact plan");

    const result = spawnSync(process.execPath, [scanner, "--history"], {
      cwd: clone,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /personal home-directory path/);
    assert.doesNotMatch(result.stderr, /private-account/);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});
