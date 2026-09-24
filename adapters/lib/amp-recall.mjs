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
 *      the summary tier of each body (§15.1, v2.11): the `## Now` section
 *      when the author wrote one, else the opening prose of `## Message`
 *      before its first list — one line, capped. Bodies stay fetch-on-demand.
 *   5. Offer `compactIndex` / `compactNotIndexed` so the navigation layer
 *      can be rendered around the matched Regions instead of verbatim.
 *   6. Task-aware stage (v2.11): `buildRepoRecall` at the pointer tier lists
 *      the matched records as title lines only, and `buildPromptRecall`
 *      expands to the summary tier just the records whose title/Place
 *      lexically overlap the user's prompt (stemmed ASCII tokens minus
 *      stopwords, CJK bigrams, explicit `#N` refs). Overlaps are weighted:
 *      a Place token 2, generic software vocabulary ("cloud", "function",
 *      "config" — a fixed list) 0.5, a term rare across the store's pointer
 *      tables 2, anything else 1; a record needs 2 to expand. A title that
 *      shares only the project's everyday vocabulary with the prompt is not
 *      evidence, a Place or a distinctive word is. A prompt that matches
 *      nothing injects nothing:
 *      on a task no memory covered, unrelated injected summaries cost
 *      14–17 KB of extra reading (2026-09-23).
 *
 * Token budget (measured 2026-09-06 with o200k ×1.18 on a 17-Region index):
 * the verbatim block was ~8.2 KB ≈ 2.75k tokens, paid again on every turn as
 * part of the cached prefix. The compact navigation layer and 800-char
 * excerpts brought that to ~4–5 KB; the summary tier (2026-09-23) takes the
 * excerpts to ≤ 240 chars each. Size was not the only cost: on identical
 * tasks an injected intent whose Message enumerated the user's decisions
 * doubled a high-effort model's tool output, because the list read as
 * things to verify. Lists therefore never enter the injection. Zero
 * dependencies. Every failure degrades to a smaller block, never throws
 * past `buildRepoRecall`.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const TYPE_ORDER = ["intent", "facts", "pattern", "invalidation", "discovery", "events", "lifefact"];
export const DEFAULT_LIMIT = 3;
export const SUMMARY_CAP = 240;
export const BLOCK_CAP = 3200;
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MATCH_THRESHOLD = 2;
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

// Function words and generic request verbs: an overlap on one of these says
// nothing about the task. Domain words are deliberately absent — "memory" or
// "image" in a prompt is exactly the signal wanted.
const STOPWORDS = new Set(`
  the and for nor but yet with without within into onto from about above below over under are was were been
  being have has had does did not this that these those there here its they them their our you your who whom
  which what when where why how can could should would will shall may might must need want like just also than
  then too very more most some any all each every both either neither such same other another only own off out
  again further once before after during while because unless until although though even still new old make made
  get got use used using set run see show tell find look add fix keep let give take put try check help please
  thanks explain describe list summarize summarise write read open
`.trim().split(/\s+/));
// CJK function characters: a bigram containing one carries no topic.
const CJK_STOP = /[的了是在和與或及我你他她它們這那個也都就要會有不沒把被讓對於為麼嗎呢吧啊]/;

