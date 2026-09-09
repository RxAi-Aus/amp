#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

const scanMode = process.argv.includes("--public")
  ? "public"
  : process.argv.includes("--history")
    ? "history"
    : process.argv.includes("--all")
      ? "all"
      : "staged";

const strictPatterns = [
  ["GitHub token", /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ["Anthropic API key", /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{32,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g],
  ["npm access token", /\bnpm_[A-Za-z0-9]{20,}\b/g],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["Bing site-verification token", /<users>\s*<user>[A-F0-9]{32}<\/user>\s*<\/users>/gi],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];

const assignmentPattern =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_-]*)\b\s*[:=]\s*["']?([^"'\s`$<>][^"'\s`]{7,})/g;

const personalEmailPattern =
  /\b([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+)@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

const labelledPersonalDataPattern =
  /\b(phone|mobile|telephone|date[ _-]?of[ _-]?birth|dob|home[ _-]?address|passport(?:[ _-]?number)?|driver(?:'s)?[ _-]?licen[cs]e(?:[ _-]?number)?|ssn|tax[ _-]?file[ _-]?number|tfn|medicare(?:[ _-]?number)?)\b\s*[:=]\s*["']?([^\n\r"'`]{3,})/gi;

const homePathPatterns = [
  /\/Users\/([A-Za-z0-9._-]+)(?=\/)/g,
  /\/home\/([A-Za-z0-9._-]+)(?=\/)/g,
  /\b[A-Za-z]:\\Users\\([^\\\s"'`<>]+)(?=\\)/g,
];

const safeHomeNames = new Set([
  "default",
  "example",
  "public",
  "runner",
  "shared",
  "test",
  "user",
  "username",
  "x",
]);

const safeEmailLocalParts = new Set([
  "admin",
  "bot",
  "contact",
  "git",
  "hello",
  "info",
  "legal",
  "license",
  "no-reply",
  "noreply",
  "privacy",
  "security",
  "support",
]);

const sensitiveBasenames = new Map([
  [".ds_store", "Finder metadata"],
  ["permanent_memory.json", "permanent personal memory"],
  ["credentials.json", "credential file"],
  ["id_rsa", "SSH private key"],
  ["id_ed25519", "SSH private key"],
]);

const sensitiveExtensions = new Set([
  ".db",
  ".jks",
  ".key",
  ".keystore",
  ".log",
  ".mobileprovision",
  ".p12",
  ".pem",
  ".pfx",
  ".sqlite",
  ".sqlite3",
  ".token",
]);

// Issue-derived projections. GitHub Actions regenerates these from the live
// Issues store, which PROTOCOL.md §16.1 requires to stay private, so their text
// is memory rather than source: a private instance legitimately holds personal
// data here. Staged and working-tree scans skip them; the public gate scans
// them and additionally fails closed on any non-empty projection.
const projectionPathPatterns = [
  /^INDEX\.md$/i,
  /^not_indexed\.md$/i,
  /^weights\.json$/i,
  /^REGION-[^/]+\.md$/i,
  /^okf\//i,
  /^artifacts\/okf\//i,
];

export function isIssueProjection(file) {
  const normalized = file.replaceAll("\\", "/");
  return projectionPathPatterns.some((pattern) => pattern.test(normalized));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
}

function listFiles(mode) {
  const args = mode === "all"
    ? ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]
    : ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"];
  return git(args).split("\0").filter(Boolean);
}

function fileContent(file, mode) {
  if (mode === "staged") {
    return git(["show", `:${file}`]);
  }
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    return readlinkSync(file, "utf8");
  }
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function isText(content) {
  return !content.includes("\0");
}

function safeValue(value) {
  return /^(example|placeholder|changeme|redacted|dummy|your-|xxx|\*\*\*)/i.test(value) ||
    value.includes("${{") ||
    value.includes("process.env");
}

function safePersonalValue(value) {
  return /^(example|placeholder|changeme|redacted|dummy|your\b|xxx|\*\*\*|<[^>]+>|\[[^\]]+\])/i.test(
    value.trim(),
  ) || value.includes("${{") || value.includes("${");
}

