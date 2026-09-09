// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// PROTOCOL.md §4.5 not_indexed.md table shape — golden-file comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderFile, rowFor, stripStamp } from "../dist/track_not_indexed.js";

const golden = readFileSync(
  fileURLToPath(new URL("./fixtures/not_indexed.golden.md", import.meta.url)),
  "utf8",
);

const ROWS = [
  rowFor(
    "[FROM:openclaw→claudecowork][REGION:ProjectX][PLACE:debugging][TYPE:discovery] Memory sync test",
    43,
    "2026-08-15T00:12:00Z",
  ),
  rowFor(
    "[FROM:claudecowork→self][REGION:claudecowork-diary][PLACE:sessions][TYPE:events] Session summary",
    44,
    "2026-08-15T00:45:00Z",
  ),
];

test("renderFile matches the golden not_indexed.md byte-for-byte", () => {
  const actual = renderFile("2026-08-15T00:00:00Z", "2026-08-15T01:00:00Z", ROWS);
  assert.equal(actual, golden);
});

test("renderFile with no rows keeps the header and empty table", () => {
  const actual = renderFile("2026-08-15T00:00:00Z", "2026-08-15T01:00:00Z", []);
  assert.match(actual, /\*\*Unindexed Issue Count:\*\* 0/);
  assert.ok(actual.endsWith("|-------|------|------|------|------|--------|\n"));
});

test("stripStamp makes rebuilds differing only by Last Updated compare equal", () => {
  const a = renderFile("2026-08-15T00:00:00Z", "2026-08-15T01:00:00Z", ROWS);
  const b = renderFile("2026-08-15T00:00:00Z", "2026-08-15T03:59:59Z", ROWS);
  assert.notEqual(a, b);
  assert.equal(stripStamp(a), stripStamp(b));
});
