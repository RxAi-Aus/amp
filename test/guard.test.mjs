// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// PROTOCOL.md Rule 14 — deterministic guard decisions (allow | skip | hold).
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateGuard } from "../dist/agent_loop_guard.js";

function ampBlock(fields) {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `<!-- amp-agent\n${lines.join("\n")}\n-->`;
}

function human(id, body = "please look at this") {
  return { id, author: "alice", actorType: "human", body };
}

function agent(id, name, extra = {}, bodyPrefix = "done.") {
  return {
    id,
    author: `${name}[bot]`,
    actorType: "bot",
    body: `${bodyPrefix}\n\n${ampBlock({ agent: name, hop: 1, ...extra })}`,
  };
}

function baseInput(overrides = {}) {
  return {
    issueNumber: 12,
    issueTitle: "[FROM:alice→all][REGION:ProjectX][PLACE:debugging][TYPE:events] test",
    labels: [],
    agent: "librarian",
    triggerCommentId: 1,
    comments: [human(1)],
    ...overrides,
  };
}

test("allow: fresh human trigger passes every check", () => {
  const out = evaluateGuard(baseInput());
  assert.equal(out.decision, "allow");
  assert.equal(out.loopRisk, "low");
});

test("hold: control labels stop automatic work", () => {
  const out = evaluateGuard(baseInput({ labels: ["Agent:Hold"] }));
  assert.equal(out.decision, "hold");
});

test("skip: StatusUpdate events must not call the LLM", () => {
  const out = evaluateGuard(baseInput({ eventType: "StatusUpdate" }));
  assert.equal(out.decision, "skip");
});

test("skip: issue addressed to a different specific agent", () => {
  const out = evaluateGuard(
    baseInput({ issueTitle: "[FROM:alice→codex][REGION:X][PLACE:y][TYPE:events] t" }),
  );
  assert.equal(out.decision, "skip");
});

test("skip: duplicate idempotency_key — trigger already handled", () => {
  const out = evaluateGuard(
    baseInput({
      comments: [
        human(1),
        agent(2, "librarian", { idempotency_key: "issue-12:comment-1:librarian" }),
        human(3, "unrelated follow-up"),
      ],
    }),
  );
  assert.equal(out.decision, "skip");
});

test("skip: trigger comment declares requires_response: false", () => {
  const out = evaluateGuard(
    baseInput({
      triggerCommentId: 2,
      comments: [human(1), agent(2, "codex", { requires_response: "false", hop: 0 })],
    }),
  );
  assert.equal(out.decision, "skip");
});

test("skip: agents never respond to their own automatic comments", () => {
  const out = evaluateGuard(
    baseInput({
      triggerCommentId: 2,
      comments: [human(1), agent(2, "librarian", { hop: 0 })],
    }),
  );
  assert.equal(out.decision, "skip");
});

test("hold: hop cap reached (hop >= max_hops)", () => {
  const out = evaluateGuard(
    baseInput({
      triggerCommentId: 2,
      comments: [human(1), agent(2, "codex", { hop: 2, max_hops: 2 })],
    }),
  );
  assert.equal(out.decision, "hold");
});

test("allow with medium risk: another agent's reply within the hop budget", () => {
  const out = evaluateGuard(
    baseInput({
      triggerCommentId: 2,
      comments: [human(1), agent(2, "codex", { hop: 1, max_hops: 2 })],
    }),
  );
  assert.equal(out.decision, "allow");
  assert.equal(out.loopRisk, "medium");
});

test("skip: no new human input since this agent's last reply", () => {
  const out = evaluateGuard(
    baseInput({
      triggerCommentId: 1,
      comments: [human(1), agent(2, "librarian", { hop: 1 })],
    }),
  );
  assert.equal(out.decision, "skip");
});

test("hold: trailing all-agent streak reaches the limit", () => {
  const out = evaluateGuard(
    baseInput({
      triggerCommentId: 4,
      comments: [
        human(1),
        agent(2, "codex", { hop: 0 }),
        agent(3, "openclaw", { hop: 0 }),
        agent(4, "hermes", { hop: 0 }),
      ],
    }),
  );
  assert.equal(out.decision, "hold");
});

test("hold: repeated recent agent failures form a retry spiral", () => {
  const failure = { hop: 0 };
  const out = evaluateGuard(
    baseInput({
      triggerCommentId: 5,
      comments: [
        agent(2, "codex", failure, "- **Outcome:** failure"),
        human(3, "try again"),
        agent(4, "codex", failure, "- **Outcome:** failure"),
        human(5, "and again"),
      ],
    }),
  );
  assert.equal(out.decision, "hold");
});
