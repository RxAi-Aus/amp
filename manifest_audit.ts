#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * manifest_audit.ts — the deterministic half of the Librarian backstop
 * (PROTOCOL.md §15.6; follow-up F of the 2026-09-23 A/B runs).
 *
 * A Rule 10 session summary carries a `## Recall` manifest whose `Surfaced:`
 * lines say what the session relied on: `#47 (used -> success), #52 (unused)`.
 * The compiler (compile_index.ts) turns those refs into weights (§4.4b/c) and
 * ignores anything it cannot parse — right for the weights, wrong for the
 * audit: on 2026-09-06 a model with no memory to cite wrote
 * `Recall used: #acme-speckit-state`, an issue that does not exist, and
 * nothing reported it. This script does. It runs before the Copilot call in
 * amp-librarian.yml, needs no LLM, and never writes to GitHub.
 *
 * For every summary created in the window (an issue whose body has a
 * `## Recall` section with a `Surfaced:` line) it checks each ref:
 *
 *   non_numeric_ref  `#word` that is not `#N` — a source that cannot exist
 *   unknown_issue    `#N` with no such issue in the repository (404, or a PR)
 *   unbacked_claim   `#N (used -> success|failure)` while #N has no
 *                    `- **Outcome:**` comment inside the session window:
 *                    48 h before the summary was created to 24 h after
 *                    (the §15.6 cross-check, made mechanical)
 *
 * Output: a JSON report (--out <file>, else stdout) and a Markdown rendering
 * (--md <file>) for result.md. Report-only: exit 0 whatever it finds; a
 * non-zero exit means the audit itself could not run.
 *
 * Flags:
 *   --since <ISO>   audit summaries created at or after this instant
 *                   (default: 7 days before now)
 *   --out <file>    write the JSON report here instead of stdout
 *   --md <file>     also write the Markdown rendering here
 *
 * Required environment variables (as compile_index.ts):
 *   GH_TOKEN     - GitHub Actions token (repo-scoped, read is enough)
 *   REPO_OWNER   - github.repository_owner
 *   REPO_NAME    - github.event.repository.name
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type GitHubIssue = {
  number?: number;
  created_at?: string;
  body?: string | null;
  pull_request?: unknown;
};

type GitHubComment = {
  body?: string;
  created_at?: string;
};

type Marker = "success" | "failure" | "neutral" | "used" | "unused";

type SurfacedRef = {
  raw: string;
  issue: number | null;
  marker: Marker | null;
};

type Summary = {
  number: number;
  created_at: string;
  body: string;
};

type FindingType = "non_numeric_ref" | "unknown_issue" | "unbacked_claim";

type Finding = {
  type: FindingType;
  summary: number;
  ref: string;
  claim?: "success" | "failure";
  detail: string;
};

type Report = {
  generated_at: string;
  since: string;
  summaries_checked: number;
  refs_checked: number;
  findings: Finding[];
};

type Lookup = {
  issueExists(issue: number): Promise<boolean>;
  outcomeComments(issue: number, fromIso: string, toIso: string): Promise<number>;
};

const WINDOW_BEFORE_MS = 48 * 60 * 60 * 1000;
const WINDOW_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// The §15.2 grammar, kept local as every script keeps its regexes;
// test/manifest.test.mjs asserts this parser and compile_index.ts agree on
// the numeric refs. The section runs to the next heading or the end of the
// body — `(?![\s\S])`, since JavaScript has no `\Z`.
const RECALL_SECTION_RE = /^\s*#{1,6}\s*Recall\b[^\n]*\n([\s\S]*?)(?=^\s*#{1,6}\s|(?![\s\S]))/im;
const SURFACED_LINE_RE = /^\s*-?\s*(?:\*\*)?Surfaced:(?:\*\*)?\s*(.+)$/i;
// A ref is `#` + word at a token boundary (so not the fragment of a URL),
// with an optional `( … )` marker right after it.
const REF_RE = /(?<![\w/])#([\w-]+)(?:\s*\(\s*([^()]*?)\s*\))?/g;
const USED_MARKER_RE = /^used\s*(?:->|→|=>)\s*(success|failure|neutral)$/i;
// The Outcome comment form of §4.4, as compile_index.ts reads it.
const OUTCOME_RE = /^\s*-?\s*\*\*Outcome:\*\*\s*(success|failure|neutral)\s*$/im;

