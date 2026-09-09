#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * agent_loop_guard.ts - Protocol v2.9.1 (Rule 14)
 *
 * Deterministic Agent Loop Guard for event-driven AMP agents. Graduated from
 * AgentLoop/agent_loop_quard.ts in v2.9; design rationale stays in
 * AgentLoop/AgentLoop.md, the normative spec is PROTOCOL.md Rule 14.
 *
 * Usage:
 *   npm run loop:guard -- guard-input.json     (or stdin)
 *
 * Input shape is intentionally small so a GitHub Actions workflow can build it
 * from issue title, labels, comments, trigger comment id, and event metadata.
 * Output: JSON { decision: allow|skip|hold, loopRisk, reason, checks[] };
 * exit code 0 on allow, 10 on skip/hold, 2 on malformed input.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type GuardDecision = "allow" | "skip" | "hold";
type LoopRisk = "low" | "medium" | "high";
type Outcome = "success" | "failure" | "neutral";

type CommentInput = {
  id: string | number;
  author?: string;
  body?: string;
  created_at?: string;
  actorType?: "human" | "agent" | "bot" | "system";
};

type GuardInput = {
  issueNumber?: string | number;
  issueTitle?: string;
  labels?: string[];
  agent: string;
  eventType?: string;
  eventData?: string;
  triggerCommentId?: string | number;
  maxHops?: number;
  maxAgentStreak?: number;
  maxRecentFailures?: number;
  comments: CommentInput[];
};

type AgentMetadata = {
  agent?: string;
  run_id?: string;
  trigger_comment_id?: string;
  responds_to_comment_id?: string;
  hop?: string;
  max_hops?: string;
  idempotency_key?: string;
  requires_response?: string;
};

type CheckResult = {
  name: string;
  passed: boolean;
  message: string;
};

type GuardOutput = {
  decision: GuardDecision;
  loopRisk: LoopRisk;
  reason: string;
  issueNumber?: string | number;
  agent: string;
  triggerCommentId?: string | number;
  checks: CheckResult[];
};

const AMP_AGENT_BLOCK_RE = /<!--\s*amp-agent\s*([\s\S]*?)-->/gi;
const OUTCOME_RE = /^\s*-?\s*\*\*Outcome:\*\*\s*(success|failure|neutral)\s*$/im;
const FROM_RE = /\[FROM:([^\]→]+)→([^\]]+)\]/;
const STOP_LABELS = new Set(["agent:hold", "agent:busy", "agent:needs-human"]);

function normalizeId(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAgentMetadata(body: string | undefined): AgentMetadata[] {
  if (!body) {
    return [];
  }

  const results: AgentMetadata[] = [];
  for (const match of body.matchAll(AMP_AGENT_BLOCK_RE)) {
    const rawBlock = match[1] ?? "";
    const metadata: AgentMetadata = {};

    for (const line of rawBlock.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator === -1) {
        continue;
      }

      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (!key || !value) {
        continue;
      }

      metadata[key as keyof AgentMetadata] = value;
    }

    results.push(metadata);
  }

  return results;
}

function latestMetadata(comment: CommentInput | undefined): AgentMetadata | undefined {
  return parseAgentMetadata(comment?.body).at(-1);
}

function commentMetadata(comment: CommentInput): AgentMetadata[] {
  return parseAgentMetadata(comment.body);
}

function parseOutcome(body: string | undefined): Outcome {
  if (!body) {
    return "neutral";
  }
  const match = body.match(OUTCOME_RE);
  return match ? (match[1].toLowerCase() as Outcome) : "neutral";
}

function isAgentComment(comment: CommentInput): boolean {
  const metadata = commentMetadata(comment);
  if (metadata.some((entry) => entry.agent)) {
    return true;
  }
  if (comment.actorType === "agent" || comment.actorType === "bot" || comment.actorType === "system") {
    return true;
  }
  return /\[bot\]$/i.test(comment.author ?? "");
}

function isHumanComment(comment: CommentInput): boolean {
  if (comment.actorType === "human") {
    return true;
  }
  return !isAgentComment(comment);
}

