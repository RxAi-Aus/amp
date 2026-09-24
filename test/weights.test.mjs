// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// PROTOCOL.md §4.3 decay rates, §4.4 outcome arithmetic + clamping, §4.4b
// unused-recall decay, §4.4c manifest reinforcement, Rule 8 Supersedes
// enforcement/retraction, Rule 12 lifefact pinning.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARCHIVE_THRESHOLD,
  DECAY,
  MANIFEST_FAILURE,
  MANIFEST_SUCCESS,
  UNUSED_DECAY,
  computeCommentDelta,
  computeIssueWeight,
  manifestDelta,
  parseRecallUnused,
  parseRecallUsed,
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

// --- §4.4b unused-recall decay ------------------------------------------

test("§4.4b: a record no manifest mentions keeps the pre-4.4b arithmetic", () => {
  for (const kind of ["intent", "facts", "pattern", "events", "unknown-kind"]) {
    assert.equal(
      computeIssueWeight(kind, 0.5, 0, false, 0),
      computeIssueWeight(kind, 0.5, 0, false),
      `${kind} must be unchanged when nothing recorded it as unused`,
    );
  }
});

test("§4.4b: each recorded unused recall compounds on top of age decay", () => {
  assert.equal(UNUSED_DECAY, 0.95);
  const idle = computeIssueWeight("pattern", 0.5, 0, false, 0);
  const once = computeIssueWeight("pattern", 0.5, 0, false, 1);
  const twice = computeIssueWeight("pattern", 0.5, 0, false, 2);
  assert.ok(once < idle, "being ignored must cost more than merely ageing");
  assert.ok(twice < once, "repeated ignoring must compound");
  assert.equal(once, Math.round(0.5 * DECAY.pattern * UNUSED_DECAY * 10000) / 10000);
  assert.equal(twice, Math.round(0.5 * DECAY.pattern * UNUSED_DECAY ** 2 * 10000) / 10000);
});

test("§4.4b: a negative or absent count never raises a weight", () => {
  const base = computeIssueWeight("facts", 0.5, 0, false, 0);
  assert.equal(computeIssueWeight("facts", 0.5, 0, false, -5), base);
  assert.equal(computeIssueWeight("facts", 0.5, 0, false, undefined), base);
});

test("§4.4b: Rule 12 and Rule 8 still win over unused decay", () => {
  assert.equal(computeIssueWeight("lifefact", 0.5, 0, false, 25), 1.0);
  assert.equal(computeIssueWeight("pattern", 0.9, 0, true, 25), 0);
});

test("§4.4b: an outcome comment still outweighs being ignored", () => {
  // one success (+0.30) on a record ignored three times still rises
  const ignored = computeIssueWeight("pattern", 0.5, 0, false, 3);
  const reinforced = computeIssueWeight("pattern", 0.5, 0.3, false, 3);
  assert.ok(reinforced > ignored + 0.25);
});

test("parseRecallUnused reads only (unused) refs from the Recall manifest", () => {
  const body = [
    "## Recall",
    "",
    "- **Surfaced:** #47 (used → success), #12 (used → success), #52 (unused), #61 (unused)",
    "- **Capture:** stored #91",
    "",
    "## Detail",
    "- #99 (unused) outside the manifest must not count",
  ].join("\n");
  assert.deepEqual(parseRecallUnused(body), [52, 61]);
});

test("parseRecallUnused is quiet on absent, empty or malformed manifests", () => {
  assert.deepEqual(parseRecallUnused(null), []);
  assert.deepEqual(parseRecallUnused(""), []);
  assert.deepEqual(parseRecallUnused("## Recall\n\n- **Capture:** declined"), []);
  // bare refs and used refs cost a record nothing
  assert.deepEqual(parseRecallUnused("## Recall\n- **Surfaced:** #47, #52 (used → success)"), []);
});

// Regression (2026-09-24): the section regex ended in `\Z`, which JavaScript
// reads as a literal Z, so a manifest that was the last section of the body
// — the usual place — parsed as empty and §4.4b/c never applied unless a
// timestamp's Z happened to follow the Surfaced line.
test("a manifest that closes the body still feeds §4.4b and §4.4c", () => {
  const last = "## Message\nwork\n\n## Recall\n- **Surfaced:** #47 (used → success), #52 (unused)\n";
  assert.deepEqual(parseRecallUsed(last), [{ issue: 47, outcome: "success" }]);
  assert.deepEqual(parseRecallUnused(last), [52]);
  assert.deepEqual(parseRecallUsed("## Recall\n- **Surfaced:** #47 (used → failure)"), [{ issue: 47, outcome: "failure" }]);
});

// --- §4.4c manifest reinforcement ----------------------------------------

test("§4.4c: a manifest ref is worth half a direct Outcome comment", () => {
  assert.equal(MANIFEST_SUCCESS, 0.15);
  assert.equal(MANIFEST_FAILURE, 0.10);
  assert.equal(manifestDelta("success"), 0.15);
  assert.equal(manifestDelta("failure"), -0.10);
});

test("§4.4c: a used-recall lifts a record that no comment reinforced", () => {
  // The injected-memory case: relied upon, cited in the manifest, never
  // commented on. Before v2.11 this record only ever decayed.
  const idle = computeIssueWeight("intent", 0.5, 0, false);
  const used = computeIssueWeight("intent", 0.5, manifestDelta("success"), false);
  assert.ok(used > idle);
  assert.equal(used, Math.round((0.5 * DECAY.intent + MANIFEST_SUCCESS) * 10000) / 10000);
  const failed = computeIssueWeight("intent", 0.5, manifestDelta("failure"), false);
  assert.equal(failed, Math.round((0.5 * DECAY.intent - MANIFEST_FAILURE) * 10000) / 10000);
});

test("§4.4c: Rule 12 and Rule 8 still win over manifest reinforcement", () => {
  assert.equal(computeIssueWeight("lifefact", 0.5, manifestDelta("failure"), false), 1.0);
  assert.equal(computeIssueWeight("pattern", 0.9, manifestDelta("success"), true), 0);
});

test("parseRecallUsed reads (used → outcome) refs with any arrow, neutral and bare refs ignored", () => {
  const body = [
    "## Recall",
    "",
    "- **Surfaced:** #47 (used → success), #12 (used -> failure), #13 (used => success), #52 (unused), #61 (used → neutral), #62 (used), #63",
    "- **Capture:** stored #91",
    "",
    "## Detail",
    "- #99 (used → success) outside the manifest must not count",
  ].join("\n");
  assert.deepEqual(parseRecallUsed(body), [
    { issue: 47, outcome: "success" },
    { issue: 12, outcome: "failure" },
    { issue: 13, outcome: "success" },
  ]);
  // …and the two parsers partition the same line without overlap.
  assert.deepEqual(parseRecallUnused(body), [52]);
});

test("parseRecallUsed is quiet on absent, empty or malformed manifests", () => {
  assert.deepEqual(parseRecallUsed(null), []);
  assert.deepEqual(parseRecallUsed(""), []);
  assert.deepEqual(parseRecallUsed("## Recall\n\n- **Capture:** declined"), []);
  assert.deepEqual(parseRecallUsed("- **Surfaced:** #47 (used → success) with no Recall heading"), []);
});
