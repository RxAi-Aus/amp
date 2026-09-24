// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// PROTOCOL.md §15.6 — the deterministic manifest audit: what a Surfaced line
// may contain, which refs the Librarian must be told about, and that the
// audit's parser and the compiler's agree on the refs that move weights.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRecallUnused, parseRecallUsed } from "../dist/compile_index.js";
import {
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  auditManifests,
  hasRecallManifest,
  parseSurfacedRefs,
  renderMarkdown,
  sessionWindow,
} from "../dist/manifest_audit.js";

const HOUR = 60 * 60 * 1000;

// One summary with every kind of ref: backed and unbacked claims, an unused
// mark, a bare ref, the fabricated id Sonnet wrote with AMP off on 2026-09-06,
// and a URL fragment on a line that is not a Surfaced line.
const body = `## Metadata
- **Agent:** sonnet
## Message
Spec task.
## Recall
- **Surfaced:** #47 (used → success), #52 (unused), #acme-speckit-state, #61 (used -> failure), #70, #80 (used => success)
- **Capture:** stored #91 — see https://github.com/acme/memory/issues/47#issuecomment-1
`;

test("parseSurfacedRefs reads every ref on the Surfaced lines, valid or not, and only there", () => {
  assert.deepEqual(parseSurfacedRefs(body), [
    { raw: "#47", issue: 47, marker: "success" },
    { raw: "#52", issue: 52, marker: "unused" },
    { raw: "#acme-speckit-state", issue: null, marker: null },
    { raw: "#61", issue: 61, marker: "failure" },
    { raw: "#70", issue: 70, marker: null },
    { raw: "#80", issue: 80, marker: "success" },
  ]);
  assert.equal(hasRecallManifest(body), true);
  assert.equal(hasRecallManifest("## Message\nno manifest here\n"), false);
  assert.deepEqual(parseSurfacedRefs("## Recall\n- **Surfaced:** none\n"), []);
});

test("the audit parser and the compiler agree on the refs that move weights", () => {
  const used = parseSurfacedRefs(body)
    .filter((ref) => ref.issue !== null && (ref.marker === "success" || ref.marker === "failure"))
    .map((ref) => ({ issue: ref.issue, outcome: ref.marker }));
  assert.deepEqual(parseRecallUsed(body), used);
  assert.deepEqual(
    parseRecallUnused(body),
    parseSurfacedRefs(body).filter((ref) => ref.marker === "unused").map((ref) => ref.issue),
  );
});

// JavaScript has no `\Z`; a section regex ending in it matches a literal Z,
// so a manifest that closes the body (the usual place for ## Recall) parsed
// as empty unless a timestamp happened to follow. Both parsers must read it.
test("a Recall manifest that is the last section of the body is still read", () => {
  const last = "## Message\nwork\n\n## Recall\n- **Surfaced:** #47 (used → success), #52 (unused)\n";
  assert.equal(parseSurfacedRefs(last).length, 2);
  assert.deepEqual(parseRecallUsed(last), [{ issue: 47, outcome: "success" }]);
  assert.deepEqual(parseRecallUnused(last), [52]);
  const noNewline = "## Recall\n- **Surfaced:** #47 (used → success)";
  assert.deepEqual(parseRecallUsed(noNewline), [{ issue: 47, outcome: "success" }]);
});

test("sessionWindow spans 48 h before the summary to 24 h after", () => {
  assert.equal(WINDOW_BEFORE_MS, 48 * HOUR);
  assert.equal(WINDOW_AFTER_MS, 24 * HOUR);
  assert.deepEqual(sessionWindow("2026-09-24T02:00:00Z"), { from: "2026-09-22T02:00:00Z", to: "2026-09-25T02:00:00Z" });
  assert.throws(() => sessionWindow("not a date"), /invalid summary created_at/);
});