function commentAgent(comment: CommentInput): string | undefined {
  const metadata = latestMetadata(comment);
  if (metadata?.agent) {
    return metadata.agent;
  }
  return undefined;
}

function titleRecipient(issueTitle: string | undefined): string | undefined {
  if (!issueTitle) {
    return undefined;
  }
  const match = issueTitle.match(FROM_RE);
  return match?.[2]?.trim();
}

function isAddressedToAgent(issueTitle: string | undefined, agent: string): boolean {
  const recipient = titleRecipient(issueTitle);
  if (!recipient) {
    return true;
  }
  const normalized = recipient.toLowerCase();
  return normalized === agent.toLowerCase() || normalized === "all" || normalized === "self";
}

function lastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) {
      return i;
    }
  }
  return -1;
}

function hasExistingIdempotencyKey(comments: CommentInput[], key: string | undefined): boolean {
  if (!key) {
    return false;
  }
  return comments.some((comment) =>
    commentMetadata(comment).some((metadata) => metadata.idempotency_key === key),
  );
}

function buildIdempotencyKey(input: GuardInput): string | undefined {
  const issue = normalizeId(input.issueNumber);
  const trigger = normalizeId(input.triggerCommentId);
  if (!issue || !trigger) {
    return undefined;
  }
  return `issue-${issue}:comment-${trigger}:${input.agent}`;
}

function countLatestAgentStreak(comments: CommentInput[]): number {
  let count = 0;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    if (!isAgentComment(comments[i])) {
      break;
    }
    count += 1;
  }
  return count;
}

function countRecentAgentFailures(comments: CommentInput[], limit: number): number {
  return comments
    .slice(Math.max(0, comments.length - limit))
    .filter((comment) => isAgentComment(comment) && parseOutcome(comment.body) === "failure")
    .length;
}

