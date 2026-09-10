#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * amp-recall.mjs — repo-aware RECALL (Protocol §15.1, issue #442)
 *
 * The navigation layer (INDEX.md + not_indexed.md) tells an agent that
 * regions exist; it does not tell the agent that one of those regions is the
 * repository it is standing in. This module closes that gap:
 *
 *   1. Derive project identifiers from the working directory: directory
 *      basename, origin remote repo name, and the current branch.
 *   2. Match identifiers against Region names in REGION-*.md and the Region
 *      column of not_indexed.md (case-insensitive, punctuation-insensitive,
 *      substring either way).
 *   3. Rank the matched issues: intent → facts → pattern → invalidation →
 *      discovery → events, then a Place-matches-branch bonus, then weight.
 *      Unindexed issues rank as weight 1.0 (fresh beats decayed).
 *   4. Fetch the top N open issues with `gh` (fail-soft: titles only when
 *      gh is missing or slow) and return a formatted block whose excerpts are
 *      the `## Message` section of each body, capped.
 *   5. Offer `compactIndex` / `compactNotIndexed` so the navigation layer
 *      can be rendered around the matched Regions instead of verbatim.
 *
 * Token budget (measured 2026-09-06 with o200k ×1.18 on a 17-Region index):
 * the verbatim block was ~8.2 KB ≈ 2.75k tokens, paid again on every turn as
 * part of the cached prefix. The caps below plus the compact navigation
 * layer bring a typical block to ~4–5 KB. Zero dependencies. Every failure
 * degrades to a smaller block, never throws past `buildRepoRecall`.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const TYPE_ORDER = ["intent", "facts", "pattern", "invalidation", "discovery", "events", "lifefact"];
export const DEFAULT_LIMIT = 3;
export const EXCERPT_CAP = 800;
export const BLOCK_CAP = 3200;
const MIN_ID_LENGTH = 4;

export function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function tokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
}

function git(cwd, args, timeout = 3000) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Identifiers describing the project at `cwd`. Returns { names, branch }. */
export function projectIdentifiers(cwd) {
  const names = new Set();
  const top = git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  if (top) names.add(path.basename(top));
  if (cwd && cwd !== top) names.add(path.basename(cwd));
  const remote = git(top, ["remote", "get-url", "origin"]);
  const m = remote.match(/[:/]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/);
  if (m) names.add(m[2]);
  const branch = git(top, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    names: [...names].filter((n) => normalize(n).length >= MIN_ID_LENGTH),
    branch: branch && branch !== "HEAD" ? branch : "",
  };
}

export function regionMatches(region, names) {
  const r = normalize(region);
  if (r.length < MIN_ID_LENGTH) return false;
  return names.some((n) => {
    const v = normalize(n);
    return v === r || v.includes(r) || r.includes(v);
  });
}

function placeMatchesBranch(place, branch) {
  if (!place || !branch) return false;
  const p = tokens(place);
  if (p.length === 0) return false;
  const b = new Set(tokens(branch));
  return p.every((t) => b.has(t));
}

