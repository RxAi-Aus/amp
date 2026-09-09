#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * okf_export.ts - Protocol v2.9.1 (PROTOCOL.md §14)
 *
 * Projects the current state of GitHub issues into:
 *
 *   1. An Open Knowledge Format v0.1 bundle under okf/
 *      - one concept file per issue:  okf/<region>/<place>/issue-<n>.md
 *      - per-directory index.md files (progressive disclosure)
 *      - a newest-first okf/log.md export history
 *   2. artifacts/okf/rows.ndjson — one row per concept, ready for
 *      `bq load --replace` into <BQ_DATASET>.concepts (§14.3).
 *
 * Both outputs are derived and read-only. GitHub Issues remain the source
 * of truth (Rule 13); this exporter never writes to GitHub.
 *
 * Required environment variables:
 *   GH_TOKEN     - GitHub token (repo-scoped, read-only is enough)
 *   REPO_OWNER   - github.repository_owner
 *   REPO_NAME    - github.event.repository.name
 * Optional:
 *   OKF_DIR      - bundle root directory (default: okf)
 *   NDJSON_PATH  - rows output path (default: artifacts/okf/rows.ndjson)
 *   WEIGHTS_PATH - same override honoured by compile_index.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

type GitHubIssue = {
  title?: string;
  number?: number;
  body?: string | null;
  comments?: number;
  updated_at?: string;
  html_url?: string;
  pull_request?: unknown;
};

type GitHubComment = {
  body?: string;
  created_at?: string;
  user?: { login?: string };
};

type Concept = {
  conceptId: string;
  filePath: string;
  kind: string;
  title: string;
  description: string;
  resource: string;
  region: string;
  place: string;
  fromAgent: string;
  timestamp: string;
  weight: number;
  outcome: "success" | "failure" | "neutral";
  issueNumber: number;
  body: string;
  citations: string[];
};

const OKF_VERSION = "0.1";
const VALID_KINDS = new Set([
  "intent",
  "facts",
  "events",
  "discovery",
  "pattern",
  "invalidation",
  "lifefact",
]);

const WEIGHT_PATHS = [".github/scripts/weights.json", "weights.json"];
const OUTCOME_RE = /^\s*-?\s*\*\*Outcome:\*\*\s*(success|failure|neutral)\s*$/im;
const URL_RE = /https?:\/\/[^\s)\]>"'`]+/g;

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

function getTag(title: string, tag: string): string | undefined {
  const match = title.match(new RegExp(`\\[${tag}:([^\\]]+)\\]`));
  return match?.[1]?.trim();
}

/** `[FROM:sender→recipient]` → sender (also tolerates plain `[FROM:agent]`). */
function fromSender(title: string): string {
  const raw = getTag(title, "FROM") ?? "";
  return raw.split(/→|->/)[0]?.trim() || "unknown";
}

/** Path-safe segment for region/place directories. */
function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "General";
}

/** YAML double-quoted scalar (JSON string escaping is valid YAML). */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function parseOutcome(body: string | undefined): "success" | "failure" | "neutral" | undefined {
  const match = body?.match(OUTCOME_RE);
  return match ? (match[1].toLowerCase() as "success" | "failure" | "neutral") : undefined;
}

