// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * memory.mjs — AMP Board column 1–2 data source.
 *
 * Pure parsers over the memory clone's generated projections plus the thin
 * file I/O that feeds them. Reads local files only (REGION-*.md, okf/,
 * not_indexed.md, weights.json); never touches GitHub. Regexes are explicit
 * and local, matching the style of compile_index.ts / okf_export.ts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const TYPE_ORDER = ["intent", "facts", "pattern", "invalidation", "discovery", "events", "lifefact"];

const REGION_HEADER_RE = /^# Region:\s*(.+?)\s*-\s*Pointer Table\s*$/m;
const LAST_COMPILED_RE = /^\*\*Last Compiled:\*\*\s*(\S+)/m;
const ISSUE_COUNT_RE = /^\*\*Issues in Region:\*\*\s*(\d+)/m;
const PLACE_RE = /^\s*## Place:\s*(.+?)\s*$/;
const TYPE_RE = /^\s*### Type:\s*(\S+)\s*$/;
const SUMMARY_HEADING_RE = /^\s*### Summary\s*$/;
// | #337 | summary (may contain pipes) | 4 | 0.4822 | 2026-09-01 |
const ROW_RE = /^\s*\|\s*#(\d+)\s*\|\s*(.*?)\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|\s*(\S+)\s*\|\s*$/;
const ARCHIVED_LINE_RE = /\*\*Archived \(weight < [^)]*\):\*\*\s*(.*)$/;
const ARCHIVED_ITEM_RE = /#(\d+)\s*\(([^)]*)\)/g;

const NOT_INDEXED_SINCE_RE = /^\*\*Since Last Index Compile:\*\*\s*(\S+)/m;
const NOT_INDEXED_UPDATED_RE = /^\*\*Last Updated:\*\*\s*(\S+)/m;
const NOT_INDEXED_COUNT_RE = /^\*\*Unindexed Issue Count:\*\*\s*(\d+)/m;
// | #43 | openclaw | ProjectX | debugging | discovery | 2026-08-15T00:12:00Z |
const NOT_INDEXED_ROW_RE = /^\|\s*#(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/;

const SECTION_RE = /^## (.+?)\s*$/;
const COMMENT_RE = /^### (.+?) — (\S+)\s*$/;
const OUTCOME_RE = /\*\*Outcome:\*\*\s*(\w+)/;
const META_LINE_RE = /^- \*\*([A-Za-z-]+):\*\*\s*(.*?)\s*$/;

const SAFE_REGION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeRegion(name) {
  return typeof name === "string" && SAFE_REGION_RE.test(name) && !name.includes("..");
}

function typeRank(type) {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
}

function parseArchivedList(text) {
  const out = [];
  for (const m of text.matchAll(ARCHIVED_ITEM_RE)) out.push({ n: Number(m[1]), title: m[2].trim() });
  return out;
}

/**
 * Parse one REGION-<name>.md pointer table.
 * → { region, lastCompiled, issueCount, activeCount, places, archived }
 *   places: [{ place, types: [{ type, rows: [{ n, title, comments, weight, updated }] }], archived }]
 */
export function parseRegionFile(text) {
  const region = (text.match(REGION_HEADER_RE) || [])[1] || null;
  const lastCompiled = (text.match(LAST_COMPILED_RE) || [])[1] || null;
  const issueCount = Number((text.match(ISSUE_COUNT_RE) || [])[1] || 0);

  const places = [];
  let place = null;
  let type = null;
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = line.match(PLACE_RE))) {
      place = { place: m[1], types: [], archived: [] };
      places.push(place);
      type = null;
      continue;
    }
    if (!place) continue;
    if ((m = line.match(TYPE_RE))) {
      type = { type: m[1], rows: [] };
      place.types.push(type);
      continue;
    }
    if (SUMMARY_HEADING_RE.test(line)) {
      type = null;
      continue;
    }
    if ((m = line.match(ARCHIVED_LINE_RE))) {
      place.archived.push(...parseArchivedList(m[1]));
      continue;
    }
    if (type && (m = line.match(ROW_RE))) {
      type.rows.push({
        n: Number(m[1]),
        title: m[2],
        comments: Number(m[3]),
        weight: Number(m[4]),
        updated: m[5],
      });
    }
  }

  let activeCount = 0;
  for (const p of places) {
    p.types.sort((a, b) => typeRank(a.type) - typeRank(b.type));
    for (const t of p.types) {
      t.rows.sort((a, b) => b.weight - a.weight || a.n - b.n);
      activeCount += t.rows.length;
    }
  }
  const archived = places.flatMap((p) => p.archived.map((a) => ({ ...a, place: p.place })));
  return { region, lastCompiled, issueCount, activeCount, places, archived };
}

