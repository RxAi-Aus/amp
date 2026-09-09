// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// AMP Board — board/lib/memory.mjs: pure parsers over the memory clone's
// generated projections (REGION-*.md, okf/, not_indexed.md, weights.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TYPE_ORDER,
  parseRegionFile,
  parseOkfIssue,
  parseNotIndexed,
  parseWeights,
  listProjects,
  readRegion,
  readIssue,
  findIssueFile,
  isSafeRegion,
} from "../board/lib/memory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const clone = path.join(here, "fixtures/board/clone");
const read = (rel) => readFileSync(path.join(clone, rel), "utf8");

test("TYPE_ORDER is the protocol read order with lifefact last", () => {
  assert.deepEqual(TYPE_ORDER, ["intent", "facts", "pattern", "invalidation", "discovery", "events", "lifefact"]);
});

test("parseRegionFile reads header, places, types and rows", () => {
  const r = parseRegionFile(read("REGION-Sample.md"));
  assert.equal(r.region, "Sample");
  assert.equal(r.lastCompiled, "2026-09-02T02:35:40Z");
  assert.equal(r.issueCount, 4);
  assert.deepEqual(
    r.places.map((p) => p.place),
    ["content-pipeline", "deploy-pipeline", "site-identity"],
  );
  const cp = r.places[0];
  // Types follow the protocol read order, not file order.
  assert.deepEqual(cp.types.map((t) => t.type), ["intent", "pattern"]);
  const intent = cp.types[0];
  // Rows sorted by weight descending; pipes inside the summary survive.
  assert.deepEqual(intent.rows.map((x) => x.n), [339, 337]);
  assert.deepEqual(intent.rows[1], {
    n: 337,
    title: "Publish one release note per sprint",
    comments: 4,
    weight: 0.4822,
    updated: "2026-09-01",
  });
  assert.equal(intent.rows[0].title, "Higher weight intent | with pipe");
});

test("parseRegionFile collects archived issues per place and overall", () => {
  const r = parseRegionFile(read("REGION-Sample.md"));
  const si = r.places.find((p) => p.place === "site-identity");
  assert.deepEqual(si.archived, [
    { n: 312, title: "Docs site stands alone, no cross-links" },
    { n: 305, title: "Folderless agent needs a workspace" },
  ]);
  assert.deepEqual(si.types, []);
  assert.equal(r.archived.length, 2);
  assert.equal(r.activeCount, 4);
});

test("parseRegionFile handles an empty region", () => {
  const r = parseRegionFile(read("REGION-Empty.md"));
  assert.equal(r.region, "Empty");
  assert.equal(r.issueCount, 0);
  assert.deepEqual(r.places, []);
  assert.deepEqual(r.archived, []);
});

test("parseOkfIssue splits frontmatter, sections and comments", () => {
  const i = parseOkfIssue(read("okf/Sample/content-pipeline/issue-337.md"));
  assert.equal(i.frontmatter.type, "intent");
  assert.equal(i.frontmatter.title, "Publish one release note per sprint");
  assert.deepEqual(i.frontmatter.tags, ["Sample", "content-pipeline", "codex"]);
  assert.equal(i.frontmatter.amp_issue, 337);
  assert.equal(i.frontmatter.amp_weight, 0.4822);
  assert.equal(i.frontmatter.amp_region, "Sample");
  assert.equal(i.frontmatter.amp_outcome, "success");
  assert.deepEqual(
    i.sections.map((s) => s.name),
    ["Metadata", "Context Pointer", "Message", "Expected Action"],
  );
  assert.match(i.sections[2].body, /^The release-notes pipeline/);
  assert.equal(i.comments.length, 4);
  assert.equal(i.comments[0].author, "sample-user");
  assert.equal(i.comments[0].at, "2026-08-19T13:21:03Z");
  assert.equal(i.comments[0].outcome, "success");
  assert.match(i.comments[1].body, /Thursday fallback applied the quality gate/);
  assert.equal(i.comments[3].at, "2026-09-01T11:01:33Z");
  assert.equal(i.meta.from, "codex");
  assert.equal(i.meta.to, "all");
  assert.equal(i.meta.posted, "2026-08-19T10:31:22.767Z");
  assert.equal(typeof i.raw, "string");
});

test("parseOkfIssue tolerates missing frontmatter and no comments", () => {
  const i = parseOkfIssue("## Message\nhello\n");
  assert.deepEqual(i.frontmatter, {});
  assert.deepEqual(i.sections, [{ name: "Message", body: "hello" }]);
  assert.deepEqual(i.comments, []);
});

test("parseNotIndexed reads the 6-column table", () => {
  const n = parseNotIndexed(read("not_indexed.md"));
  assert.equal(n.since, "2026-09-02T02:35:40Z");
  assert.equal(n.updated, "2026-09-02T03:00:00Z");
  assert.equal(n.count, 2);
  assert.deepEqual(n.rows[0], {
    n: 395,
    from: "codex",
    region: "Sample",
    place: "content-pipeline",
    type: "discovery",
    posted: "2026-09-02T02:50:00Z",
  });
  assert.equal(n.rows.length, 2);
});

test("parseWeights separates the map from _last_compile_iso", () => {
  const w = parseWeights(read("weights.json"));
  assert.equal(w.lastCompiled, "2026-09-02T02:35:40Z");
  assert.equal(w.weights[337], 0.4822);
  assert.equal("_last_compile_iso" in w.weights, false);
  assert.deepEqual(parseWeights("not json"), { weights: {}, lastCompiled: null });
});

test("listProjects returns one entry per REGION file with counts", () => {
  const projects = listProjects(clone);
  assert.deepEqual(projects.map((p) => p.region), ["Empty", "Sample"]);
  const s = projects[1];
  assert.equal(s.issueCount, 4);
  assert.equal(s.placeCount, 3);
  assert.equal(s.activeCount, 4);
  assert.equal(s.archivedCount, 2);
  assert.equal(s.unindexedCount, 1);
  assert.equal(s.lastCompiled, "2026-09-02T02:35:40Z");
});

test("readRegion attaches unindexed rows from not_indexed.md", () => {
  const r = readRegion(clone, "Sample");
  assert.equal(r.unindexed.length, 1);
  assert.equal(r.unindexed[0].n, 395);
  assert.equal(readRegion(clone, "Nope"), null);
});

test("findIssueFile / readIssue locate okf bodies by number", () => {
  assert.match(findIssueFile(clone, 337), /okf\/Sample\/content-pipeline\/issue-337\.md$/);
  assert.equal(findIssueFile(clone, 999), null);
  const i = readIssue(clone, 337);
  assert.equal(i.n, 337);
  assert.equal(i.region, "Sample");
  assert.equal(i.place, "content-pipeline");
  assert.equal(readIssue(clone, 999), null);
});

test("isSafeRegion rejects path traversal", () => {
  assert.equal(isSafeRegion("MyProject"), true);
  assert.equal(isSafeRegion("agy-diary"), true);
  assert.equal(isSafeRegion("../etc"), false);
  assert.equal(isSafeRegion("a/b"), false);
  assert.equal(isSafeRegion(""), false);
});