const FINDING_LABEL: Record<FindingType, string> = {
  non_numeric_ref: "non-numeric ref",
  unknown_issue: "unknown issue",
  unbacked_claim: "unbacked used-claim",
};

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The `Surfaced:` lines of the `## Recall` section, and nothing outside it. */
function recallSurfacedLines(body: string | null | undefined): string[] {
  if (!body) {
    return [];
  }
  const section = body.match(RECALL_SECTION_RE);
  if (!section) {
    return [];
  }
  const lines: string[] = [];
  for (const line of section[1].split(/\r?\n/)) {
    const match = line.match(SURFACED_LINE_RE);
    if (match) {
      lines.push(match[1]);
    }
  }
  return lines;
}

function hasRecallManifest(body: string | null | undefined): boolean {
  return recallSurfacedLines(body).length > 0;
}

function classifyMarker(text: string | undefined): Marker | null {
  if (!text) {
    return null;
  }
  const marker = text.trim();
  if (/^unused$/i.test(marker)) {
    return "unused";
  }
  if (/^used$/i.test(marker)) {
    return "used";
  }
  const used = marker.match(USED_MARKER_RE);
  return used ? (used[1].toLowerCase() as Marker) : null;
}

/**
 * Every ref on the manifest's `Surfaced:` lines, valid or not — the compiler
 * keeps only `#N`; the audit needs to see what it dropped.
 */
function parseSurfacedRefs(body: string | null | undefined): SurfacedRef[] {
  const refs: SurfacedRef[] = [];
  for (const line of recallSurfacedLines(body)) {
    for (const match of line.matchAll(REF_RE)) {
      const token = match[1];
      refs.push({
        raw: `#${token}`,
        issue: /^\d+$/.test(token) ? Number(token) : null,
        marker: classifyMarker(match[2]),
      });
    }
  }
  return refs;
}

/**
 * The session a summary closes: Outcome comments are posted during the work
 * (before the summary) or at the checkpoint just after it.
 */
function sessionWindow(createdAtIso: string): { from: string; to: string } {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) {
    throw new Error(`invalid summary created_at: ${createdAtIso}`);
  }
  return { from: isoSeconds(created - WINDOW_BEFORE_MS), to: isoSeconds(created + WINDOW_AFTER_MS) };
}