function coerceFrontmatterValue(raw) {
  const v = raw.trim();
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
  }
  if (/^"(.*)"$/.test(v)) return v.slice(1, -1);
  if (/^'(.*)'$/.test(v)) return v.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

function parseFrontmatter(lines) {
  // Frontmatter lives between the first two `---` lines, and only if the
  // very first non-empty line is `---`.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (lines[i].trim() === "---") start = i;
    break;
  }
  if (start === -1) return { frontmatter: {}, bodyStart: 0 };
  const frontmatter = {};
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return { frontmatter, bodyStart: i + 1 };
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) frontmatter[m[1]] = coerceFrontmatterValue(m[2]);
  }
  return { frontmatter, bodyStart: lines.length };
}

function parseComments(lines) {
  const comments = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(COMMENT_RE);
    if (m) {
      current = { author: m[1].trim(), at: m[2], lines: [] };
      comments.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return comments.map((c) => {
    const body = c.lines.join("\n").trim();
    const o = body.match(OUTCOME_RE);
    return { author: c.author, at: c.at, body, outcome: o ? o[1].toLowerCase() : null };
  });
}

function parseMetadata(body) {
  const meta = {};
  for (const line of body.split("\n")) {
    const m = line.match(META_LINE_RE);
    if (m) meta[m[1].toLowerCase().replace(/-/g, "_")] = m[2];
  }
  return meta;
}

/**
 * Parse an okf/<region>/<place>/issue-N.md file.
 * → { frontmatter, meta, sections: [{name, body}], comments: [{author, at, body, outcome}], raw }
 * `meta` is the `## Metadata` bullet list flattened ({from, to, region, place, type, posted, thread_id}).
 */
export function parseOkfIssue(text) {
  const lines = text.split(/\r?\n/);
  const { frontmatter, bodyStart } = parseFrontmatter(lines);
  const sections = [];
  let commentLines = null;
  let current = null;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (commentLines) {
      commentLines.push(line);
      continue;
    }
    const m = line.match(SECTION_RE);
    if (m) {
      if (m[1] === "Comments") {
        commentLines = [];
        continue;
      }
      current = { name: m[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  const finished = sections.map((s) => ({ name: s.name, body: s.lines.join("\n").trim() }));
  const metaSection = finished.find((s) => s.name === "Metadata");
  return {
    frontmatter,
    meta: metaSection ? parseMetadata(metaSection.body) : {},
    sections: finished,
    comments: commentLines ? parseComments(commentLines) : [],
    raw: text,
  };
}

/** Parse not_indexed.md → { since, updated, count, rows: [{ n, from, region, place, type, posted }] } */
export function parseNotIndexed(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(NOT_INDEXED_ROW_RE);
    if (m) {
      rows.push({ n: Number(m[1]), from: m[2], region: m[3], place: m[4], type: m[5], posted: m[6] });
    }
  }
  return {
    since: (text.match(NOT_INDEXED_SINCE_RE) || [])[1] || null,
    updated: (text.match(NOT_INDEXED_UPDATED_RE) || [])[1] || null,
    count: Number((text.match(NOT_INDEXED_COUNT_RE) || [])[1] || rows.length),
    rows,
  };
}

/** Parse weights.json → { weights: { [n]: number }, lastCompiled } */
export function parseWeights(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return { weights: {}, lastCompiled: null };
    const weights = {};
    let lastCompiled = null;
    for (const [k, v] of Object.entries(parsed)) {
      if (k === "_last_compile_iso") lastCompiled = typeof v === "string" ? v : null;
      else if (/^\d+$/.test(k) && typeof v === "number") weights[k] = v;
    }
    return { weights, lastCompiled };
  } catch {
    return { weights: {}, lastCompiled: null };
  }
}

// ---------------------------------------------------------------------------
// File I/O (thin; everything above is pure)
// ---------------------------------------------------------------------------

function safeRead(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readNotIndexed(clone) {
  const text = safeRead(path.join(clone, "not_indexed.md"));
  return text === null ? { since: null, updated: null, count: 0, rows: [] } : parseNotIndexed(text);
}

export function readWeights(clone) {
  const text = safeRead(path.join(clone, "weights.json"));
  return text === null ? { weights: {}, lastCompiled: null } : parseWeights(text);
}

/** Region names present as REGION-<name>.md, sorted case-insensitively. */
export function listRegionNames(clone) {
  let names;
  try {
    names = readdirSync(clone);
  } catch {
    return [];
  }
  return names
    .map((f) => f.match(/^REGION-(.+)\.md$/))
    .filter(Boolean)
    .map((m) => m[1])
    .filter(isSafeRegion)
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** One summary entry per REGION file (column 1). */
export function listProjects(clone) {
  const notIndexed = readNotIndexed(clone);
  return listRegionNames(clone).map((region) => {
    const parsed = parseRegionFile(safeRead(path.join(clone, `REGION-${region}.md`)) || "");
    return {
      region,
      lastCompiled: parsed.lastCompiled,
      issueCount: parsed.issueCount,
      placeCount: parsed.places.length,
      activeCount: parsed.activeCount,
      archivedCount: parsed.archived.length,
      unindexedCount: notIndexed.rows.filter((r) => r.region === region).length,
    };
  });
}

/** Full column-2 payload for one region, or null when the file is missing. */
export function readRegion(clone, region) {
  if (!isSafeRegion(region)) return null;
  const text = safeRead(path.join(clone, `REGION-${region}.md`));
  if (text === null) return null;
  const parsed = parseRegionFile(text);
  const notIndexed = readNotIndexed(clone);
  return { ...parsed, region, unindexed: notIndexed.rows.filter((r) => r.region === region) };
}

// okf/<region>/<place>/issue-N.md path map, rebuilt when okf/ changes.
const issueMapCache = new Map(); // clone → { stamp, map }

function okfStamp(clone) {
  try {
    const st = statSync(path.join(clone, "okf", "index.md"));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "none";
  }
}

function buildIssueMap(clone) {
  const map = new Map();
  const okf = path.join(clone, "okf");
  if (!existsSync(okf)) return map;
  for (const region of readdirSync(okf, { withFileTypes: true })) {
    if (!region.isDirectory()) continue;
    const regionDir = path.join(okf, region.name);
    for (const place of readdirSync(regionDir, { withFileTypes: true })) {
      if (!place.isDirectory()) continue;
      const placeDir = path.join(regionDir, place.name);
      for (const file of readdirSync(placeDir)) {
        const m = file.match(/^issue-(\d+)\.md$/);
        if (m) map.set(Number(m[1]), { file: path.join(placeDir, file), region: region.name, place: place.name });
      }
    }
  }
  return map;
}

export function invalidateIssueCache(clone) {
  if (clone) issueMapCache.delete(clone);
  else issueMapCache.clear();
}

function issueMap(clone) {
  const stamp = okfStamp(clone);
  const cached = issueMapCache.get(clone);
  if (cached && cached.stamp === stamp) return cached.map;
  const map = buildIssueMap(clone);
  issueMapCache.set(clone, { stamp, map });
  return map;
}

export function findIssueFile(clone, n) {
  const entry = issueMap(clone).get(Number(n));
  return entry ? entry.file : null;
}

/** Parsed OKF issue plus location, or null when not compiled locally. */
export function readIssue(clone, n) {
  const entry = issueMap(clone).get(Number(n));
  if (!entry) return null;
  const text = safeRead(entry.file);
  if (text === null) return null;
  return { n: Number(n), region: entry.region, place: entry.place, file: entry.file, ...parseOkfIssue(text) };
}
