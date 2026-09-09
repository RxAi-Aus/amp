// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// PROTOCOL.md §6 title tags, §7 Outcome markers, Rule 8 Supersedes refs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { getTag, parseOutcome, parseSupersededTargets } from "../dist/compile_index.js";
import { getSender, rowFor } from "../dist/track_not_indexed.js";

test("getTag extracts bracketed tag values and trims whitespace", () => {
  const title = "[FROM:openclaw→claudecowork][REGION:ProjectX][PLACE: sub topic ][TYPE:discovery] Memory sync test";
  assert.equal(getTag(title, "REGION"), "ProjectX");
  assert.equal(getTag(title, "PLACE"), "sub topic");
  assert.equal(getTag(title, "TYPE"), "discovery");
  assert.equal(getTag(title, "MISSING"), undefined);
});

test("getSender parses [FROM:a→b], tolerates -> and plain [FROM:a]", () => {
  assert.equal(getSender("[FROM:openclaw→claudecowork] x"), "openclaw");
  assert.equal(getSender("[FROM:codex->all] x"), "codex");
  assert.equal(getSender("[FROM:solo] x"), "solo");
  assert.equal(getSender("no tags at all"), "unknown");
});

test("rowFor lowercases TYPE and applies protocol defaults", () => {
  const row = rowFor(
    "[FROM:openclaw→all][REGION:ProjectX][PLACE:debugging][TYPE:Discovery] test",
    43,
    "2026-08-15T00:12:00Z",
  );
  assert.deepEqual(row, {
    number: 43,
    sender: "openclaw",
    region: "ProjectX",
    place: "debugging",
    kind: "discovery",
    created: "2026-08-15T00:12:00Z",
  });

  const untagged = rowFor("no tags", 44, "2026-08-15T00:45:00Z");
  assert.equal(untagged.sender, "unknown");
  assert.equal(untagged.region, "Untagged");
  assert.equal(untagged.place, "General");
  assert.equal(untagged.kind, "events");
});

test("parseOutcome reads canonical markers, defaults to neutral", () => {
  assert.equal(parseOutcome("## Reply Metadata\n- **Outcome:** success\n\ntext"), "success");
  assert.equal(parseOutcome("**Outcome:** failure"), "failure");
  assert.equal(parseOutcome("- **Outcome:** SUCCESS"), "success");
  assert.equal(parseOutcome("Outcome: success"), "neutral"); // missing bold markers
  assert.equal(parseOutcome("no marker here"), "neutral");
  assert.equal(parseOutcome(undefined), "neutral");
});

test("parseSupersededTargets takes only leading refs, ignores prose tails", () => {
  assert.deepEqual(parseSupersededTargets("- **Supersedes:** #12"), [12]);
  assert.deepEqual(parseSupersededTargets("- **Supersedes:** #12, #13"), [12, 13]);
  assert.deepEqual(
    parseSupersededTargets("- **Supersedes:** #12 — replaced by #45"),
    [12], // #45 is prose, must NOT be archived
  );
  assert.deepEqual(parseSupersededTargets("Supersedes: #7"), [7]);
  assert.deepEqual(parseSupersededTargets("- **Supersedes:** see #12"), []); // refs must lead
  assert.deepEqual(parseSupersededTargets("no such line"), []);
  assert.deepEqual(parseSupersededTargets(null), []);
  assert.deepEqual(
    parseSupersededTargets("- **Supersedes:** #1\ntext\n- **Supersedes:** #2, #3 and prose"),
    [1, 2, 3],
  );
});
