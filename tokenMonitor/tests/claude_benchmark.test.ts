import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, RULES_VERSION, expectedInjectionTier, injectedFromLedger, parseClaudeJsonl, parseModels, renderClaudeReport, summarizeClaude, type ClaudeCompletedRun } from '../src/claude_benchmark.js';
import type { TaskDefinition } from '../src/codex_benchmark.js';

const TASK: TaskDefinition = { id: 'f1', expectedIssue: 201, signals: ['alpha', 'beta', 'gamma'], question: 'Q1' };

function usage(input: number, created: number, read: number, output: number) {
  return { input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: output };
}

test('parseClaudeJsonl sums per-call usage, counts tools up to the answer, and reads the result event', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'assistant', message: { usage: usage(2, 20000, 10000, 30), content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'abcd' }] } },
    { type: 'assistant', message: { usage: usage(2, 100, 30000, 40), content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'denied' }] }] } },
    { type: 'assistant', message: { usage: usage(2, 50, 30100, 80), content: [{ type: 'text', text: 'alpha beta\nRecall used: #201' }] } },
    // A Stop-hook block would append a user message and another assistant call after the answer.
    { type: 'user', message: { content: [{ type: 'text', text: 'checkpoint' }] } },
    { type: 'assistant', message: { usage: usage(2, 10, 30200, 5), content: [{ type: 'text', text: 'ok' }] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 4, duration_api_ms: 900, total_cost_usd: 0.5, usage: { output_tokens_details: { thinking_tokens: 7 } } },
  ].map((event) => JSON.stringify(event)).join('\n');
  const m = parseClaudeJsonl(events, TASK, 1000);
  assert.equal(m.sessionId, 'sess-1');
  assert.equal(m.apiCalls, 4);
  assert.equal(m.startContextTokens, 30002);
  assert.equal(m.contextTokens, 30002 + 30102 + 30152 + 30212);
  assert.equal(m.uncachedInputTokens, 20002 + 102 + 52 + 12);
  assert.equal(m.cachedInputTokens, 10000 + 30000 + 30100 + 30200);
  assert.equal(m.outputTokens, 155);
  assert.equal(m.toolCalls, 2);
  assert.equal(m.readCalls, 1);
  assert.equal(m.bashCalls, 1);
  assert.equal(m.toolDenials, 1);
  assert.equal(m.toolOutputBytes, Buffer.byteLength('abcd') + Buffer.byteLength('denied'));
  assert.equal(m.stopTailCalls, 1);
  assert.equal(m.numTurns, 4);
  assert.equal(m.costUsd, 0.5);
  assert.equal(m.thinkingTokens, 7);
  assert.equal(m.recallLine, '#201');
  assert.equal(m.recallCorrect, true);
  assert.equal(m.signalHits, 2);
});

test('summarizeClaude reports on-vs-off change, per-pair wins, and per-task rows', () => {
  const base = { reasoning: 'default', pair: 1, task: TASK, startedAt: '', finishedAt: '', exitCode: 0, ledger: null };
  const metric = (cost: number): ClaudeCompletedRun['metrics'] => ({
    contextTokens: cost * 1000, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 1, thinkingTokens: 0,
    startContextTokens: 30000, apiCalls: 3, numTurns: 3, stopTailCalls: 0, toolCalls: 2, readCalls: 2, bashCalls: 0, toolDenials: 0,
    toolOutputBytes: cost * 100, durationMs: cost * 10, apiDurationMs: 0, costUsd: cost, recallLine: '#201', citedIssues: [201],
    recallCorrect: true, signalHits: 3, signalTotal: 3, answerChars: 10, sessionId: '', isError: false, failureMessage: '',
  });
  const runs: ClaudeCompletedRun[] = [
    { ...base, id: 'on', model: 'm', arm: 'on', metrics: metric(8) },
    { ...base, id: 'off', model: 'm', arm: 'off', metrics: metric(10) },
  ];
  const summary = summarizeClaude(runs);
  assert.equal(summary.models.m.ampOnVsOffPercent.costUsd, -20);
  assert.equal(summary.models.m.ampOnLowerPairs.costUsd, 1);
  assert.equal(summary.models.m.pairs, 1);
  assert.equal(summary.models.m.byTask.f1.on.length, 1);
  assert.equal(summary.models.m.arms.on.memoryCited, 1);
  assert.equal(summary.models.m.effort, 'default');
  assert.deepEqual(summary.rulesVersions, [1], 'runs without a recorded version are v1');
  assert.match(renderClaudeReport(summary), /\| m \| default \| 1 \|/);
});

test('injectedFromLedger keeps inject entries only and reads the tier the hooks recorded', () => {
  const ledger = { recall: { surfaced: [
    { issue: 355, via: 'inject', tier: 'pointer' },
    { issue: 368, via: 'inject', tier: 'summary' },
    { issue: 373, via: 'agent' },
    { issue: 390, via: 'inject' },
  ] } };
  assert.deepEqual(injectedFromLedger(ledger), [
    { issue: 355, tier: 'pointer' }, { issue: 368, tier: 'summary' }, { issue: 390, tier: 'summary' },
  ]);
  assert.deepEqual(injectedFromLedger(null), []);
  assert.deepEqual(injectedFromLedger({ recall: {} }), []);
  assert.equal(expectedInjectionTier(ledger, { ...TASK, expectedIssue: 368 }), 'summary');
  assert.equal(expectedInjectionTier(ledger, { ...TASK, expectedIssue: 355 }), 'pointer');
  assert.equal(expectedInjectionTier(ledger, { ...TASK, expectedIssue: 373 }), null, 'a self-fetch is not recall');
  assert.equal(expectedInjectionTier(ledger, { ...TASK, expectedIssue: null }), null);
});