/** First non-empty line under `## Summary`, else `**Summary:** ...`, else title. */
function extractDescription(issueBody: string, fallback: string): string {
  const section = issueBody.match(/^##\s+Summary\s*\n+([^\n#].*)$/im);
  if (section?.[1]) {
    return section[1].trim().slice(0, 200);
  }
  const inline = issueBody.match(/^\s*-?\s*\*\*Summary:\*\*\s*(.+)$/im);
  if (inline?.[1]) {
    return inline[1].trim().slice(0, 200);
  }
  return fallback;
}

function extractCitations(texts: string[], owner: string, repo: string): string[] {
  const internal = `github.com/${owner}/${repo}/issues`;
  const seen = new Set<string>();
  for (const text of texts) {
    for (const raw of text.match(URL_RE) ?? []) {
      const url = raw.replace(/[.,;:!?]+$/, "");
      if (!url.includes(internal)) {
        seen.add(url);
      }
    }
  }
  return [...seen].slice(0, 20);
}

async function githubGetJson<T>(url: URL, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} ${response.statusText}: ${body.slice(0, 300)}`,
    );
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

async function fetchAllComments(
  owner: string,
  repo: string,
  issueNumber: number,
  headers: Record<string, string>,
): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = [];
  let page = 1;

  while (true) {
    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    );
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const batch = await githubGetJson<GitHubComment[]>(url, headers);
    comments.push(...batch);
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }

  return comments;
}

function loadWeights(): Record<string, number> {
  const configured = process.env.WEIGHTS_PATH;
  const candidates = configured ? [configured] : WEIGHT_PATHS;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
      if (!isRecord(parsed)) {
        return {};
      }
      const weights: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (!key.startsWith("_") && typeof value === "number") {
          weights[key] = value;
        }
      }
      return weights;
    } catch (error) {
      console.warn(`[warn] Could not load ${candidate}: ${errorMessage(error)}`);
      return {};
    }
  }
  return {};
}

function conceptMarkdown(concept: Concept): string {
  const lines = [
    "---",
    `type: ${concept.kind}`,
    `title: ${yamlString(concept.title)}`,
    `description: ${yamlString(concept.description)}`,
    `resource: ${yamlString(concept.resource)}`,
    `tags: [${[concept.region, concept.place, concept.fromAgent]
      .map((tag) => yamlString(tag))
      .join(", ")}]`,
    `timestamp: ${concept.timestamp}`,
    `amp_issue: ${concept.issueNumber}`,
    `amp_region: ${yamlString(concept.region)}`,
    `amp_place: ${yamlString(concept.place)}`,
    `amp_from: ${yamlString(concept.fromAgent)}`,
    `amp_weight: ${concept.weight}`,
    `amp_outcome: ${concept.outcome}`,
    "---",
    "",
    concept.body.trim(),
  ];

  if (concept.citations.length > 0) {
    lines.push("", "# Citations", "");
    concept.citations.forEach((url, index) => {
      lines.push(`[${index + 1}] [${url}](${url})`);
    });
  }

  lines.push("");
  return lines.join("\n");
}

/** Prepend (or replace) today's entry in the newest-first log.md. */
function updateLog(logPath: string, dateStr: string, entry: string): void {
  const heading = `## ${dateStr}`;
  let existing = "";
  if (existsSync(logPath)) {
    existing = readFileSync(logPath, "utf8");
    const start = existing.indexOf(heading);
    if (start !== -1) {
      const next = existing.indexOf("\n## ", start + heading.length);
      existing = existing.slice(0, start) + (next !== -1 ? existing.slice(next + 1) : "");
    }
    existing = existing.replace(/^# Export Log\s*\n+/, "");
  }
  const block = `# Export Log\n\n${heading}\n\n${entry}\n\n${existing.trim()}\n`;
  writeFileSync(logPath, `${block.trimEnd()}\n`, "utf8");
}

async function main(): Promise<void> {
  const owner = getEnv("REPO_OWNER");
  const repo = getEnv("REPO_NAME");
  const token = getEnv("GH_TOKEN");
  const okfDir = process.env.OKF_DIR || "okf";
  const ndjsonPath = process.env.NDJSON_PATH || path.join("artifacts", "okf", "rows.ndjson");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const nowStr = isoNoMillis(new Date());
  const weights = loadWeights();
  const issues = await fetchAllIssues(owner, repo, headers);
  console.log(`[info] Fetched ${issues.length} issues`);

  const concepts: Concept[] = [];

  for (const [idx, issue] of issues.entries()) {
    if (issue.number === undefined) {
      continue;
    }

    const title = issue.title ?? "";
    const issueBody = issue.body ?? "";
    const n = issue.number;
    const cleanTitle = title.replace(/\[[^\]]+\]/g, "").trim() || `(issue #${n})`;

    const region = getTag(title, "REGION") || "Untagged";
    const place = getTag(title, "PLACE") || "General";
    const rawKind = (getTag(title, "TYPE") || "events").toLowerCase();
    const kind = VALID_KINDS.has(rawKind) ? rawKind : "events";

    let comments: GitHubComment[] = [];
    if ((issue.comments ?? 0) > 0) {
      try {
        comments = await fetchAllComments(owner, repo, n, headers);
      } catch (error) {
        console.warn(`[warn] Could not fetch comments for #${n}: ${errorMessage(error)}`);
      }
      if ((idx + 1) % 50 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    let outcome: "success" | "failure" | "neutral" = "neutral";
    for (const comment of comments) {
      const parsed = parseOutcome(comment.body);
      if (parsed) {
        outcome = parsed;
      }
    }

    const bodyParts = [issueBody.trim()];
    if (comments.length > 0) {
      bodyParts.push("\n## Comments\n");
      for (const comment of comments) {
        const author = comment.user?.login ?? "unknown";
        const when = comment.created_at ?? "";
        bodyParts.push(`### ${author} — ${when}\n\n${(comment.body ?? "").trim()}\n`);
      }
    }

    const regionSeg = safeSegment(region);
    const placeSeg = safeSegment(place);
    const conceptId = `${regionSeg}/${placeSeg}/issue-${n}`;

    concepts.push({
      conceptId,
      filePath: path.join(okfDir, regionSeg, placeSeg, `issue-${n}.md`),
      kind,
      title: cleanTitle,
      description: extractDescription(issueBody, cleanTitle.slice(0, 200)),
      resource: issue.html_url ?? `https://github.com/${owner}/${repo}/issues/${n}`,
      region,
      place,
      fromAgent: fromSender(title),
      timestamp: issue.updated_at ?? nowStr,
      weight: weights[String(n)] ?? 1.0,
      outcome,
      issueNumber: n,
      body: bodyParts.join("\n"),
      citations: extractCitations([issueBody, ...comments.map((c) => c.body ?? "")], owner, repo),
    });
  }

  // Rebuild the bundle from scratch — it is fully derived (log.md history kept).
  const previousLog = existsSync(path.join(okfDir, "log.md"))
    ? readFileSync(path.join(okfDir, "log.md"), "utf8")
    : "";
  rmSync(okfDir, { recursive: true, force: true });
  mkdirSync(okfDir, { recursive: true });
  if (previousLog) {
    writeFileSync(path.join(okfDir, "log.md"), previousLog, "utf8");
  }

  const byRegion = new Map<string, Concept[]>();
  for (const concept of concepts) {
    mkdirSync(path.dirname(concept.filePath), { recursive: true });
    writeFileSync(concept.filePath, conceptMarkdown(concept), "utf8");
    const regionSeg = concept.conceptId.split("/")[0];
    const bucket = byRegion.get(regionSeg) ?? [];
    bucket.push(concept);
    byRegion.set(regionSeg, bucket);
  }

  for (const [regionSeg, regionConcepts] of byRegion) {
    regionConcepts.sort((a, b) => b.weight - a.weight || a.issueNumber - b.issueNumber);
    const lines = [`# Region: ${regionConcepts[0]?.region ?? regionSeg}`, ""];
    for (const concept of regionConcepts) {
      lines.push(`* [${concept.title}](/${concept.conceptId}.md) - ${concept.description}`);
    }
    writeFileSync(path.join(okfDir, regionSeg, "index.md"), `${lines.join("\n")}\n`, "utf8");
  }

  const rootLines = [
    "---",
    `okf_version: "${OKF_VERSION}"`,
    "---",
    "",
    "# AMP Memory — OKF Bundle",
    "",
    `Derived from GitHub Issues at ${nowStr}. Read-only projection — see PROTOCOL.md §14.`,
    "",
    "# Regions",
    "",
  ];
  for (const regionSeg of [...byRegion.keys()].sort()) {
    const count = byRegion.get(regionSeg)?.length ?? 0;
    rootLines.push(`* [${regionSeg}](/${regionSeg}/index.md) - ${count} concepts`);
  }
  writeFileSync(path.join(okfDir, "index.md"), `${rootLines.join("\n")}\n`, "utf8");

  updateLog(
    path.join(okfDir, "log.md"),
    nowStr.slice(0, 10),
    `**Update** — exported ${concepts.length} concepts across ${byRegion.size} regions at ${nowStr}.`,
  );

  mkdirSync(path.dirname(ndjsonPath), { recursive: true });
  const rows = concepts.map((concept) =>
    JSON.stringify({
      concept_id: concept.conceptId,
      type: concept.kind,
      title: concept.title,
      description: concept.description,
      tags: [concept.region, concept.place, concept.fromAgent],
      region: concept.region,
      place: concept.place,
      from_agent: concept.fromAgent,
      timestamp: concept.timestamp,
      weight: concept.weight,
      outcome: concept.outcome,
      issue_number: concept.issueNumber,
      resource: concept.resource,
      body: concept.body,
    }),
  );
  writeFileSync(ndjsonPath, rows.length > 0 ? `${rows.join("\n")}\n` : "", "utf8");

  console.log(
    `[done] Exported ${concepts.length} concepts across ${byRegion.size} regions → ${okfDir}/ and ${ndjsonPath}`,
  );
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