test("auditManifests flags fabricated, unknown and unbacked refs and nothing else", async () => {
  const summaries = [{ number: 612, created_at: "2026-09-24T02:00:00Z", body }];
  const existing = new Set([47, 52, 70, 80]);
  const outcomes = new Map([[47, 1]]);
  const calls = [];
  const lookup = {
    async issueExists(issue) {
      calls.push(["exists", issue]);
      return existing.has(issue);
    },
    async outcomeComments(issue, from, to) {
      calls.push(["outcomes", issue, from, to]);
      return outcomes.get(issue) ?? 0;
    },
  };

  const report = await auditManifests(summaries, lookup, { since: "2026-09-17T00:00:00Z", now: new Date("2026-09-24T10:00:00.250Z") });
  assert.equal(report.generated_at, "2026-09-24T10:00:00Z");
  assert.equal(report.since, "2026-09-17T00:00:00Z");
  assert.equal(report.summaries_checked, 1);
  assert.equal(report.refs_checked, 6);
  assert.deepEqual(
    report.findings.map((f) => [f.type, f.summary, f.ref, f.claim ?? null]),
    [
      ["non_numeric_ref", 612, "#acme-speckit-state", null],
      ["unknown_issue", 612, "#61", null],
      ["unbacked_claim", 612, "#80", "success"],
    ],
  );
  assert.match(report.findings[2].detail, /between 2026-09-22T02:00:00Z and 2026-09-25T02:00:00Z/);
  // Outcome comments are looked up only for used→success|failure claims on
  // issues that exist: never for (unused), bare refs, or unknown issues.
  assert.deepEqual(calls.filter((c) => c[0] === "outcomes").map((c) => c[1]), [47, 80]);
  assert.deepEqual(calls.filter((c) => c[0] === "exists").map((c) => c[1]), [47, 52, 61, 70, 80]);
});

test("auditManifests is quiet on a clean window and orders summaries by number", async () => {
  const clean = { number: 700, created_at: "2026-09-24T03:00:00Z", body: "## Recall\n- **Surfaced:** #47 (used → success), #52 (unused)\n" };
  const earlier = { number: 650, created_at: "2026-09-23T03:00:00Z", body: "## Recall\n- **Surfaced:** #9999 (used → success)\n" };
  const lookup = {
    async issueExists(issue) {
      return issue !== 9999;
    },
    async outcomeComments() {
      return 1;
    },
  };
  const report = await auditManifests([clean, earlier], lookup, { since: "2026-09-17T00:00:00Z" });
  assert.equal(report.summaries_checked, 2);
  assert.equal(report.refs_checked, 3);
  assert.deepEqual(report.findings.map((f) => [f.type, f.summary, f.ref]), [["unknown_issue", 650, "#9999"]]);
});

test("renderMarkdown lists findings as a table and says so when there are none", async () => {
  const empty = renderMarkdown({ generated_at: "2026-09-24T10:00:00Z", since: "2026-09-17T00:00:00Z", summaries_checked: 0, refs_checked: 0, findings: [] });
  assert.match(empty, /^## Recall manifest audit \(deterministic, §15\.6\)/);
  assert.match(empty, /0 summaries with a `## Recall` manifest, 0 refs checked, 0 findings\./);
  assert.match(empty, /No Rule 10 summary carried a manifest/);

  const clean = renderMarkdown({ generated_at: "2026-09-24T10:00:00Z", since: "2026-09-17T00:00:00Z", summaries_checked: 1, refs_checked: 2, findings: [] });
  assert.match(clean, /1 summary with a `## Recall` manifest, 2 refs checked, 0 findings\./);
  assert.match(clean, /No findings: every ref names an existing issue/);

  const table = renderMarkdown({
    generated_at: "2026-09-24T10:00:00Z",
    since: "2026-09-17T00:00:00Z",
    summaries_checked: 1,
    refs_checked: 6,
    findings: [
      { type: "non_numeric_ref", summary: 612, ref: "#acme-speckit-state", detail: "not an issue number" },
      { type: "unbacked_claim", summary: 612, ref: "#80", claim: "success", detail: "no Outcome comment" },
    ],
  });
  assert.match(table, /\| Summary \| Ref \| Finding \| Detail \|/);
  assert.match(table, /\| #612 \| `#acme-speckit-state` \| non-numeric ref \| not an issue number \|/);
  assert.match(table, /\| #612 \| `#80` \| unbacked used-claim \| no Outcome comment \|/);
});
