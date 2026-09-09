#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * cache_issues.ts - RxAI AMP local cache layer
 *
 * Mirrors GitHub issues and comments into .rxai-cache/ for fast local lookup.
 * GitHub remains the source of truth. Cached data is advisory and must be
 * refreshed before conflict-sensitive writes.
 *
 * Required for sync:
 *   GH_TOKEN, GITHUB_TOKEN, or GITHUB_PERSONAL_ACCESS_TOKEN
 *   REPO_OWNER + REPO_NAME, or GITHUB_REPOSITORY=owner/repo
 *
 * Optional:
 *   RXAI_CACHE_DIR - defaults to .rxai-cache
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type GitHubLabel = string | { name?: string };

type GitHubIssue = {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  user?: { login?: string } | null;
  labels?: GitHubLabel[];
  pull_request?: unknown;
};

type GitHubComment = {
  id?: number;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  user?: { login?: string } | null;
};

type IssueCacheFile = {
  cached_at: string;
  repo: string;
  issue: GitHubIssue;
};

type CommentsCacheFile = {
  cached_at: string;
  repo: string;
  issue_number: number;
  comments: GitHubComment[];
};

type ManifestIssue = {
  title: string;
  state: string;
  updated_at: string;
  comments: number;
  cached_at: string;
  region: string;
  place: string;
  type: string;
  from: string;
};

type CacheManifest = {
  protocol: "rxai-amp-cache";
  version: 1;
  repo: string;
  last_sync: string;
  issues: Record<string, ManifestIssue>;
};

type SearchRecord = {
  kind: "issue" | "comment";
  issue: number;
  comment_id?: number;
  title: string;
  author: string;
  region: string;
  place: string;
  type: string;
  updated_at: string;
  url?: string;
  preview: string;
  text: string;
};

type SearchRow = SearchRecord & {
  rank: number;
};

function usage(): string {
  return `Usage:
  npm run cache:sync
  npm run cache:status
  npm run cache:get -- <issue-number>
  npm run cache:search -- "<query>" [--limit 20]

Environment for sync:
  GH_TOKEN, GITHUB_TOKEN, or GITHUB_PERSONAL_ACCESS_TOKEN
  REPO_OWNER + REPO_NAME, or GITHUB_REPOSITORY=owner/repo
`;
}

function isoNoMillis(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function cacheDir(): string {
  return process.env.RXAI_CACHE_DIR || ".rxai-cache";
}

function manifestPath(dir: string): string {
  return path.join(dir, "manifest.json");
}

function issuesDir(dir: string): string {
  return path.join(dir, "issues");
}

function commentsDir(dir: string): string {
  return path.join(dir, "comments");
}

function issuePath(dir: string, issueNumber: number | string): string {
  return path.join(issuesDir(dir), `${issueNumber}.json`);
}

function commentsPath(dir: string, issueNumber: number | string): string {
  return path.join(commentsDir(dir), `${issueNumber}.json`);
}

function searchPath(dir: string): string {
  return path.join(dir, "search.jsonl");
}

function searchDbPath(dir: string): string {
  return path.join(dir, "search.sqlite");
}

function openSearchDb(dir: string): DatabaseSync {
  mkdirSync(dir, { recursive: true });
  return new DatabaseSync(searchDbPath(dir), { timeout: 5000 });
}

function ensureCacheDirs(dir: string): void {
  mkdirSync(issuesDir(dir), { recursive: true });
  mkdirSync(commentsDir(dir), { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson(filePath: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") {
      throw new Error(`Could not read ${filePath}: ${errorMessage(error)}`);
    }
    return undefined;
  }
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadManifest(dir: string): CacheManifest | undefined {
  const parsed = readJson(manifestPath(dir));
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (parsed.protocol !== "rxai-amp-cache" || parsed.version !== 1 || !isRecord(parsed.issues)) {
    return undefined;
  }
  return parsed as CacheManifest;
}

function emptyManifest(repo: string, now: string): CacheManifest {
  return {
    protocol: "rxai-amp-cache",
    version: 1,
    repo,
    last_sync: now,
    issues: {},
  };
}

function getToken(): string {
  const token =
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "FATAL: set GH_TOKEN, GITHUB_TOKEN, or GITHUB_PERSONAL_ACCESS_TOKEN before syncing the cache",
    );
  }
  return token;
}

function resolveRepo(): { owner: string; repo: string; repoId: string } {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  if (owner && repo) {
    return { owner, repo, repoId: `${owner}/${repo}` };
  }

  const githubRepository = process.env.GITHUB_REPOSITORY;
  if (githubRepository) {
    const [repoOwner, repoName] = githubRepository.split("/");
    if (repoOwner && repoName) {
      return { owner: repoOwner, repo: repoName, repoId: githubRepository };
    }
  }

  throw new Error("FATAL: set REPO_OWNER and REPO_NAME, or GITHUB_REPOSITORY=owner/repo");
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
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
    if (batch.length === 0) {
      break;
    }

    comments.push(...batch);

    if (batch.length < 100) {
      break;
    }
    page += 1;
  }

  return comments;
}

