#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * track_not_indexed.ts - Protocol v2.9.1
 *
 * Rebuilds not_indexed.md — the register of issues opened since the last
 * index compile. Each run reconciles against the GitHub API instead of
 * appending only its own trigger event, so a cancelled queued run or a
 * failed push can never permanently lose an issue: the next run (or the
 * next 6-hour compile) repairs it.
 *
 * Reconcile mode (used by the workflow) requires:
 *   GH_TOKEN, REPO_OWNER, REPO_NAME
 * and optionally merges the triggering event's issue, in case the list API
 * lags a just-created issue:
 *   ISSUE_TITLE, ISSUE_NUMBER, ISSUE_CREATED
 *
 * Legacy fallback (offline / no token): when GH_TOKEN, REPO_OWNER, or
 * REPO_NAME is absent but the ISSUE_* variables are present, appends the
 * single issue to the existing file like Protocol v2.4 did.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type GitHubIssue = {
  title?: string;
  number?: number;
  created_at?: string;
  pull_request?: unknown;
};

type Row = {
  number: number;
  sender: string;
  region: string;
  place: string;
  kind: string;
  created: string;
};

const WEIGHT_PATHS = [".github/scripts/weights.json", "weights.json"];

function isoNoMillis(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function getTag(title: string, tag: string): string | undefined {
  const match = title.match(new RegExp(`\\[${tag}:([^\\]]+)\\]`));
  return match?.[1]?.trim();
}

/** `[FROM:sender→recipient]` → sender (also tolerates plain `[FROM:agent]` and `->`). */
function getSender(title: string): string {
  const raw = getTag(title, "FROM") ?? "";
  return raw.split(/→|->/)[0]?.trim() || "unknown";
}

function rowFor(title: string, number: number, created: string): Row {
  return {
    number,
    sender: getSender(title),
    region: getTag(title, "REGION") || "Untagged",
    place: getTag(title, "PLACE") || "General",
    kind: (getTag(title, "TYPE") || "events").toLowerCase(),
    created,
  };
}

function renderFile(sinceIso: string, nowIso: string, rows: Row[]): string {
  const lines = [
    "# Not Yet Indexed",
    "",
    `**Since Last Index Compile:** ${sinceIso}`,
    `**Last Updated:** ${nowIso}`,
    `**Unindexed Issue Count:** ${rows.length}`,
    "",
    "| Issue | From | Region | Place | Type | Posted |",
    "|-------|------|------|------|------|--------|",
  ];
  for (const row of rows) {
    lines.push(
      `| #${row.number} | ${row.sender} | ${row.region} | ${row.place} | ${row.kind} | ${row.created} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Strips the volatile `**Last Updated:**` stamp so no-op rebuilds compare equal. */
function stripStamp(content: string): string {
  return content.replace(/^\*\*Last Updated:\*\* .+$/m, "**Last Updated:**");
}

function lastCompileIso(): string {
  const configured = process.env.WEIGHTS_PATH;
  const candidates = configured ? [configured] : WEIGHT_PATHS;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
      if (
        typeof parsed === "object" && parsed !== null &&
        typeof (parsed as Record<string, unknown>)._last_compile_iso === "string"
      ) {
        return (parsed as Record<string, string>)._last_compile_iso;
      }
    } catch {
      // fall through to the default below
    }
  }
  return isoNoMillis(new Date(Date.now() - 6 * 60 * 60 * 1000));
}

async function fetchIssuesCreatedSince(
  owner: string,
  repo: string,
  token: string,
  sinceIso: string,
): Promise<GitHubIssue[]> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const issues: GitHubIssue[] = [];
  let page = 1;

  while (true) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
    url.searchParams.set("state", "all");
    // `since` filters on updated_at, a superset of created_at >= since.
    url.searchParams.set("since", sinceIso);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GitHub API ${response.status} ${response.statusText}: ${body.slice(0, 300)}`,
      );
    }
    const batch = (await response.json()) as GitHubIssue[];
    if (batch.length === 0) {
      break;
    }
    issues.push(
      ...batch.filter(
        (issue) =>
          issue.pull_request === undefined &&
          typeof issue.created_at === "string" &&
          issue.created_at >= sinceIso,
      ),
    );
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }

  return issues;
}

function payloadRow(): Row | undefined {
  const title = process.env.ISSUE_TITLE;
  const number = process.env.ISSUE_NUMBER;
  const created = process.env.ISSUE_CREATED;
  if (!title || !number || !created) {
    return undefined;
  }
  const parsed = Number(number);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return rowFor(title, parsed, created);
}

function legacyAppend(row: Row): void {
  const now = isoNoMillis(new Date());
  let content: string;
  if (existsSync("not_indexed.md")) {
    content = readFileSync("not_indexed.md", "utf8");
  } else {
    content = renderFile(now, now, []);
  }

  const countMatch = content.match(/\*\*Unindexed Issue Count:\*\* (\d+)/);
  if (countMatch) {
    const oldCount = Number(countMatch[1]);
    content = content.replace(
      `**Unindexed Issue Count:** ${oldCount}`,
      `**Unindexed Issue Count:** ${oldCount + 1}`,
    );
  }
  content = content.replace(/\*\*Last Updated:\*\* .+/, `**Last Updated:** ${now}`);
  const newRow = `| #${row.number} | ${row.sender} | ${row.region} | ${row.place} | ${row.kind} | ${row.created} |\n`;
  writeFileSync("not_indexed.md", `${content.trimEnd()}\n${newRow}`, "utf8");
  console.log(`[done] Appended issue #${row.number} (legacy mode — no GH_TOKEN)`);
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN;
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const eventRow = payloadRow();

  if (!token || !owner || !repo) {
    if (!eventRow) {
      throw new Error(
        "FATAL: need GH_TOKEN/REPO_OWNER/REPO_NAME (reconcile) or ISSUE_TITLE/ISSUE_NUMBER/ISSUE_CREATED (legacy append)",
      );
    }
    legacyAppend(eventRow);
    return;
  }

  const sinceIso = lastCompileIso();
  const issues = await fetchIssuesCreatedSince(owner, repo, token, sinceIso);

  const byNumber = new Map<number, Row>();
  for (const issue of issues) {
    if (issue.number === undefined) {
      continue;
    }
    byNumber.set(issue.number, rowFor(issue.title ?? "", issue.number, issue.created_at ?? ""));
  }
  // Always merge the trigger issue, even if its created_at predates the
  // compile stamp (clock skew): a stale row for an already-indexed issue is
  // harmless and clears on the next rebuild; a missing row hides a memory.
  if (eventRow && !byNumber.has(eventRow.number)) {
    byNumber.set(eventRow.number, eventRow);
  }

  const rows = [...byNumber.values()].sort((a, b) => a.number - b.number);
  const next = renderFile(sinceIso, isoNoMillis(new Date()), rows);

  // Skip the write when only the Last Updated stamp would change, so the
  // workflow's "already up to date" short-circuit works and repeat runs
  // don't push timestamp-only churn commits.
  if (
    existsSync("not_indexed.md") &&
    stripStamp(readFileSync("not_indexed.md", "utf8")) === stripStamp(next)
  ) {
    console.log(`[done] not_indexed.md already current (${rows.length} issue(s)) — no write`);
    return;
  }

  writeFileSync("not_indexed.md", next, "utf8");
  console.log(
    `[done] Reconciled not_indexed.md: ${rows.length} issue(s) since last compile ${sinceIso}`,
  );
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

// Exported for the test suite (test/) — the CLI behavior above is unchanged.
export { getSender, getTag, renderFile, rowFor, stripStamp };