test('summarizeClaude separates what the ledger delivered from what the model cited', () => {
  const control: TaskDefinition = { id: 'c1', expectedIssue: null, signals: ['x'], question: 'Qc' };
  const base = { reasoning: 'xhigh', startedAt: '', finishedAt: '', exitCode: 0, rulesVersion: RULES_VERSION };
  const metric = (recallLine: string, recallCorrect: boolean): ClaudeCompletedRun['metrics'] => ({
    contextTokens: 1, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 1, thinkingTokens: 0,
    startContextTokens: 1, apiCalls: 1, numTurns: 1, stopTailCalls: 0, toolCalls: 0, readCalls: 0, bashCalls: 0, toolDenials: 0,
    toolOutputBytes: 1, durationMs: 1, apiDurationMs: 0, costUsd: 1, recallLine, citedIssues: [...recallLine.matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
    recallCorrect, signalHits: 1, signalTotal: 1, answerChars: 1, sessionId: '', isError: false, failureMessage: '',
  });
  const delivered = { recall: { surfaced: [{ issue: 201, via: 'inject', tier: 'summary' }] } };
  const pointerOnly = { recall: { surfaced: [{ issue: 201, via: 'inject', tier: 'pointer' }] } };
  const runs: ClaudeCompletedRun[] = [
    // Pair 1: summary delivered, model cited it.
    { ...base, id: 'p1-on', model: 'm', arm: 'on', pair: 1, task: TASK, ledger: delivered, metrics: metric('#201', true) },
    { ...base, id: 'p1-off', model: 'm', arm: 'off', pair: 1, task: TASK, ledger: null, metrics: metric('none', false) },
    // Pair 2: summary delivered, model answered none — a ledger hit that the old single column reported as a miss.
    { ...base, id: 'p2-on', model: 'm', arm: 'on', pair: 2, task: TASK, ledger: delivered, metrics: metric('none', false) },
    { ...base, id: 'p2-off', model: 'm', arm: 'off', pair: 2, task: TASK, ledger: null, metrics: metric('none', false) },
    // Pair 3: only the pointer reached the context (prompt stage did not expand it), model still cited it from the title.
    { ...base, id: 'p3-on', model: 'm', arm: 'on', pair: 3, task: TASK, ledger: pointerOnly, metrics: metric('#201', true) },
    { ...base, id: 'p3-off', model: 'm', arm: 'off', pair: 3, task: TASK, ledger: null, metrics: metric('none', false) },
    // Pair 4: control task; hooks stayed silent, model said none.
    { ...base, id: 'p4-on', model: 'm', arm: 'on', pair: 4, task: control, ledger: { recall: { surfaced: [{ issue: 201, via: 'inject', tier: 'pointer' }] } }, metrics: metric('none', true) },
    { ...base, id: 'p4-off', model: 'm', arm: 'off', pair: 4, task: control, ledger: null, metrics: metric('none', true) },
  ];
  const summary = summarizeClaude(runs);
  const on = summary.models.m.arms.on;
  assert.equal(on.memoryEligible, 3);
  assert.equal(on.memoryInjected, 3);
  assert.equal(on.memorySummaryInjected, 2);
  assert.equal(on.memoryCited, 2);
  assert.equal(on.controls, 1);
  assert.equal(on.controlSilent, 1, 'a pointer listing at session start does not count as expansion');
  assert.equal(on.controlNone, 1);
  assert.deepEqual(summary.rulesVersions, [RULES_VERSION]);
  assert.deepEqual(summary.models.m.byTask.f1.on.map((row: any) => row.expectedInjectionTier), ['summary', 'summary', 'pointer']);
  const report = renderClaudeReport(summary);
  assert.match(report, /Prompt rules: v2/);
  assert.match(report, /\| Injected \(ledger\) \| Cited \(model\) \| Control silent \(ledger\) \| Control none \(model\) \|/);
  assert.match(report, /\| 2\/3 \(\+1 pointer\) \| 2\/3 \| 1\/1 \| 1\/1 \|/);
});

test('prompt rules name both arrival points instead of session start alone', () => {
  assert.equal(RULES_VERSION, 2);
  assert.match(RULES, /at session start\s+and\/or alongside this prompt/);
  assert.match(RULES, /RxAi AMP shared memory/);
  assert.doesNotMatch(RULES, /already injected into your context at session start/);
  assert.match(RULES, /Recall used: none\.$/);
});

test('parseModels refuses to run without an explicit model', () => {
  for (const missing of [undefined, '', ' , ']) {
    assert.throws(() => parseModels(missing), /--models is required/);
  }
  assert.deepEqual(parseModels(' claude-opus-5-5 , claude-sonnet-5 '), ['claude-opus-5-5', 'claude-sonnet-5']);
});