function getTag(title: string, tag: string): string | undefined {
  const match = title.match(new RegExp(`\\[${tag}:([^\\]]+)\\]`));
  return match?.[1]?.trim();
}

function getSender(title: string): string {
  const match = title.match(/\[FROM:([^\]\u2192]+)/);
  return match?.[1]?.trim() || "unknown";
}

function issueManifestEntry(issue: GitHubIssue, cachedAt: string): ManifestIssue {
  const title = issue.title ?? "";
  return {
    title,
    state: issue.state ?? "unknown",
    updated_at: issue.updated_at ?? "",
    comments: typeof issue.comments === "number" ? issue.comments : 0,
    cached_at: cachedAt,
    region: getTag(title, "REGION") || "Untagged",
    place: getTag(title, "PLACE") || "General",
    type: (getTag(title, "TYPE") || "events").toLowerCase(),
    from: getSender(title),
  };
}

function compactText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function preview(value: string | null | undefined, maxLength = 180): string {
  const compact = compactText(value);
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function readIssueCache(dir: string, issueNumber: number): IssueCacheFile | undefined {
  const parsed = readJson(issuePath(dir, issueNumber));
  if (!isRecord(parsed) || !isRecord(parsed.issue)) {
    return undefined;
  }
  return parsed as IssueCacheFile;
}

function readCommentsCache(dir: string, issueNumber: number): CommentsCacheFile | undefined {
  const parsed = readJson(commentsPath(dir, issueNumber));
  if (!isRecord(parsed) || !Array.isArray(parsed.comments)) {
    return undefined;
  }
  return parsed as CommentsCacheFile;
}

function numericSort(a: string, b: string): number {
  return Number(a) - Number(b);
}

function searchRecordsFromCache(dir: string, manifest: CacheManifest): SearchRecord[] {
  const records: SearchRecord[] = [];

  for (const issueKey of Object.keys(manifest.issues).sort(numericSort)) {
    const issueNumber = Number(issueKey);
    if (!Number.isFinite(issueNumber)) {
      continue;
    }

    const issueCache = readIssueCache(dir, issueNumber);
    const commentsCache = readCommentsCache(dir, issueNumber);
    if (!issueCache) {
      continue;
    }

    const issue = issueCache.issue;
    const meta = manifest.issues[issueKey];
    const title = issue.title ?? meta.title;
    const issueText = `${title}\n${issue.body ?? ""}`;
    const issueRecord: SearchRecord = {
      kind: "issue",
      issue: issueNumber,
      title,
      author: issue.user?.login ?? "unknown",
      region: meta.region,
      place: meta.place,
      type: meta.type,
      updated_at: issue.updated_at ?? meta.updated_at,
      url: issue.html_url,
      preview: preview(issue.body),
      text: issueText,
    };
    records.push(issueRecord);

    for (const comment of commentsCache?.comments ?? []) {
      const commentRecord: SearchRecord = {
        kind: "comment",
        issue: issueNumber,
        comment_id: comment.id,
        title,
        author: comment.user?.login ?? "unknown",
        region: meta.region,
        place: meta.place,
        type: meta.type,
        updated_at: comment.updated_at ?? comment.created_at ?? meta.updated_at,
        url: comment.html_url,
        preview: preview(comment.body),
        text: comment.body ?? "",
      };
      records.push(commentRecord);
    }
  }

  return records;
}

function rebuildSearchJsonl(dir: string, records: SearchRecord[]): number {
  const lines = records.map((record) => JSON.stringify(record));
  writeFileSync(searchPath(dir), lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  return lines.length;
}

function createSearchSchema(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS search_records;
    CREATE VIRTUAL TABLE search_records USING fts5(
      kind,
      issue UNINDEXED,
      comment_id UNINDEXED,
      title,
      author,
      region,
      place,
      type,
      updated_at UNINDEXED,
      url UNINDEXED,
      preview UNINDEXED,
      text
    );
  `);
}

function rebuildSearchDb(dir: string, manifest: CacheManifest): number {
  const records = searchRecordsFromCache(dir, manifest);
  const db = openSearchDb(dir);

  try {
    createSearchSchema(db);
    const insert = db.prepare(`
      INSERT INTO search_records (
        kind,
        issue,
        comment_id,
        title,
        author,
        region,
        place,
        type,
        updated_at,
        url,
        preview,
        text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.exec("BEGIN");
    try {
      for (const record of records) {
        insert.run(
          record.kind,
          record.issue,
          record.comment_id ?? null,
          record.title,
          record.author,
          record.region,
          record.place,
          record.type,
          record.updated_at,
          record.url ?? null,
          record.preview,
          record.text,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }

  rebuildSearchJsonl(dir, records);
  return records.length;
}

async function syncCache(): Promise<void> {
  const dir = cacheDir();
  const { owner, repo, repoId } = resolveRepo();
  const token = getToken();
  const headers = githubHeaders(token);
  const now = isoNoMillis(new Date());
  ensureCacheDirs(dir);

  const previousManifest = loadManifest(dir);
  const previousIssues = previousManifest?.repo === repoId ? previousManifest.issues : {};
  const nextManifest = emptyManifest(repoId, now);

  const issues = await fetchAllIssues(owner, repo, headers);
  let refreshed = 0;
  let reused = 0;
  let commentsFetched = 0;

  for (const issue of issues) {
    if (issue.number === undefined) {
      continue;
    }

    const issueNumber = issue.number;
    const issueKey = String(issueNumber);
    const currentEntry = issueManifestEntry(issue, now);
    const previousEntry = previousIssues[issueKey];
    const issueFileExists = existsSync(issuePath(dir, issueNumber));
    const commentsFileExists = existsSync(commentsPath(dir, issueNumber));
    const stale =
      previousEntry === undefined ||
      previousEntry.updated_at !== currentEntry.updated_at ||
      previousEntry.comments !== currentEntry.comments ||
      !issueFileExists ||
      !commentsFileExists;

    if (stale) {
      writeJson(issuePath(dir, issueNumber), {
        cached_at: now,
        repo: repoId,
        issue,
      } satisfies IssueCacheFile);

      const comments = currentEntry.comments > 0
        ? await fetchAllComments(owner, repo, issueNumber, headers)
        : [];
      commentsFetched += comments.length;
      writeJson(commentsPath(dir, issueNumber), {
        cached_at: now,
        repo: repoId,
        issue_number: issueNumber,
        comments,
      } satisfies CommentsCacheFile);

      refreshed += 1;
    } else {
      currentEntry.cached_at = previousEntry.cached_at;
      reused += 1;
    }

    nextManifest.issues[issueKey] = currentEntry;
  }

  writeJson(manifestPath(dir), nextManifest);
  const searchRecords = rebuildSearchDb(dir, nextManifest);

  console.log(`[done] Synced ${issues.length} issues for ${repoId}`);
  console.log(`[info] Refreshed ${refreshed}, reused ${reused}, fetched ${commentsFetched} comments`);
  console.log(`[info] Wrote ${searchRecords} search records to ${searchDbPath(dir)}`);
}

function parseIssueNumber(value: string | undefined): number {
  const issueNumber = Number((value ?? "").replace(/^#/, ""));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("FATAL: provide a positive issue number");
  }
  return issueNumber;
}

function getIssue(issueArg: string | undefined): void {
  const dir = cacheDir();
  const issueNumber = parseIssueNumber(issueArg);
  const issueCache = readIssueCache(dir, issueNumber);
  const commentsCache = readCommentsCache(dir, issueNumber);
  const manifest = loadManifest(dir);
  const meta = manifest?.issues[String(issueNumber)];

  if (!issueCache) {
    throw new Error(`Issue #${issueNumber} is not cached. Run npm run cache:sync first.`);
  }

  const issue = issueCache.issue;
  const comments = commentsCache?.comments ?? [];
  const title = issue.title ?? meta?.title ?? `(issue #${issueNumber})`;

  console.log(`#${issueNumber} ${title}`);
  console.log(`State: ${issue.state ?? meta?.state ?? "unknown"}`);
  console.log(`Region: ${meta?.region ?? getTag(title, "REGION") ?? "Untagged"}`);
  console.log(`Place: ${meta?.place ?? getTag(title, "PLACE") ?? "General"}`);
  console.log(`Type: ${meta?.type ?? (getTag(title, "TYPE") || "events").toLowerCase()}`);
  console.log(`Updated: ${issue.updated_at ?? meta?.updated_at ?? "unknown"}`);
  console.log(`Cached: ${issueCache.cached_at}`);
  if (issue.html_url) {
    console.log(`URL: ${issue.html_url}`);
  }
  console.log("\n## Body\n");
  console.log(issue.body ?? "");

  console.log(`\n## Comments (${comments.length})\n`);
  for (const comment of comments) {
    console.log(`### ${comment.user?.login ?? "unknown"} at ${comment.updated_at ?? comment.created_at ?? "unknown"}`);
    console.log(comment.body ?? "");
    console.log("");
  }
}

function parseLimit(args: string[]): { queryParts: string[]; limit: number } {
  const queryParts: string[] = [];
  let limit = 20;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      const next = Number(args[index + 1]);
      if (Number.isInteger(next) && next > 0) {
        limit = next;
        index += 1;
      }
    } else {
      queryParts.push(arg);
    }
  }

  return { queryParts, limit };
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function ftsQuery(tokens: string[]): string {
  return tokens.map(quoteFtsToken).join(" AND ");
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function searchScore(record: SearchRecord, rank: number, exactQuery: string): number {
  let score = -rank;
  const lowerTitle = record.title.toLowerCase();
  const lowerText = record.text.toLowerCase();
  const lowerRegion = record.region.toLowerCase();
  const lowerPlace = record.place.toLowerCase();
  const lowerType = record.type.toLowerCase();

  if (record.kind === "issue") {
    score += 2;
  }
  if (lowerTitle.includes(exactQuery)) {
    score += 8;
  }
  if (lowerText.includes(exactQuery)) {
    score += 5;
  }
  if (lowerRegion === exactQuery || lowerPlace === exactQuery || lowerType === exactQuery) {
    score += 4;
  }

  return Math.round(score * 1000) / 1000;
}

function rowToSearchRow(row: Record<string, unknown>): SearchRow {
  const kind = row.kind === "comment" ? "comment" : "issue";
  return {
    kind,
    issue: numberValue(row.issue),
    comment_id: optionalNumberValue(row.comment_id),
    title: stringValue(row.title),
    author: stringValue(row.author),
    region: stringValue(row.region),
    place: stringValue(row.place),
    type: stringValue(row.type),
    updated_at: stringValue(row.updated_at),
    url: stringValue(row.url) || undefined,
    preview: stringValue(row.preview),
    text: stringValue(row.text),
    rank: numberValue(row.rank),
  };
}

function searchFts(dir: string, query: string, limit: number): Array<{ record: SearchRecord; score: number }> {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    throw new Error("FATAL: provide a search query");
  }

  const exactQuery = query.toLowerCase();
  const db = openSearchDb(dir);

  try {
    const rows = db.prepare(`
      SELECT
        kind,
        issue,
        comment_id,
        title,
        author,
        region,
        place,
        type,
        updated_at,
        url,
        preview,
        text,
        bm25(search_records, 6.0, 1.0, 1.0, 4.0, 4.0, 3.0, 1.0, 1.0, 1.0, 1.0, 0.75, 1.0) AS rank
      FROM search_records
      WHERE search_records MATCH ?
      ORDER BY rank, updated_at DESC
      LIMIT ?
    `).all(ftsQuery(tokens), limit * 4);

    return rows
      .map(rowToSearchRow)
      .map((row) => ({
        record: row,
        score: searchScore(row, row.rank, exactQuery),
      }))
      .sort((a, b) => b.score - a.score || b.record.updated_at.localeCompare(a.record.updated_at))
      .slice(0, limit);
  } finally {
    db.close();
  }
}

function searchCache(args: string[]): void {
  const dir = cacheDir();
  const manifest = loadManifest(dir);
  if (!manifest) {
    throw new Error("Cache manifest is missing. Run npm run cache:sync first.");
  }

  const { queryParts, limit } = parseLimit(args);
  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error("FATAL: provide a search query");
  }

  if (!existsSync(searchDbPath(dir))) {
    rebuildSearchDb(dir, manifest);
  }

  const rows = searchFts(dir, query, limit);

  if (rows.length === 0) {
    console.log(`No cache matches for "${query}"`);
    return;
  }

  for (const { record, score } of rows) {
    const id = record.kind === "comment" && record.comment_id
      ? `#${record.issue} comment ${record.comment_id}`
      : `#${record.issue}`;
    console.log(`${id} [${record.region}/${record.place}/${record.type}] score:${score}`);
    console.log(`  ${record.title}`);
    console.log(`  ${record.updated_at} by ${record.author}`);
    if (record.preview) {
      console.log(`  ${record.preview}`);
    }
    if (record.url) {
      console.log(`  ${record.url}`);
    }
  }
}

function statusCache(): void {
  const dir = cacheDir();
  const manifest = loadManifest(dir);
  if (!manifest) {
    console.log(`No cache manifest found at ${manifestPath(dir)}`);
    return;
  }

  let searchRecords = 0;
  let searchIndex = "missing";
  if (existsSync(searchDbPath(dir))) {
    const db = openSearchDb(dir);
    try {
      const row = db.prepare("SELECT count(*) AS count FROM search_records").get();
      searchRecords = numberValue(row?.count);
      searchIndex = searchDbPath(dir);
    } catch {
      searchIndex = `${searchDbPath(dir)} (unreadable)`;
    } finally {
      db.close();
    }
  }

  console.log(`Cache: ${dir}`);
  console.log(`Repo: ${manifest.repo}`);
  console.log(`Last sync: ${manifest.last_sync}`);
  console.log(`Issues: ${Object.keys(manifest.issues).length}`);
  console.log(`Search index: ${searchIndex}`);
  console.log(`Search records: ${searchRecords}`);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "sync") {
    await syncCache();
    return;
  }
  if (command === "get") {
    getIssue(args[0]);
    return;
  }
  if (command === "search") {
    searchCache(args);
    return;
  }
  if (command === "status") {
    statusCache();
    return;
  }

  throw new Error(`Unknown cache command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