async function auditManifests(
  summaries: Summary[],
  lookup: Lookup,
  meta: { since: string; now?: Date },
): Promise<Report> {
  const findings: Finding[] = [];
  let refsChecked = 0;
  const ordered = [...summaries].sort((a, b) => a.number - b.number);

  for (const summary of ordered) {
    const refs = parseSurfacedRefs(summary.body);
    refsChecked += refs.length;
    for (const ref of refs) {
      if (ref.issue === null) {
        findings.push({
          type: "non_numeric_ref",
          summary: summary.number,
          ref: ref.raw,
          detail: "not an issue number — a §15.2 ref is `#N`; this source cannot exist",
        });
        continue;
      }
      if (!(await lookup.issueExists(ref.issue))) {
        findings.push({
          type: "unknown_issue",
          summary: summary.number,
          ref: ref.raw,
          detail: `no issue ${ref.raw} in this repository`,
        });
        continue;
      }
      if (ref.marker === "success" || ref.marker === "failure") {
        const { from, to } = sessionWindow(summary.created_at);
        if ((await lookup.outcomeComments(ref.issue, from, to)) === 0) {
          findings.push({
            type: "unbacked_claim",
            summary: summary.number,
            ref: ref.raw,
            claim: ref.marker,
            detail: `manifest claims (used → ${ref.marker}) but ${ref.raw} has no Outcome comment between ${from} and ${to}`,
          });
        }
      }
    }
  }

  return {
    generated_at: isoSeconds((meta.now ?? new Date()).getTime()),
    since: meta.since,
    summaries_checked: ordered.length,
    refs_checked: refsChecked,
    findings,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function renderMarkdown(report: Report): string {
  const lines = [
    "## Recall manifest audit (deterministic, §15.6)",
    "",
    `Since ${report.since}: ${plural(report.summaries_checked, "summary", "summaries")} with a \`## Recall\` manifest, ${plural(report.refs_checked, "ref", "refs")} checked, ${plural(report.findings.length, "finding", "findings")}.`,
    "",
  ];
  if (report.findings.length === 0) {
    lines.push(
      report.summaries_checked === 0
        ? "No Rule 10 summary carried a manifest in this window."
        : "No findings: every ref names an existing issue and every `(used → success|failure)` claim has an Outcome comment in its session window.",
    );
    return lines.join("\n") + "\n";
  }
  lines.push("| Summary | Ref | Finding | Detail |", "|---|---|---|---|");
  for (const finding of report.findings) {
    lines.push(`| #${finding.summary} | \`${finding.ref}\` | ${FINDING_LABEL[finding.type]} | ${finding.detail} |`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- GitHub

async function githubGet(url: URL, headers: Record<string, string>): Promise<Response> {
  const response = await fetch(url, { headers });
  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  }
  return response;
}

/** Rule 10 summaries (any issue with a manifest) created at or after `sinceIso`. */
async function fetchSummaries(
  owner: string,
  repo: string,
  headers: Record<string, string>,
  sinceIso: string,
): Promise<Summary[]> {
  const summaries: Summary[] = [];
  const sinceMs = Date.parse(sinceIso);
  let page = 1;

  while (true) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
    url.searchParams.set("state", "all");
    url.searchParams.set("since", sinceIso); // filters on updated_at; created_at is checked below
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const batch = (await (await githubGet(url, headers)).json()) as GitHubIssue[];
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    for (const issue of batch) {
      if (issue.pull_request !== undefined || typeof issue.number !== "number" || !issue.created_at) {
        continue;
      }
      if (Date.parse(issue.created_at) < sinceMs || !hasRecallManifest(issue.body)) {
        continue;
      }
      summaries.push({ number: issue.number, created_at: issue.created_at, body: issue.body ?? "" });
    }
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }

  return summaries;
}

function githubLookup(owner: string, repo: string, headers: Record<string, string>): Lookup {
  const known = new Map<number, Promise<boolean>>();
  return {
    issueExists(issue) {
      let pending = known.get(issue);
      if (!pending) {
        pending = (async () => {
          const response = await githubGet(new URL(`https://api.github.com/repos/${owner}/${repo}/issues/${issue}`), headers);
          if (response.status === 404) {
            return false;
          }
          const data = (await response.json()) as GitHubIssue;
          return data.pull_request === undefined;
        })();
        known.set(issue, pending);
      }
      return pending;
    },
    async outcomeComments(issue, fromIso, toIso) {
      const toMs = Date.parse(toIso);
      let count = 0;
      let page = 1;
      while (true) {
        const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues/${issue}/comments`);
        url.searchParams.set("since", fromIso);
        url.searchParams.set("per_page", "100");
        url.searchParams.set("page", String(page));
        const response = await githubGet(url, headers);
        if (response.status === 404) {
          return count;
        }
        const batch = (await response.json()) as GitHubComment[];
        if (!Array.isArray(batch) || batch.length === 0) {
          break;
        }
        for (const comment of batch) {
          const at = Date.parse(comment.created_at ?? "");
          if (Number.isFinite(at) && at <= toMs && OUTCOME_RE.test(comment.body ?? "")) {
            count += 1;
          }
        }
        if (batch.length < 100) {
          break;
        }
        page += 1;
      }
      return count;
    },
  };
}

// ---------------------------------------------------------------- CLI

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > -1 ? process.argv[index + 1] : undefined;
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const owner = getEnv("REPO_OWNER");
  const repo = getEnv("REPO_NAME");
  const token = getEnv("GH_TOKEN");
  const now = new Date();

  const sinceFlag = flag("--since");
  const sinceMs = sinceFlag ? Date.parse(sinceFlag) : now.getTime() - DEFAULT_WINDOW_MS;
  if (!Number.isFinite(sinceMs)) {
    throw new Error(`--since is not an ISO 8601 instant: ${sinceFlag}`);
  }
  const since = isoSeconds(sinceMs);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "rxai-amp-manifest-audit",
  };

  const summaries = await fetchSummaries(owner, repo, headers, since);
  const report = await auditManifests(summaries, githubLookup(owner, repo, headers), { since, now });
  const json = JSON.stringify(report, null, 2) + "\n";

  const out = flag("--out");
  const md = flag("--md");
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, json);
  }
  if (md) {
    mkdirSync(path.dirname(md), { recursive: true });
    writeFileSync(md, renderMarkdown(report));
  }
  if (out) {
    console.log(
      `manifest audit: ${report.summaries_checked} summaries, ${report.refs_checked} refs, ${report.findings.length} findings → ${out}`,
    );
  } else {
    process.stdout.write(json);
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

// Exported for the test suite (test/) — the CLI behavior above is unchanged.
export {
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  auditManifests,
  hasRecallManifest,
  parseSurfacedRefs,
  recallSurfacedLines,
  renderMarkdown,
  sessionWindow,
};