/** Parse one REGION-*.md pointer table into candidate rows. */
export function parseRegionFile(text, region) {
  const rows = [];
  let place = "";
  let type = "";
  for (const line of text.split("\n")) {
    const p = line.match(/^##\s+Place:\s*(.+?)\s*$/);
    if (p) { place = p[1]; type = ""; continue; }
    const t = line.match(/^\s*###\s+Type:\s*(\w+)/);
    if (t) { type = t[1].toLowerCase(); continue; }
    const r = line.match(/^\s*\|\s*#(\d+)\s*\|\s*(.*?)\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|/);
    if (r && type) {
      rows.push({ issue: Number(r[1]), summary: r[2], region, place, type, weight: Number(r[4]) || 0, source: "index" });
    }
  }
  return rows;
}

/** Parse not_indexed.md rows: | Issue | From | Region | Place | Type | Posted | */
export function parseNotIndexed(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const r = line.match(/^\s*\|\s*#(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/);
    if (r && /^\d+$/.test(r[1])) {
      rows.push({ issue: Number(r[1]), summary: "", region: r[3], place: r[4], type: r[5].toLowerCase(), weight: 1, source: "unindexed" });
    }
  }
  return rows;
}

/** Collect and rank candidate issues for the project from the local clone. */
export function collectCandidates(repoPath, { names, branch }) {
  const found = new Map();
  const add = (row) => {
    if (!regionMatches(row.region, names)) return;
    const prev = found.get(row.issue);
    if (!prev || row.source === "unindexed") found.set(row.issue, { ...prev, ...row, summary: row.summary || prev?.summary || "" });
  };
  try {
    for (const file of readdirSync(repoPath)) {
      const m = file.match(/^REGION-(.+)\.md$/);
      if (!m) continue;
      const text = readFileSync(path.join(repoPath, file), "utf8");
      parseRegionFile(text, m[1]).forEach(add);
    }
  } catch { /* no region files: fall through to not_indexed */ }
  try {
    parseNotIndexed(readFileSync(path.join(repoPath, "not_indexed.md"), "utf8")).forEach(add);
  } catch { /* optional */ }

  const rank = (row) => {
    const t = TYPE_ORDER.indexOf(row.type);
    return t === -1 ? TYPE_ORDER.length : t;
  };
  return [...found.values()]
    .map((row) => ({ ...row, placeMatch: placeMatchesBranch(row.place, branch) }))
    .sort((a, b) => rank(a) - rank(b) || Number(b.placeMatch) - Number(a.placeMatch) || b.weight - a.weight || b.issue - a.issue);
}

/** Excerpt: the `## Message` section when present, else body minus Metadata. */
export function excerptOf(body, cap = EXCERPT_CAP) {
  const text = String(body || "").replace(/\r/g, "");
  let section = text.match(/(?:^|\n)##\s+Message[^\n]*\n([\s\S]*?)(?=\n##\s|$)/)?.[1];
  if (!section) section = text.replace(/(?:^|\n)##\s+Metadata[^\n]*\n[\s\S]*?(?=\n##\s|$)/, "");
  const compact = section.replace(/\n{3,}/g, "\n\n").trim();
  return compact.length > cap ? compact.slice(0, cap).trimEnd() + " …" : compact;
}

/** Fetch one issue via gh. Returns { number, title, state, body } or null. */
export function fetchIssue(slug, number, timeout = 8000) {
  try {
    const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", slug, "--json", "number,title,state,body"], {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Compact INDEX.md around the matched Regions (§15.1 RECALL). The header
 * (Last Compiled, totals) and the full entries of `regions` stay verbatim;
 * every other Region collapses to one item — name plus its active thread
 * numbers — so the agent can still name every Region and the compile time
 * (the §15.1 observable test) at a fraction of the tokens. Input that does
 * not parse into `## Region:` sections is returned unchanged.
 */
export function compactIndex(text, regions) {
  const raw = String(text || "");
  const wanted = new Set((regions || []).map(normalize));
  const parts = raw.split(/^(?=## Region: )/m);
  if (parts.length < 2 || wanted.size === 0) return raw;
  const header = parts[0].replace(/\n-{3,}\s*$/, "").trimEnd();
  const kept = [];
  const others = [];
  for (const section of parts.slice(1)) {
    const name = section.match(/^## Region:\s*(.+?)\s*$/m)?.[1] || "";
    if (wanted.has(normalize(name))) {
      kept.push(section.trimEnd());
      continue;
    }
    // Pointers are comma-separated and now carry titles (§4.1, v2.10), so match
    // only refs in pointer position -- a "#47" inside a title is not a pointer.
    const activeLine = section.match(/Active threads:\s*([^\n]*)/)?.[1] || "";
    const active = [...activeLine.matchAll(/(?:^|,\s*)(#\d+)/g)].map((m) => m[1]);
    others.push(`${name} (${active.length ? active.join(" ") : "no active threads"})`);
  }
  const out = [header];
  if (kept.length) out.push("", ...kept);
  if (others.length) out.push("", `Other Regions (${others.length}; pointer tables in REGION-<name>.md): ${others.join("; ")}.`);
  return out.join("\n") + "\n";
}

/**
 * not_indexed.md with nothing in it is a header and an empty table; render
 * it as one line instead. A file with rows is returned unchanged.
 */
export function compactNotIndexed(text) {
  const raw = String(text || "");
  const count = Number(raw.match(/\*\*Unindexed Issue Count:\*\*\s*(\d+)/)?.[1]);
  const hasRows = /^\s*\|\s*#\d+\s*\|/m.test(raw);
  if (hasRows || (Number.isNaN(count) ? true : count > 0)) return raw;
  const since = raw.match(/\*\*Since Last Index Compile:\*\*\s*(\S+)/)?.[1];
  return `# Not Yet Indexed — empty (0 issues since the last compile${since ? ` at ${since}` : ""})\n`;
}

/**
 * Build the injected block. Returns { text, surfaced, regions } where
 * surfaced lists { issue, title } for ledger recording and regions names the
 * matched Regions. text is "" when nothing matched.
 */
export function buildRepoRecall({ cwd, repoPath, repoSlug, limit = DEFAULT_LIMIT, fetch = fetchIssue }) {
  const out = { text: "", surfaced: [], regions: [] };
  try {
    if (!cwd || !repoPath) return out;
    const ids = projectIdentifiers(cwd);
    if (ids.names.length === 0) return out;
    const candidates = collectCandidates(repoPath, ids);
    if (candidates.length === 0) return out;
    out.regions = [...new Set(candidates.map((c) => c.region))];

    const lines = [];
    const label = ids.names[0] + (ids.branch ? ` @ ${ids.branch}` : "");
    lines.push(`--- Memories for this repo (${label}) — read before starting ---`);
    lines.push(`Matched region(s): ${out.regions.join(", ")} · ${candidates.length} open pointer(s), showing top ${Math.min(limit, candidates.length)}.`);

    let used = 0;
    let shown = 0;
    for (const c of candidates) {
      if (shown >= limit) break;
      const issue = repoSlug ? fetch(repoSlug, c.issue) : null;
      if (issue && String(issue.state).toUpperCase() !== "OPEN") continue;
      const title = issue?.title || c.summary || `issue #${c.issue}`;
      const head = `\n#${c.issue} [${c.type} · ${c.place}${c.placeMatch ? " · matches branch" : ""} · w:${c.weight.toFixed(2)}${c.source === "unindexed" ? " · unindexed" : ""}] ${title}`;
      const excerpt = issue ? excerptOf(issue.body) : "(body not fetched — run: gh issue view " + c.issue + (repoSlug ? ` --repo ${repoSlug}` : "") + ")";
      const chunk = head + "\n" + excerpt.split("\n").map((l) => "  " + l).join("\n");
      if (used + chunk.length > BLOCK_CAP) break;
      lines.push(chunk);
      used += chunk.length;
      shown += 1;
      out.surfaced.push({ issue: c.issue, title });
    }
    const rest = candidates.slice(shown).map((c) => `#${c.issue}`).join(", ");
    if (rest) lines.push(`\nAlso open for this repo, not expanded: ${rest}.`);
    lines.push("Read the intent first, then facts/patterns; before trusting a facts entry check for a newer invalidation in the same Place (Rule 8).");
    out.text = lines.join("\n");
  } catch {
    /* fail-soft: navigation layer is still injected by the caller */
  }
  return out;
}