function safeEmail(localPart, domain) {
  const local = localPart.toLowerCase();
  const host = domain.toLowerCase();
  return safeEmailLocalParts.has(local) ||
    host === "example.com" ||
    host === "example.org" ||
    host === "example.net" ||
    host.endsWith(".example.com") ||
    host.endsWith(".example.org") ||
    host.endsWith(".example.net") ||
    host === "users.noreply.github.com";
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

function finding(file, content, index, name) {
  return `${file}:${lineNumber(content, index)} ${name}`;
}

export function scanPath(file) {
  const normalized = file.replaceAll("\\", "/");
  const parts = normalized.toLowerCase().split("/").filter(Boolean);
  const basename = parts.at(-1) ?? "";
  const findings = [];

  const basenameReason = sensitiveBasenames.get(basename);
  if (basenameReason) {
    findings.push(`${file}:1 sensitive file path (${basenameReason})`);
  }

  if (parts.includes(".rxai-cache")) {
    findings.push(`${file}:1 sensitive file path (local AMP issue cache)`);
  }
  if (parts.includes("secrets")) {
    findings.push(`${file}:1 sensitive file path (secrets directory)`);
  }
  if (/^\.env(?:\..+)?$/i.test(basename) && !/\.example$/i.test(basename)) {
    findings.push(`${file}:1 sensitive file path (environment file)`);
  }
  if (/^service-account.*\.json$/i.test(basename)) {
    findings.push(`${file}:1 sensitive file path (service-account credentials)`);
  }

  const dot = basename.lastIndexOf(".");
  const extension = dot >= 0 ? basename.slice(dot) : "";
  if (sensitiveExtensions.has(extension) && !/\.(?:example|sample)$/i.test(basename)) {
    findings.push(`${file}:1 sensitive file path (${extension} file)`);
  }

  return findings;
}

export function scanPublicationPath(file) {
  const normalized = file.replaceAll("\\", "/");
  const findings = [];

  if (/^REGION-[^/]+\.md$/i.test(normalized)) {
    findings.push(`${file}:1 AMP Region projection contains issue-derived memory`);
  }
  if (/^okf\/[^/]+\/.+/i.test(normalized)) {
    findings.push(`${file}:1 OKF projection contains issue-derived memory`);
  }
  if (/^artifacts\/okf\/.+/i.test(normalized)) {
    findings.push(`${file}:1 OKF export contains issue-derived memory`);
  }

  return findings;
}

export function scanPublicationArtifact(file, content = "") {
  const normalized = file.replaceAll("\\", "/");
  const findings = scanPublicationPath(file);

  if (normalized === "INDEX.md") {
    const count = Number(content.match(/^\*\*Total Issues Indexed:\*\*\s+(\d+)/m)?.[1] ?? 0);
    if (count > 0) {
      findings.push(`${file}:1 AMP index reports ${count} issue-derived memories`);
    }
  }

  if (normalized === "not_indexed.md") {
    const count = Number(content.match(/^\*\*Unindexed Issue Count:\*\*\s+(\d+)/m)?.[1] ?? 0);
    if (count > 0) {
      findings.push(`${file}:1 AMP tracker reports ${count} unindexed memories`);
    }
  }

  if (normalized === "weights.json") {
    try {
      const state = JSON.parse(content);
      const memoryKeys = Object.keys(state).filter((key) => key !== "_last_compile_iso");
      if (memoryKeys.length > 0) {
        findings.push(`${file}:1 AMP weight state contains ${memoryKeys.length} memory records`);
      }
    } catch {
      findings.push(`${file}:1 AMP weight state is not valid JSON`);
    }
  }

  return findings;
}

export function scanContent(file, content) {
  if (!isText(content)) {
    return [];
  }

  const findings = [];

  for (const [name, pattern] of strictPatterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      findings.push(finding(file, content, match.index ?? 0, name));
    }
  }

  assignmentPattern.lastIndex = 0;
  for (const match of content.matchAll(assignmentPattern)) {
    const [, key, value] = match;
    if (!safeValue(value)) {
      findings.push(finding(file, content, match.index ?? 0, `possible secret assignment (${key})`));
    }
  }

  for (const pattern of homePathPatterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const accountName = match[1].toLowerCase();
      if (!safeHomeNames.has(accountName)) {
        findings.push(finding(file, content, match.index ?? 0, "personal home-directory path"));
      }
    }
  }

  personalEmailPattern.lastIndex = 0;
  for (const match of content.matchAll(personalEmailPattern)) {
    const [, localPart, domain] = match;
    if (!safeEmail(localPart, domain)) {
      findings.push(finding(file, content, match.index ?? 0, "possible personal email address"));
    }
  }

  labelledPersonalDataPattern.lastIndex = 0;
  for (const match of content.matchAll(labelledPersonalDataPattern)) {
    const [, label, value] = match;
    if (!safePersonalValue(value)) {
      findings.push(finding(file, content, match.index ?? 0, `possible personal data (${label})`));
    }
  }

  return findings;
}

