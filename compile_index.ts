#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * compile_index.ts - Protocol v2.9.1
 *
 * Rebuilds INDEX.md and per-Region files from the current state of GitHub
 * issues. Implements the outcome-aware confidence weight system:
 *
 *   success comment        -> weight += 0.30
 *   failure comment        -> weight -= 0.20
 *   neutral / no marker    -> no change
 *   type:lifefact issue    -> fixed weight 1.0, no decay, never archived
 *   type:invalidation with `Supersedes: #N` -> #N's weight floored to 0
 *                             (immediate archive; lifefact targets are immune)
 *
 * State hygiene: weights.json only keeps issues seen this compile, and
 * REGION-*.md files whose Region no longer exists are deleted.
 *
 * Required environment variables:
 *   GH_TOKEN     - GitHub Actions token (repo-scoped)
 *   REPO_OWNER   - github.repository_owner
 *   REPO_NAME    - github.event.repository.name
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type GitHubIssue = {
  title?: string;
  number?: number;
  comments?: number;
  updated_at?: string;
  body?: string | null;
  pull_request?: unknown;
};

type GitHubComment = {
  body?: string;
};

type LifefactEntry = {
  id?: string;
  subject_who?: string | null;
  event_what?: string | null;
  time_when?: string | null;
  source_issue?: number | string | null;
};

type IndexEntry = {
  number: string;
  summary: string;
  comments: number;
  weight: number;
  updated: string;
  lifefact?: {
    subject: string;
    event: string;
    when: string;
    source: string;
  };
};

type StructuredIndex = Record<string, Record<string, Record<string, IndexEntry[]>>>;
type ArchivedIndex = Record<string, Record<string, string[]>>;

const DECAY: Record<string, number> = {
  intent: 0.97,
  facts: 0.95,
  events: 0.85,
  discovery: 0.85,
  pattern: 0.98,
  invalidation: 0.95,
  lifefact: 1.0,
};

const REINFORCE_SUCCESS = 0.30;
const PENALTY_FAILURE = 0.20;
const ARCHIVE_THRESHOLD = 0.10;
/**
 * §4.4b — decay per recorded surfaced-but-unused recall. Time decay answers
 * "how old is this?"; this answers "was it offered to an agent that then did
 * not rely on it?", which is evidence about relevance rather than about age.
 * Applied multiplicatively alongside the per-type rate, so an ignored record
 * sinks faster than a merely idle one. A record no manifest mentions keeps
 * exactly its previous arithmetic.
 */
const UNUSED_DECAY = 0.95;
const LIFEFACT_TYPE = "lifefact";

const TYPE_ORDER = [
  "intent",
  "facts",
  "pattern",
  "invalidation",
  "discovery",
  "events",
  LIFEFACT_TYPE,
];

const WEIGHT_PATHS = [".github/scripts/weights.json", "weights.json"];
const OUTCOME_RE = /^\s*-?\s*\*\*Outcome:\*\*\s*(success|failure|neutral)\s*$/im;

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`FATAL: required env var ${name} is not set`);
  }
  return value;
}

function isoNoMillis(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Titles carried in the master index. The first tier exists so an agent can
 * decide what to skip; issue numbers and weights alone cannot support that
 * decision, so the title travels with the pointer. Bounded so the master
 * index stays small no matter how many Regions accumulate.
 */
const INDEX_TITLE_MAX = 72;

function indexTitle(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > INDEX_TITLE_MAX ? `${text.slice(0, INDEX_TITLE_MAX - 1)}\u2026` : text;
}

function tableCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\r/g, " ").replace(/\n/g, " ").trim().replace(/\|/g, "\\|");
}

function getTag(title: string, tag: string): string | undefined {
  const match = title.match(new RegExp(`\\[${tag}:([^\\]]+)\\]`));
  return match?.[1]?.trim();
}

/**
 * PROTOCOL.md §6 Metadata field on type:invalidation issues:
 * `- **Supersedes:** #N` (or a deliberate list `#N, #M`). Only the leading
 * comma-separated refs count — prose after them (`#12 — replaced by #45`)
 * must not archive the mentioned replacement.
 */