/** Light stemming so "commits" meets "commit" and "adapters" meets "adapter". */
function stem(token) {
  return token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

function termsOf(text, ignore = new Set()) {
  const out = new Set();
  for (const t of tokens(text)) {
    if (STOPWORDS.has(t)) continue;
    const st = stem(t);
    if (!ignore.has(t) && !ignore.has(st)) out.add(st);
  }
  return out;
}

function cjkBigrams(text) {
  const grams = new Set();
  for (const run of String(text || "").match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (!CJK_STOP.test(gram)) grams.add(gram);
    }
  }
  return grams;
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

function typeRank(row) {
  const t = TYPE_ORDER.indexOf(row.type);
  return t === -1 ? TYPE_ORDER.length : t;
}

/** Every pointer row in the clone (REGION tables + not_indexed), keyed by issue; unindexed rows win. */
export function collectRows(repoPath) {
  const found = new Map();
  const add = (row) => {
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
  return found;
}

/** Collect and rank candidate issues for the project from the local clone. */
export function collectCandidates(repoPath, { names, branch }) {
  return [...collectRows(repoPath).values()]
    .filter((row) => regionMatches(row.region, names))
    .map((row) => ({ ...row, placeMatch: placeMatchesBranch(row.place, branch) }))
    .sort((a, b) => typeRank(a) - typeRank(b) || Number(b.placeMatch) - Number(a.placeMatch) || b.weight - a.weight || b.issue - a.issue);
}

/**
 * Document frequency of every term over the store's pointer rows (title
 * column + Place): how many rows mention it. What "rare" means below.
 */
export function termFrequencies(rows) {
  const df = new Map();
  let count = 0;
  for (const r of rows) {
    count += 1;
    for (const t of termsOf(`${r.summary || ""} ${r.place || ""}`)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { df, rows: count };
}

// Generic software vocabulary: a title that shares only these with the prompt
// is not about the prompt. A store cannot tell — in a memory store about a
// Firebase app "function" and "cloud" sit in one title and in every task —
// so the list is fixed. Place membership always outranks it.
const GENERIC = new Set(`
  function cloud service server client api config configuration setting settings setup build deploy
  deployment test testing error bug fix file folder directory data database user account auth login
  logout session token key page route router model view component module package version release
  update upgrade install script run job task event log logging debug feature app application web
  mobile ios android frontend backend endpoint request response status code repo repository branch
  commit merge pull push issue ticket doc document documentation readme spec plan design flow pipeline
  process handler hook callback async sync cache storage bucket queue worker cron schedule region
  project default new old type value string number list item field form button screen widget state
  method class object property option flag mode path url link text message notification
`.trim().split(/\s+/).map(stem));

/**
 * Weight of one overlapping term: a Place token 2 (the author's own topic
 * label), generic software vocabulary 0.5, a term rare across the store's
 * pointer tables 2, anything else 1.
 */
function termWeight(term, placeTerms, freq) {
  if (placeTerms.has(term)) return 2;
  if (GENERIC.has(term)) return 0.5;
  if (!freq || freq.rows === 0) return 1;
  const seen = freq.df.get(term) ?? 0;
  return seen <= Math.max(2, Math.round(freq.rows * 0.02)) ? 2 : 1;
}

/**
 * Task-aware match (§15.1, v2.11): score each candidate against the prompt by
 * deterministic lexical overlap — stemmed ASCII terms of the title and Place
 * minus stopwords and the project's own identifiers, CJK bigrams of the
 * title (2 each), and an explicit `#N` ref (+10, the user pointed at it).
 * Term overlaps are weighted by `termWeight` (Place 2, generic vocabulary
 * 0.5, store-rare 2, else 1; `freq` from `termFrequencies`), and a record
 * expands only at MATCH_THRESHOLD or above: sharing generic software words
 * with the prompt is not evidence, a Place token or a distinctive word is.
 * Returns the matches, best first, at most `limit`, skipping `exclude`.
 */
export function matchPrompt(prompt, candidates, { limit = DEFAULT_LIMIT, exclude = new Set(), ignore = new Set(), titleOf = (c) => c.summary, freq = null } = {}) {
  const text = String(prompt || "");
  const promptTerms = termsOf(text, ignore);
  const scored = [];
  for (const c of candidates) {
    if (exclude.has(c.issue)) continue;
    const title = String(titleOf(c) || c.summary || "").replace(/\[[^\]]*\]/g, " ");
    const placeTerms = termsOf(c.place || "", ignore);
    const hits = [];
    let score = 0;
    for (const term of new Set([...termsOf(title, ignore), ...placeTerms])) {
      if (!promptTerms.has(term)) continue;
      hits.push(term);
      score += termWeight(term, placeTerms, freq);
    }
    for (const gram of cjkBigrams(title)) {
      if (!text.includes(gram)) continue;
      hits.push(gram);
      score += 2;
    }
    if (new RegExp(`(?:^|[^\\w#])#${c.issue}(?!\\d)`).test(text)) {
      score += 10;
      hits.unshift(`#${c.issue}`);
    }
    if (score >= MATCH_THRESHOLD) scored.push({ ...c, score, hits });
  }
  scored.sort((a, b) => b.score - a.score || typeRank(a) - typeRank(b) || b.weight - a.weight || b.issue - a.issue);
  return { terms: [...promptTerms], matched: scored.slice(0, limit) };
}

/** The named `## <name>` section of a body, or "" when absent. */
function sectionOf(text, name) {
  const m = text.match(new RegExp(`(?:^|\\n)##\\s+${name}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`));
  return m ? m[1] : "";
}

// A line that starts a list, table, heading, quote or code fence: where the
// opening prose of a Message ends.
const STRUCTURE_LINE = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\||```|>)/;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;

/**
 * Summary tier of a body (§15.1 RECALL, v2.11). The `## Now` section when the
 * author wrote one (its lines joined, list markers dropped); otherwise the
 * opening prose of `## Message` — or of the body minus Metadata when there is
 * no Message section — up to the first list, table, heading, quote or code
 * fence, joined into one line. Capped at `cap` characters on a word boundary.
 * Returns "" when the body has no prose to summarise (a Message that opens
 * with a list), so the caller can say so instead of injecting the list.
 */
export function excerptOf(body, cap = SUMMARY_CAP) {
  const text = String(body || "").replace(/\r/g, "");
  const now = sectionOf(text, "Now").trim();
  const parts = [];
  if (now) {
    for (const raw of now.split("\n")) {
      const line = raw.trim().replace(LIST_MARKER, "");
      if (line) parts.push(line);
    }
  } else {
    const source = sectionOf(text, "Message") || text.replace(/(?:^|\n)##\s+Metadata[^\n]*\n[\s\S]*?(?=\n##\s|$)/, "");
    let length = 0;
    for (const raw of source.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (STRUCTURE_LINE.test(line)) {
        if (parts.length > 0) break;
        if (/^#{1,6}\s/.test(line)) continue; // a heading before any prose is skipped, not injected
        break;
      }
      parts.push(line);
      length += line.length + 1;
      if (length > cap) break;
    }
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length <= cap) return joined;
  const cut = joined.slice(0, cap);
  return (/\s/.test(cut) ? cut.replace(/\s+\S*$/, "") : cut).trimEnd() + " …";
}

/** Fetch one issue via gh. Returns { number, title, state, body } or null. */
export function fetchIssue(slug, number, timeout = 8000) {
  try {
    const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", slug, "--json", "number,title,state,body"], {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(raw);
  } catch (error) {
    debugLog(`fetchIssue #${number} --repo ${slug} failed: ${error?.code ?? ""} ${error?.signal ?? ""} ${String(error?.message ?? error).slice(0, 160)} stderr=${String(error?.stderr ?? "").slice(0, 200)}`);
    return null;
  }
}

/** Diagnostics for adapter debugging: one line appended to $RXAI_AMP_DEBUG when set; never throws. */
export function debugLog(line) {
  const file = process.env.RXAI_AMP_DEBUG;
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  } catch {
    /* diagnostics are best-effort */
  }
}

/**
 * The clone's `.rxai-cache/issues/<n>.json` entry when it is fresh (Rule 13:
 * cache reads are fine for recall, never for a write decision), else null.
 * Returns the same shape as `fetchIssue`.
 */
export function issueFromCache(repoPath, number, maxAgeMs = CACHE_MAX_AGE_MS) {
  try {
    const raw = JSON.parse(readFileSync(path.join(repoPath, ".rxai-cache", "issues", `${number}.json`), "utf8"));
    const cachedAt = Date.parse(raw.cached_at ?? "");
    if (!Number.isFinite(cachedAt) || Date.now() - cachedAt > maxAgeMs) return null;
    const issue = raw.issue;
    if (!issue || Number(issue.number) !== Number(number)) return null;
    return { number: issue.number, title: issue.title, state: issue.state, body: issue.body };
  } catch {
    return null;
  }
}

/** Cache first (fresh within a day, no network), then gh. Recall reads only. */
export function readIssue(repoPath, slug, number) {
  return (repoPath && issueFromCache(repoPath, number)) || (slug ? fetchIssue(slug, number) : null);
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

function headOf(c, title, extra = "") {
  const flags = `${c.type} · ${c.place}${c.placeMatch ? " · matches branch" : ""} · w:${c.weight.toFixed(2)}${c.source === "unindexed" ? " · unindexed" : ""}${extra}`;
  return `#${c.issue} [${flags}] ${title}`;
}

function viewCommand(issue, repoSlug) {
  return "gh issue view " + issue + (repoSlug ? ` --repo ${repoSlug}` : "");
}

/**
 * Build the session-start block. Returns { text, surfaced, regions } where
 * surfaced lists { issue, title } for ledger recording and regions names the
 * matched Regions. text is "" when nothing matched.
 *
 * `tier` (§15.1, v2.11): "summary" renders each record's summary tier under
 * its pointer line; "pointer" renders the pointer lines only — for a runtime
 * whose prompt-stage hook (`buildPromptRecall`) expands the matching ones
 * once the task is known. The pointer tier reads nothing from the network:
 * titles come from the pointer tables, or from the local cache when present.
 */
export function buildRepoRecall({ cwd, repoPath, repoSlug, limit = DEFAULT_LIMIT, tier = "summary", fetch }) {
  const out = { text: "", surfaced: [], regions: [] };
  try {
    if (!cwd || !repoPath) return out;
    const ids = projectIdentifiers(cwd);
    if (ids.names.length === 0) return out;
    const candidates = collectCandidates(repoPath, ids);
    if (candidates.length === 0) return out;
    out.regions = [...new Set(candidates.map((c) => c.region))];
    const pointerOnly = tier === "pointer";
    const get = fetch || ((slug, n) => readIssue(repoPath, slug, n));

    const lines = [];
    const label = ids.names[0] + (ids.branch ? ` @ ${ids.branch}` : "");
    lines.push(`--- Memories for this repo (${label}) — read before starting ---`);
    lines.push(`Matched region(s): ${out.regions.join(", ")} · ${candidates.length} open pointer(s), showing top ${Math.min(limit, candidates.length)}.`);

    let used = 0;
    let shown = 0;
    for (const c of candidates) {
      if (shown >= limit) break;
      const issue = pointerOnly ? issueFromCache(repoPath, c.issue) : get(repoSlug, c.issue);
      if (issue && String(issue.state).toUpperCase() !== "OPEN") continue;
      const title = issue?.title || c.summary || `issue #${c.issue}`;
      let chunk;
      if (pointerOnly) {
        chunk = headOf(c, title);
      } else {
        const excerpt = !issue
          ? `(body not fetched — run: ${viewCommand(c.issue, repoSlug)})`
          : excerptOf(issue.body) || `(no prose summary — the body opens with a list; add a ## Now section. Body: ${viewCommand(c.issue, repoSlug)})`;
        chunk = "\n" + headOf(c, title) + "\n" + excerpt.split("\n").map((l) => "  " + l).join("\n");
      }
      if (used + chunk.length > BLOCK_CAP) break;
      lines.push(chunk);
      used += chunk.length;
      shown += 1;
      out.surfaced.push({ issue: c.issue, title });
    }
    const rest = candidates.slice(shown).map((c) => `#${c.issue}`).join(", ");
    if (rest) lines.push(`${pointerOnly ? "" : "\n"}Also open for this repo, not expanded: ${rest}.`);
    if (pointerOnly) {
      lines.push(`Pointers only: the summaries of whichever records match your prompt arrive with it (task-aware recall, §15.1); a body is one \`${viewCommand("<n>", repoSlug)}\` away (Rule 6).`);
    } else {
      lines.push("Entries show the summary tier only (## Now, else the opening prose of ## Message); fetch a body before acting on its details (Rule 6).");
    }
    lines.push("Read the intent first, then facts/patterns; before trusting a facts entry check for a newer invalidation in the same Place (Rule 8).");
    out.text = lines.join("\n");
  } catch {
    /* fail-soft: navigation layer is still injected by the caller */
  }
  return out;
}

/**
 * Build the prompt-stage block (§15.1 task-aware recall, v2.11): the
 * repo-matched open records whose title/Place overlap `prompt`, expanded to
 * the summary tier, plus any record the prompt names by `#N` whatever its
 * Region. `exclude` lists issues already at summary tier (or fetched by the
 * agent) this session. Returns { text, surfaced, terms }; text is "" when
 * nothing matched — a prompt no memory covers injects nothing.
 */
export function buildPromptRecall({ cwd, repoPath, repoSlug, prompt, limit = DEFAULT_LIMIT, exclude = new Set(), fetch }) {
  const out = { text: "", surfaced: [], terms: [] };
  try {
    if (!cwd || !repoPath || !String(prompt || "").trim()) return out;
    const ids = projectIdentifiers(cwd);
    const rows = collectRows(repoPath);
    const candidates = ids.names.length > 0 ? collectCandidates(repoPath, ids) : [];
    const seen = new Set(candidates.map((c) => c.issue));
    const refs = new Set([...String(prompt).matchAll(/(?:^|[^\w#])#(\d+)(?!\d)/g)].map((m) => Number(m[1])));
    const named = [...rows.values()].filter((r) => refs.has(r.issue) && !seen.has(r.issue)).map((r) => ({ ...r, placeMatch: false }));
    const pool = [...candidates, ...named];
    if (pool.length === 0) return out;
    // The project's own names and the matched Regions are implied by being
    // here; an overlap on them would match every record.
    const ignore = new Set();
    for (const name of [...ids.names, ...new Set(pool.map((c) => c.region))]) for (const t of tokens(name)) { ignore.add(t); ignore.add(stem(t)); }
    const titleOf = (c) => issueFromCache(repoPath, c.issue)?.title || c.summary;
    const freq = termFrequencies(rows.values());
    const { matched, terms } = matchPrompt(prompt, pool, { limit, exclude, ignore, titleOf, freq });
    out.terms = terms;
    if (matched.length === 0) return out;
    const get = fetch || ((slug, n) => readIssue(repoPath, slug, n));

    const lines = [];
    lines.push("=== RxAi AMP shared memory — task-aware RECALL (§15.1 summary tier) ===");
    let used = 0;
    let shown = 0;
    for (const c of matched) {
      const issue = get(repoSlug, c.issue);
      if (issue && String(issue.state).toUpperCase() !== "OPEN") continue;
      const title = issue?.title || titleOf(c) || `issue #${c.issue}`;
      const excerpt = !issue
        ? `(body not fetched — run: ${viewCommand(c.issue, repoSlug)})`
        : excerptOf(issue.body) || `(no prose summary — the body opens with a list; add a ## Now section. Body: ${viewCommand(c.issue, repoSlug)})`;
      const chunk = "\n" + headOf(c, title, ` · matched: ${c.hits.join(", ")}`) + "\n" + excerpt.split("\n").map((l) => "  " + l).join("\n");
      if (used + chunk.length > BLOCK_CAP) break;
      lines.push(chunk);
      used += chunk.length;
      shown += 1;
      out.surfaced.push({ issue: c.issue, title });
    }
    if (shown === 0) return out;
    lines.splice(1, 0, `${shown} of ${pool.length} open record(s) for ${ids.names[0] || "this repo"} match this prompt:`);
    lines.push("", `Summary tier only — fetch a body before acting on its details (Rule 6): ${viewCommand("<n>", repoSlug)}. A memory you rely on gets an \`- **Outcome:**\` comment (§15.1); the rest owe nothing.`);
    lines.push("=== end AMP memory ===");
    out.text = lines.join("\n");
  } catch {
    /* fail-soft: nothing injected */
  }
  return out;
}