function scanWorkingFiles(mode, { includeProjections = false } = {}) {
  const findings = [];
  for (const file of listFiles(mode)) {
    if (!includeProjections && isIssueProjection(file)) {
      continue;
    }
    findings.push(...scanPath(file));
    let content = "";
    try {
      content = fileContent(file, mode);
    } catch {
      continue;
    }
    findings.push(...scanContent(file, content));
  }
  return findings;
}

function scanPublicationArtifacts() {
  const findings = [];
  for (const file of listFiles("all")) {
    let content = "";
    try {
      content = fileContent(file, "all");
    } catch {
      const normalized = file.replaceAll("\\", "/");
      if (
        normalized === "INDEX.md" ||
        normalized === "not_indexed.md" ||
        normalized === "weights.json" ||
        scanPublicationPath(file).length > 0
      ) {
        findings.push(`${file}:1 publication artifact could not be read safely`);
      }
      continue;
    }
    findings.push(...scanPublicationArtifact(file, content));
  }
  return findings;
}

function scanHistory() {
  const findings = [];
  const patch = git([
    "log",
    "--all",
    "--format=commit %H",
    "--patch",
    "--no-ext-diff",
    "--no-renames",
  ]);
  const seenHistoryContent = new Set();
  for (const item of scanContent("git-history", patch)) {
    const category = item.replace(/^git-history:\d+\s+/, "");
    if (!seenHistoryContent.has(category)) {
      seenHistoryContent.add(category);
      findings.push(item);
    }
  }

  const historicalPaths = new Set(
    git(["log", "--all", "--format=", "--name-only"])
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  for (const file of historicalPaths) {
    for (const item of scanPath(file)) {
      findings.push(`git-history:${item}`);
    }
    for (const item of scanPublicationPath(file)) {
      findings.push(`git-history:${item}`);
    }
  }

  const authors = git(["log", "--all", "--format=%H%x00%ae"])
    .split("\n")
    .filter(Boolean);
  const reportedEmails = new Set();
  for (const entry of authors) {
    const [commit, email = ""] = entry.split("\0");
    const match = email.match(/^([^@]+)@(.+)$/);
    if (!match || safeEmail(match[1], match[2]) || reportedEmails.has(email.toLowerCase())) {
      continue;
    }
    reportedEmails.add(email.toLowerCase());
    findings.push(`git-history:${commit.slice(0, 12)} possible personal commit-author email address`);
  }

  return findings;
}

export function runScan(mode = scanMode) {
  if (mode === "public") {
    return [
      ...scanWorkingFiles("all", { includeProjections: true }),
      ...scanPublicationArtifacts(),
      ...scanHistory(),
    ];
  }
  if (mode === "history") {
    return scanHistory();
  }
  if (mode !== "all" && mode !== "staged") {
    throw new Error(`Unsupported scan mode: ${mode}`);
  }
  return scanWorkingFiles(mode);
}

function main() {
  const findings = runScan();
  if (findings.length > 0) {
    const scope = scanMode === "staged"
      ? "staged values"
      : scanMode === "public"
        ? "public-release working tree and reachable Git history"
        : scanMode === "history"
          ? "reachable Git history"
          : "working-tree values";
    console.error(`Secret/privacy scan failed. Review these ${scope} before publishing:`);
    for (const item of findings) {
      console.error(`  - ${item}`);
    }
    console.error("\nThe scanner reports categories and locations without echoing sensitive values.");
    process.exitCode = 1;
    return;
  }

  console.log(`Secret/privacy scan passed (${scanMode}).`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  main();
}
