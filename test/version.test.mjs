// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
//
// One protocol version, asserted everywhere it is claimed.
//
// The version used to live in eight hand-maintained places with nothing
// comparing them, so a bump was a manual sweep and a miss was silent:
// README.zh-TW.md sat on v2.9.1 through two releases and was found by accident.
// package.json is the source of truth here; everything else must agree with it.
//
// This checks CLAIMS about the current version only. Provenance markers -- "the
// lifecycle adapters arrived in v2.8", changelog rows, "What's new in v2.9"
// headings -- are history and must keep their old numbers. Do not add them here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(repoRoot, file), "utf8");

/**
 * package.json is semver; the protocol drops a zero patch. Observed across the
 * whole history: 2.9.0 -> v2.9, 2.9.1 -> v2.9.1, 2.9.2 -> v2.9.2, 2.10.0 -> v2.10.
 */
export function protocolVersion(packageVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageVersion);
  assert.ok(match, `package.json version is not semver: ${packageVersion}`);
  const [, major, minor, patch] = match;
  return patch === "0" ? `v${major}.${minor}` : `v${major}.${minor}.${patch}`;
}

// Every place that asserts "this is the current version". Add a row when a new
// one appears; the capture group must be the version and nothing else.
const CLAIMS = [
  ["PROTOCOL.md", "spec header", /^\*\*RxAi AMP (v[\d.]+)\*\*/m],
  ["README.md", "title", /^# RxAi AMP · Agent Memory Protocol (v[\d.]+)/m],
  ["README.md", "current-release sentence", /The current release is \*\*(v[\d.]+)\*\*/],
  ["README.zh-TW.md", "title", /^# RxAi AMP · 代理程式記憶協定 (v[\d.]+)/m],
  ["CLAUDE.md", "source-of-truth note", /source of truth\*\* \(currently (v[\d.]+)\)/],
  ["AGENTS.md", "spec description", /It currently describes RxAi AMP (v[\d.]+)/],
  ["docs/index.html", "landing page eyebrow", /Agent Memory Protocol · (v[\d.]+) · patent pending/],
  ["docs/index.html", "landing page footer", /RxAi AMP (v[\d.]+) · <a/],
];

const expected = protocolVersion(JSON.parse(read("package.json")).version);

test("every current-version claim matches package.json", () => {
  const wrong = [];
  const missing = [];
  for (const [file, what, pattern] of CLAIMS) {
    const found = pattern.exec(read(file))?.[1];
    if (found === undefined) {
      missing.push(`${file} (${what}) — pattern no longer matches; the wording changed`);
    } else if (found !== expected) {
      wrong.push(`${file} (${what}) — says ${found}, package.json says ${expected}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `A version claim could not be located. Either the text was reworded (update the\n` +
      `pattern in this file) or the claim was deleted:\n  ${missing.join("\n  ")}`,
  );
  assert.deepEqual(
    wrong,
    [],
    `Version bumps must reach every claim, not just package.json:\n  ${wrong.join("\n  ")}`,
  );
});

test("the release is documented, not just numbered", () => {
  const changelog = new RegExp(`^\\| ${expected.slice(1).replace(/\./g, "\\.")} \\|`, "m");
  assert.match(
    read("PROTOCOL.md"),
    changelog,
    `PROTOCOL.md has no Version History row for ${expected}. A version nobody can ` +
      `look up is not a release.`,
  );
  const whatsNew = new RegExp(`^## What's new in ${expected.replace(/\./g, "\\.")}$`, "m");
  assert.match(
    read("README.md"),
    whatsNew,
    `README.md has no "What's new in ${expected}" section, though every release ` +
      `back to v2.4 has one.`,
  );
});

test("the version helper follows the observed convention", () => {
  assert.equal(protocolVersion("2.10.0"), "v2.10");
  assert.equal(protocolVersion("2.9.0"), "v2.9");
  assert.equal(protocolVersion("2.9.1"), "v2.9.1");
  assert.equal(protocolVersion("2.9.2"), "v2.9.2");
  assert.equal(protocolVersion("3.0.0"), "v3.0");
});