function evaluateGuard(input: GuardInput): GuardOutput {
  const comments = input.comments ?? [];
  const latestComment = comments.at(-1);
  const triggerId = normalizeId(input.triggerCommentId);
  const maxHops = input.maxHops ?? 2;
  const maxAgentStreak = input.maxAgentStreak ?? 3;
  const maxRecentFailures = input.maxRecentFailures ?? 2;
  const checks: CheckResult[] = [];

  function addCheck(name: string, passed: boolean, message: string): void {
    checks.push({ name, passed, message });
  }

  function finish(decision: GuardDecision, loopRisk: LoopRisk, reason: string): GuardOutput {
    return {
      decision,
      loopRisk,
      reason,
      issueNumber: input.issueNumber,
      agent: input.agent,
      triggerCommentId: input.triggerCommentId,
      checks,
    };
  }

  const labels = new Set((input.labels ?? []).map((label) => label.toLowerCase()));
  const stopLabel = [...labels].find((label) => STOP_LABELS.has(label));
  addCheck("control-label", stopLabel === undefined, stopLabel ? `Blocked by ${stopLabel}` : "No stop label");
  if (stopLabel) {
    return finish("hold", "high", `Control label ${stopLabel} requires human or controller review`);
  }

  const isStatusUpdate = input.eventData === "StatusUpdate" || input.eventType === "StatusUpdate";
  addCheck("status-update", !isStatusUpdate, isStatusUpdate ? "Status update is not a task" : "Not a status update");
  if (isStatusUpdate) {
    return finish("skip", "low", "Status update events must not call the LLM");
  }

  const addressed = isAddressedToAgent(input.issueTitle, input.agent);
  addCheck("addressing", addressed, addressed ? "Issue is addressed to this agent or all" : "Issue is addressed elsewhere");
  if (!addressed) {
    return finish("skip", "low", "Issue title is not addressed to this agent");
  }

  const idempotencyKey = buildIdempotencyKey(input);
  const duplicate = hasExistingIdempotencyKey(comments, idempotencyKey);
  addCheck("idempotency", !duplicate, duplicate ? "Response key already exists" : "No duplicate response key");
  if (duplicate) {
    return finish("skip", "low", "This trigger was already handled by this agent");
  }

  const triggerComment = triggerId
    ? comments.find((comment) => normalizeId(comment.id) === triggerId)
    : latestComment;
  const triggerMetadata = latestMetadata(triggerComment);
  const triggerRequiresResponse = parseBoolean(triggerMetadata?.requires_response);
  addCheck(
    "requires-response",
    triggerRequiresResponse !== false,
    triggerRequiresResponse === false ? "Trigger explicitly does not require a response" : "Trigger may require response",
  );
  if (triggerRequiresResponse === false) {
    return finish("skip", "low", "Trigger comment has requires_response: false");
  }

  const triggerAgent = triggerComment ? commentAgent(triggerComment) : undefined;
  const isSelfTrigger = triggerAgent !== undefined && triggerAgent.toLowerCase() === input.agent.toLowerCase();
  addCheck("self-reply", !isSelfTrigger, isSelfTrigger ? "Trigger was written by this agent" : "Trigger is not self-authored");
  if (isSelfTrigger) {
    return finish("skip", "medium", "Agents must not respond to their own automatic comments");
  }

  const triggerHop = parseInteger(triggerMetadata?.hop) ?? 0;
  const triggerMaxHops = parseInteger(triggerMetadata?.max_hops) ?? maxHops;
  const hopAllowed = triggerHop < triggerMaxHops;
  addCheck("hop-cap", hopAllowed, hopAllowed ? `Hop ${triggerHop}/${triggerMaxHops}` : `Hop cap reached: ${triggerHop}/${triggerMaxHops}`);
  if (!hopAllowed) {
    return finish("hold", "high", "Automatic reply hop cap reached");
  }

  const lastSelfIndex = lastIndex(
    comments,
    (comment) => (commentAgent(comment) ?? "").toLowerCase() === input.agent.toLowerCase(),
  );
  const hasHumanAfterSelf = lastSelfIndex === -1 || comments.slice(lastSelfIndex + 1).some(isHumanComment);
  addCheck(
    "new-human-input",
    hasHumanAfterSelf,
    hasHumanAfterSelf ? "New human input exists after last self reply" : "No human input after last self reply",
  );
  if (!hasHumanAfterSelf) {
    return finish("skip", "medium", "No new human or Telegram-user message exists after this agent's last reply");
  }

  const latestAgentStreak = countLatestAgentStreak(comments);
  const agentStreakAllowed = latestAgentStreak < maxAgentStreak;
  addCheck(
    "agent-streak",
    agentStreakAllowed,
    agentStreakAllowed ? `Latest agent streak is ${latestAgentStreak}` : `Latest agent streak reached ${latestAgentStreak}`,
  );
  if (!agentStreakAllowed) {
    return finish("hold", "high", "Recent comments are all agent/bot comments");
  }

  const recentFailures = countRecentAgentFailures(comments, 6);
  const failuresAllowed = recentFailures < maxRecentFailures;
  addCheck(
    "failure-spiral",
    failuresAllowed,
    failuresAllowed ? `${recentFailures} recent agent failure(s)` : `${recentFailures} recent agent failures`,
  );
  if (!failuresAllowed) {
    return finish("hold", "high", "Recent repeated agent failures require human review");
  }

  return finish("allow", latestAgentStreak > 0 ? "medium" : "low", "Loop guard passed");
}

function readInput(): GuardInput {
  const filePath = process.argv[2];
  const raw = filePath ? readFileSync(filePath, "utf8") : readFileSync(0, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Guard input must be a JSON object");
  }

  const input = parsed as GuardInput;
  if (!input.agent) {
    throw new Error("Guard input requires an agent field");
  }
  if (!Array.isArray(input.comments)) {
    throw new Error("Guard input requires a comments array");
  }
  return input;
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
}

if (isMainModule()) {
  try {
    const output = evaluateGuard(readInput());
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = output.decision === "allow" ? 0 : 10;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}

export { evaluateGuard };
export type { GuardInput, GuardOutput };
