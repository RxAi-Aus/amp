// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// PROTOCOL.md §4.3 decay rates, §4.4 outcome arithmetic + clamping,
// Rule 8 Supersedes enforcement/retraction, Rule 12 lifefact pinning.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARCHIVE_THRESHOLD,
  DECAY,
  computeCommentDelta,
  computeIssueWeight,
  resolveInvalidations,
} from "../dist/compile_index.js";

test("decay table matches PROTOCOL.md §4.3", () => {
  assert.deepEqual(DECAY, {
    intent: 0.97,
    facts: 0.95,
    events: 0.85,
    discovery: 0.85,
    pattern: 0.98,
    invalidation: 0.95,
    lifefact: 1.0,
  });
  assert.equal(ARCHIVE_THRESHOLD, 0.10);
});

test("computeCommentDelta: +0.30 success, -0.20 failure, neutral/no-marker 0", () => {
  const delta = computeCommentDelta([
    { body: "- **Outcome:** success" },
    { body: "- **Outcome:** failure" },
    { body: "- **Outcome:** neutral" },
    { body: "just a discussion comment" },
  ]);
  assert.ok(Math.abs(delta - 0.10) < 1e-9);
  assert.equal(computeCommentDelta([]), 0);
});

test("computeIssueWeight applies per-kind decay to a fresh weight", () => {
  assert.equal(computeIssueWeight("intent", 1.0, 0, false), 0.97);
  assert.equal(computeIssueWeight("facts", 1.0, 0, false), 0.95);
  assert.equal(computeIssueWeight("pattern", 1.0, 0, false), 0.98);
  assert.equal(computeIssueWeight("events", 1.0, 0, false), 0.85);
  assert.equal(computeIssueWeight("unknown-kind", 1.0, 0, false), 0.85); // fallback ρ
});

test("computeIssueWeight rounds to 4 decimal places", () => {
  // 0.9604 × 0.97 = 0.931588 → 0.9316
  assert.equal(computeIssueWeight("intent", 0.9604, 0, false), 0.9316);
});

test("computeIssueWeight clamps to [0, 1]", () => {
  assert.equal(computeIssueWeight("pattern", 1.0, 0.9, false), 1);
  assert.equal(computeIssueWeight("events", 0.1, -0.2, false), 0);
});

test("Rule 12: lifefact pinned at 1.0 — ignores decay, penalty, supersession", () => {
  assert.equal(computeIssueWeight("lifefact", 0.5, -0.2, false), 1);
  assert.equal(computeIssueWeight("lifefact", 1.0, 0, true), 1);
});

test("Rule 8: superseded issue floors to 0 regardless of activity", () => {
  assert.equal(computeIssueWeight("facts", 1.0, 0.3, true), 0);
});

test("resolveInvalidations: simple supersede archives the target", () => {
  const { supersededBy, retracted } = resolveInvalidations(new Map([[10, [3]]]));
  assert.equal(supersededBy.get(3), 10);
  assert.equal(retracted.size, 0);
});

test("resolveInvalidations: newest wins — a superseded invalidation stops enforcing", () => {
  // #20 supersedes #10 (itself an invalidation of #3): #10 is archived and
  // retracted, so #3 stays active.
  const { supersededBy, retracted } = resolveInvalidations(
    new Map([
      [10, [3]],
      [20, [10]],
    ]),
  );
  assert.equal(supersededBy.get(10), 20);
  assert.ok(retracted.has(10));
  assert.equal(supersededBy.has(3), false);
});

test("resolveInvalidations: retracting the retraction re-arms the original", () => {
  // #30 supersedes #20, #20 superseded #10, #10 supersedes #3.
  // #20 is retracted, so #10 enforces again and #3 archives.
  const { supersededBy, retracted } = resolveInvalidations(
    new Map([
      [10, [3]],
      [20, [10]],
      [30, [20]],
    ]),
  );
  assert.ok(retracted.has(20));
  assert.equal(supersededBy.get(3), 10);
  assert.equal(supersededBy.get(20), 30);
});