/**
 * §15.2 Recall manifest: `- **Surfaced:** #47 (used -> success), #52 (unused)`.
 * Returns the records this manifest recorded as surfaced but not relied upon.
 * Only refs carrying an explicit `(unused)` marker count; `(used -> ...)` and
 * bare refs do not, so a malformed manifest costs a record nothing.
 */
function parseRecallUnused(body: string | null | undefined): number[] {
  if (!body) {
    return [];
  }
  const section = body.match(/^\s*#{1,6}\s*Recall\b[^\n]*\n([\s\S]*?)(?=^\s*#{1,6}\s|\Z)/im);
  if (!section) {
    return [];
  }
  const unused: number[] = [];
  for (const line of section[1].split(/\r?\n/)) {
    const match = line.match(/^\s*-?\s*(?:\*\*)?Surfaced:(?:\*\*)?\s*(.+)$/i);
    if (!match) {
      continue;
    }
    for (const ref of match[1].matchAll(/#(\d+)\s*\(\s*unused\s*\)/gi)) {
      unused.push(Number(ref[1]));
    }
  }
  return unused;
}

function parseSupersededTargets(body: string | null | undefined): number[] {
  if (!body) {
    return [];
  }
  const targets: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*-?\s*(?:\*\*)?Supersedes:(?:\*\*)?\s*(.+)$/i);
    if (!match) {
      continue;
    }
    const refsPart = match[1].match(/^\s*(#\d+(?:\s*,\s*#\d+)*)/);
    if (!refsPart) {
      continue;
    }
    for (const ref of refsPart[1].matchAll(/#(\d+)/g)) {
      targets.push(Number(ref[1]));
    }
  }
  return targets;
}

function parseOutcome(commentBody: string | undefined): "success" | "failure" | "neutral" {
  if (!commentBody) {
    return "neutral";
  }
  const match = commentBody.match(OUTCOME_RE);
  if (!match) {
    return "neutral";
  }
  return match[1].toLowerCase() as "success" | "failure" | "neutral";
}

function computeCommentDelta(comments: GitHubComment[]): number {
  let delta = 0;
  for (const comment of comments) {
    const outcome = parseOutcome(comment.body);
    if (outcome === "success") {
      delta += REINFORCE_SUCCESS;
    } else if (outcome === "failure") {
      delta -= PENALTY_FAILURE;
    }
  }
  return delta;
}

/**
 * Pure §4.4 weight arithmetic for one issue: lifefacts pin at 1.0 (Rule 12),
 * a superseded issue floors to 0 (Rule 8), everything else decays by age and by
 * recorded unused recalls (§4.4b) then takes the outcome delta; the result is clamped to [0, 1] and rounded to 4 dp.
 */
function computeIssueWeight(
  kind: string,
  oldWeight: number,
  delta: number,
  superseded: boolean,
  unusedCount = 0,
): number {
  let weight: number;
  if (kind === LIFEFACT_TYPE) {
    weight = 1.0;
  } else if (superseded) {
    weight = 0;
  } else {
    const idle = DECAY[kind] ?? 0.85;
    const ignored = UNUSED_DECAY ** Math.max(0, unusedCount);
    weight = oldWeight * idle * ignored + delta;
  }
  return Math.round(Math.max(0, Math.min(1, weight)) * 10000) / 10000;
}

/**
 * Rule 8 retraction semantics: invalidations apply newest-first, and an
 * invalidation that is itself superseded is archived but stops enforcing.
 * Input maps invalidation issue number → its declared targets.
 */
function resolveInvalidations(
  invalidationTargets: Map<number, number[]>,
): { supersededBy: Map<number, number>; retracted: Set<number> } {
  const supersededBy = new Map<number, number>();
  const retracted = new Set<number>();
  for (const invNumber of [...invalidationTargets.keys()].sort((a, b) => b - a)) {
    if (retracted.has(invNumber)) {
      continue;
    }
    for (const target of invalidationTargets.get(invNumber) ?? []) {
      if (invalidationTargets.has(target)) {
        retracted.add(target);
      }
      supersededBy.set(target, invNumber);
    }
  }
  return { supersededBy, retracted };
}

// Server time of the first API response (= the issues-list page 1, which is
// fetched before anything else). Used to bound _last_compile_iso: any issue
// this compile can have missed was created after that moment on GitHub's
// clock, so stamping with min(runner clock, server clock) guarantees the
// tracker's created_at >= stamp reconciliation can never skip it.
let firstServerDateMs: number | undefined;

async function githubGetJson<T>(url: URL, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} ${response.statusText}: ${body.slice(0, 300)}`,
    );
  }
  if (firstServerDateMs === undefined) {
    const parsed = Date.parse(response.headers.get("date") ?? "");
    if (Number.isFinite(parsed)) {
      firstServerDateMs = parsed;
    }
  }
  return (await response.json()) as T;
}

async function fetchAllIssues(
  owner: string,
  repo: string,
  headers: Record<string, string>,
): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  let page = 1;

  while (true) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
    url.searchParams.set("state", "all");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const batch = await githubGetJson<GitHubIssue[]>(url, headers);
    if (batch.length === 0) {
      break;
    }

    issues.push(...batch.filter((issue) => issue.pull_request === undefined));

    if (batch.length < 100) {
      break;
    }
    page += 1;
  }

  return issues;
}

async function fetchNewComments(
  owner: string,
  repo: string,
  issueNumber: number,
  sinceIso: string,
  headers: Record<string, string>,
): Promise<GitHubComment[]> {
  const url = new URL(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
  );
  url.searchParams.set("since", sinceIso);
  url.searchParams.set("per_page", "100");
  return githubGetJson<GitHubComment[]>(url, headers);
}

function resolveWeightPath(): string {
  const configured = process.env.WEIGHTS_PATH;
  if (configured) {
    return configured;
  }

  for (const candidate of WEIGHT_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const workflowWeightDir = path.dirname(WEIGHT_PATHS[0]);
  return existsSync(workflowWeightDir) ? WEIGHT_PATHS[0] : WEIGHT_PATHS[1];
}

function loadJsonRecord(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") {
      console.warn(`[warn] Could not load ${filePath}: ${errorMessage(error)}`);
    }
    return {};
  }
}

function loadPermanentMemory(filePath = "permanent_memory.json"): Map<string, LifefactEntry> {
  if (!existsSync(filePath)) {
    return new Map();
  }

  const parsed = loadJsonRecord(filePath);
  const entries = parsed.entries;
  if (!Array.isArray(entries)) {
    console.warn(`[warn] Ignoring ${filePath}: entries must be a list`);
    return new Map();
  }

  const byIssue = new Map<string, LifefactEntry>();
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const lifefact = entry as LifefactEntry;
    if (lifefact.source_issue === null || lifefact.source_issue === undefined) {
      continue;
    }
    byIssue.set(String(lifefact.source_issue), lifefact);
  }
  return byIssue;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
}

function ensureBuckets(
  structured: StructuredIndex,
  archived: ArchivedIndex,
  region: string,
  place: string,
  kind: string,
): void {
  structured[region] ??= {};
  structured[region][place] ??= {};
  structured[region][place][kind] ??= [];
  archived[region] ??= {};
  archived[region][place] ??= [];
}

function orderedKinds(types: Record<string, IndexEntry[]>): string[] {
  const known = new Set(TYPE_ORDER);
  const extras = Object.keys(types).filter((kind) => !known.has(kind)).sort();
  return [...TYPE_ORDER, ...extras].filter((kind) => (types[kind]?.length ?? 0) > 0);
}

function entryNumber(entry: IndexEntry): number {
  const value = Number(entry.number);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

async function main(): Promise<void> {
  const owner = getEnv("REPO_OWNER");
  const repo = getEnv("REPO_NAME");
  const token = getEnv("GH_TOKEN");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const now = new Date();
  const nowStr = isoNoMillis(now);
  const weightPath = resolveWeightPath();
  const state = loadJsonRecord(weightPath);
  const permanentMemory = loadPermanentMemory();

  let lastCompileIso = typeof state._last_compile_iso === "string"
    ? state._last_compile_iso
    : undefined;

  if (!lastCompileIso) {
    lastCompileIso = isoNoMillis(new Date(now.getTime() - 6 * 60 * 60 * 1000));
    console.log(`[info] First compile detected. Using since=${lastCompileIso}`);
  }

  const priorWeights: Record<string, number> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith("_") && typeof value === "number") {
      priorWeights[key] = value;
    }
  }

  // Only issues seen this compile are written back — deleted issues'
  // weights would otherwise be carried forward indefinitely.
  const weights: Record<string, number> = {};

  const issues = await fetchAllIssues(owner, repo, headers);
  console.log(`[info] Fetched ${issues.length} issues`);

  // Rule 8 enforcement: a type:invalidation issue whose body declares
  // `Supersedes: #N` floors #N's weight to 0 so it archives immediately.
  // An invalidation that is itself superseded stops enforcing (so a wrong
  // invalidation can be retracted by superseding it); newest wins, so the
  // retraction always beats the invalidation it targets.
  const invalidationTargets = new Map<number, number[]>();
  for (const issue of issues) {
    if (issue.number === undefined) {
      continue;
    }
    const kind = (getTag(issue.title ?? "", "TYPE") || "events").toLowerCase();
    if (kind !== "invalidation") {
      continue;
    }
    invalidationTargets.set(
      issue.number,
      parseSupersededTargets(issue.body).filter((target) => target !== issue.number),
    );
  }

  const { supersededBy } = resolveInvalidations(invalidationTargets);

  // §4.4b — tally surfaced-but-unused recalls across every Rule 10 manifest.
  // Standing count, like outcome comments: it is re-derived from the store on
  // each compile rather than accumulated in weights.json, so the arithmetic
  // stays a pure function of issue state and a deleted manifest undoes itself.
  const unusedRecalls = new Map<string, number>();
  for (const issue of issues) {
    for (const target of parseRecallUnused(issue.body)) {
      if (target === issue.number) {
        continue;
      }
      const key = String(target);
      unusedRecalls.set(key, (unusedRecalls.get(key) ?? 0) + 1);
    }
  }

  const structured: StructuredIndex = {};
  const archived: ArchivedIndex = {};
  let skippedForNoOutcome = 0;

  for (const [idx, issue] of issues.entries()) {
    if (issue.number === undefined) {
      continue;
    }

    const title = issue.title ?? "";
    const n = String(issue.number);
    const commentsCount = typeof issue.comments === "number" ? issue.comments : 0;
    const updated = (issue.updated_at ?? "").slice(0, 10);
    const desc = title.replace(/\[[^\]]+\]/g, "").trim().slice(0, 70) || `(issue #${n})`;

    const region = getTag(title, "REGION") || "Untagged";
    const place = getTag(title, "PLACE") || "General";
    const kind = (getTag(title, "TYPE") || "events").toLowerCase();

    const supersededByIssue = supersededBy.get(issue.number);

    let delta = 0;
    if (kind === LIFEFACT_TYPE) {
      if (supersededByIssue !== undefined) {
        console.warn(
          `[warn] Invalidation #${supersededByIssue} targets lifefact #${n} — ignored (lifefacts are pinned)`,
        );
      }
    } else if (supersededByIssue !== undefined) {
      console.log(`[info] #${n} superseded by invalidation #${supersededByIssue} — archived`);
    } else if (commentsCount > 0) {
      try {
        const newComments = await fetchNewComments(
          owner,
          repo,
          issue.number,
          lastCompileIso,
          headers,
        );
        delta = computeCommentDelta(newComments);
        if (newComments.length > 0 && delta === 0) {
          skippedForNoOutcome += 1;
        }
      } catch (error) {
        console.warn(`[warn] Could not fetch comments for #${n}: ${errorMessage(error)}`);
      }

      if ((idx + 1) % 50 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const newWeight = computeIssueWeight(
      kind,
      priorWeights[n] ?? 1.0,
      delta,
      supersededByIssue !== undefined,
      unusedRecalls.get(n) ?? 0,
    );
    weights[n] = newWeight;

    ensureBuckets(structured, archived, region, place, kind);

    const lifefact = permanentMemory.get(n);
    const entry: IndexEntry = {
      number: n,
      summary: desc,
      comments: commentsCount,
      weight: newWeight,
      updated,
    };

    if (kind === LIFEFACT_TYPE) {
      entry.lifefact = {
        subject: lifefact?.subject_who ?? desc,
        event: lifefact?.event_what ?? "",
        when: lifefact?.time_when ?? "",
        source: lifefact?.id ?? "issue-only",
      };
    }

    if (kind === LIFEFACT_TYPE || newWeight >= ARCHIVE_THRESHOLD) {
      structured[region][place][kind].push(entry);
    } else if (supersededByIssue !== undefined) {
      archived[region][place].push(
        `#${n} (${desc.slice(0, 40)}) — superseded by #${supersededByIssue}`,
      );
    } else {
      archived[region][place].push(`#${n} (${desc.slice(0, 40)})`);
    }
  }

  console.log(
    `[info] Skipped ${skippedForNoOutcome} non-lifefact issues with comments lacking Outcome markers`,
  );

  for (const places of Object.values(structured)) {
    for (const types of Object.values(places)) {
      for (const entries of Object.values(types)) {
        entries.sort((a, b) => b.weight - a.weight || entryNumber(a) - entryNumber(b));
      }
    }
  }

  for (const [region, places] of Object.entries(structured).sort()) {
    const safeRegion = region.replace(/\s+/g, "-");
    const regionFile = `REGION-${safeRegion}.md`;
    const total = Object.values(places).reduce(
      (placeTotal, types) =>
        placeTotal + Object.values(types).reduce((typeTotal, entries) => typeTotal + entries.length, 0),
      0,
    );

    const lines = [
      `# Region: ${region} - Pointer Table\n\n`,
      `**Last Compiled:** ${nowStr}  \n`,
      `**Issues in Region:** ${total}  \n\n---\n`,
    ];

    for (const [place, types] of Object.entries(places).sort()) {
      lines.push(`\n## Place: ${place}\n`);

      for (const kind of orderedKinds(types)) {
        const entries = types[kind] ?? [];
        lines.push(`\n  ### Type: ${kind}\n`);

        if (kind === LIFEFACT_TYPE) {
          lines.push("  | Issue | Subject | Event | When | Source | Last Updated |\n");
          lines.push("  |-------|---------|-------|------|--------|-------------|\n");
          for (const entry of entries) {
            const lifefact = entry.lifefact;
            lines.push(
              `  | #${entry.number} | ${tableCell(lifefact?.subject)} | ${tableCell(
                lifefact?.event,
              )} | ${tableCell(lifefact?.when)} | ${tableCell(lifefact?.source)} | ${tableCell(
                entry.updated,
              )} |\n`,
            );
          }
        } else {
          lines.push("  | Issue | Summary | Comments | Weight | Last Updated |\n");
          lines.push("  |-------|---------|----------|--------|-------------|\n");
          for (const entry of entries) {
            lines.push(
              `  | #${entry.number} | ${tableCell(entry.summary)} | ${entry.comments} | ${entry.weight} | ${tableCell(
                entry.updated,
              )} |\n`,
            );
          }
        }
      }

      const archivedEntries = archived[region]?.[place] ?? [];
      lines.push("\n  ### Summary\n");
      lines.push("  > Summary not yet generated for this Place.\n");
      if (archivedEntries.length > 0) {
        lines.push(
          `  > **Archived (weight < ${ARCHIVE_THRESHOLD}):** ${archivedEntries.join(", ")}\n`,
        );
      }
    }

    writeFileSync(regionFile, lines.join(""), "utf8");
  }

  // Remove REGION files for Regions that no longer have any issues, so a
  // deleted Region does not leave a stale pointer table behind. Compare
  // case-insensitively: on a case-insensitive filesystem (macOS local runs)
  // writeFileSync lands in an existing differently-cased file, and an exact
  // comparison would delete the file just written.
  const generatedRegionFiles = new Set(
    Object.keys(structured).map((region) =>
      `REGION-${region.replace(/\s+/g, "-")}.md`.toLowerCase(),
    ),
  );
  for (const file of readdirSync(".")) {
    if (/^REGION-.*\.md$/i.test(file) && !generatedRegionFiles.has(file.toLowerCase())) {
      rmSync(file);
      console.log(`[info] Removed stale ${file} (Region no longer exists)`);
    }
  }

  const indexLines = [
    "# Agent Memory Index\n\n",
    `**Last Compiled:** ${nowStr}  \n`,
    "**Compiled By:** index-scheduler workflow  \n",
    `**Total Issues Indexed:** ${issues.length}  \n`,
    "**Next Scheduled Compile:** approximately 6 hours from above timestamp  \n\n---\n",
  ];

  for (const region of Object.keys(structured).sort()) {
    const safeRegion = region.replace(/\s+/g, "-");
    const regionFile = `REGION-${safeRegion}.md`;
    const allEntries = Object.values(structured[region]).flatMap((types) =>
      Object.values(types).flat(),
    );
    allEntries.sort((a, b) => b.weight - a.weight || entryNumber(a) - entryNumber(b));
    const top3 = allEntries
      .slice(0, 3)
      .map((entry) => `#${entry.number} ${indexTitle(entry.summary)} (w:${entry.weight})`);
    const archivedCount = Object.values(archived[region] ?? {}).reduce(
      (total, entries) => total + entries.length,
      0,
    );

    indexLines.push(`\n## Region: ${region}\n`);
    indexLines.push("  > **Summary:** Summary not yet generated for this Region.  \n");
    indexLines.push(`  > Active threads: ${top3.length > 0 ? top3.join(", ") : "none"}.  \n`);
    if (archivedCount > 0) {
      indexLines.push(
        `  > Archived: ${archivedCount} issues. See ${regionFile} for full table.  \n`,
      );
    } else {
      indexLines.push(`  > See ${regionFile} for full pointer table.  \n`);
    }
  }

  writeFileSync("INDEX.md", indexLines.join(""), "utf8");

  const nextState: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith("_") && key !== "_last_compile_iso") {
      nextState[key] = value;
    }
  }
  Object.assign(nextState, weights);
  // Earlier of runner clock and GitHub server clock — see firstServerDateMs.
  const compileStamp = isoNoMillis(
    new Date(Math.min(now.getTime(), firstServerDateMs ?? now.getTime())),
  );
  nextState._last_compile_iso = compileStamp;

  ensureParentDir(weightPath);
  writeFileSync(weightPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");

  writeFileSync(
    "not_indexed.md",
    `# Not Yet Indexed

**Since Last Index Compile:** ${compileStamp}
**Last Updated:** ${nowStr}
**Unindexed Issue Count:** 0

| Issue | From | Region | Place | Type | Posted |
|-------|------|------|------|------|--------|
`,
    "utf8",
  );

  console.log(`[done] Compiled ${issues.length} issues across ${Object.keys(structured).length} Regions at ${nowStr}`);
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}

// Exported for the test suite (test/) — the CLI behavior above is unchanged.
export {
  ARCHIVE_THRESHOLD,
  DECAY,
  computeCommentDelta,
  computeIssueWeight,
  parseRecallUnused,
  UNUSED_DECAY,
  getTag,
  parseOutcome,
  parseSupersededTargets,
  resolveInvalidations,
};
