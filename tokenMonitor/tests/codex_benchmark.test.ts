import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchedule, loadTasks, parseCodexJsonl, summarize, type CompletedRun, type TaskDefinition } from '../src/codex_benchmark.js';

// The real task table is project-specific and lives in a gitignored config, so
// the suite carries its own neutral fixture and never depends on that file.
const TASKS: TaskDefinition[] = [
  { id: 'f1', expectedIssue: 201, signals: ['one', 'two', 'three', 'four'], question: 'Q1' },
  { id: 'f2', expectedIssue: 202, signals: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'], question: 'Q2' },
  { id: 'f3', expectedIssue: 203, signals: ['five', 'six', 'seven', 'eight'], question: 'Q3' },
  { id: 'f4', expectedIssue: null, signals: ['nine', 'ten', 'eleven', 'twelve'], question: 'Q4' },
];

test('buildSchedule creates balanced, counterbalanced pairs', () => {
  const runs = buildSchedule(['astra', 'sol'], 'medium', 20, TASKS);
  assert.equal(runs.length, 20);
  for (const model of ['astra', 'sol']) {
    const subset = runs.filter((run) => run.model === model);
    assert.equal(subset.filter((run) => run.arm === 'on').length, 5);
    assert.equal(subset.filter((run) => run.arm === 'off').length, 5);
    for (let pair = 1; pair <= 5; pair += 1) {
      const pairRuns = subset.filter((run) => run.pair === pair);
      assert.deepEqual(new Set(pairRuns.map((run) => run.arm)), new Set(['on', 'off']));
      assert.equal(new Set(pairRuns.map((run) => run.task.id)).size, 1);
    }
  }
  assert.notEqual(runs[0].arm, runs[2].arm);
});

test('parseCodexJsonl extracts exact usage, tools, answer, and recall', () => {
  const lines = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'abc', exit_code: 0 } },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: '失敗', exit_code: 2 } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'alpha beta gamma delta epsilon\nRecall used: #202' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20, reasoning_output_tokens: 5 } },
  ].map((event) => JSON.stringify(event)).join('\n');
  const metrics = parseCodexJsonl(lines, TASKS[1], 1234);
  assert.equal(metrics.inputTokens, 100);
  assert.equal(metrics.uncachedInputTokens, 30);
  assert.equal(metrics.toolOutputBytes, Buffer.byteLength('abc失敗'));
  assert.equal(metrics.commandCalls, 2);
  assert.equal(metrics.commandFailures, 1);
  assert.equal(metrics.recallCorrect, true);
  assert.equal(metrics.signalHits, 5);
  assert.equal(metrics.threadId, 'thread-1');
  assert.equal(metrics.failureMessage, '');
});

test('summarize reports AMP-on percentage change against off', () => {
  const base = {
    reasoning: 'medium', pair: 1, task: TASKS[0], startedAt: '', finishedAt: '', exitCode: 0,
  };
  const metric = (inputTokens: number) => ({
    inputTokens, cachedInputTokens: 0, uncachedInputTokens: inputTokens, outputTokens: 10,
    reasoningOutputTokens: 0, toolOutputBytes: inputTokens, commandCalls: 1, commandFailures: 0,
    eventErrors: 0, durationMs: inputTokens, recallLine: '', citedIssues: [], recallCorrect: false,
    signalHits: 0, signalTotal: 4, answerChars: 1, threadId: '', failureMessage: '',
  });
  const runs: CompletedRun[] = [
    { ...base, id: 'on', model: 'm', arm: 'on', metrics: metric(80) },
    { ...base, id: 'off', model: 'm', arm: 'off', metrics: metric(100) },
  ];
  const summary = summarize(runs);
  assert.equal(summary.models.m.ampOnVsOffPercent.inputTokens, -20);
  assert.equal(summary.models.m.ampOnLowerPairs.inputTokens, 1);
  assert.equal(summary.models.m.pairs, 1);
});

test('loadTasks rejects a missing table with a message that says how to fix it', () => {
  assert.throws(
    () => loadTasks('config/definitely-not-here.json'),
    (error: Error) => /task table not found/.test(error.message) && /tasks\.example\.json/.test(error.message),
  );
});

test('loadTasks validates the shape of every entry', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'amp-tasks-')), 'tasks.json');
  writeFileSync(file, JSON.stringify([{ id: 't', question: 'q', expectedIssue: 1, signals: ['s'] }]));
  assert.deepEqual(loadTasks(file), [{ id: 't', question: 'q', expectedIssue: 1, signals: ['s'] }]);

  writeFileSync(file, JSON.stringify([{ id: 't', question: 'q', expectedIssue: 'nope', signals: [] }]));
  assert.throws(() => loadTasks(file), /expectedIssue must be a number or null/);

  writeFileSync(file, JSON.stringify([]));
  assert.throws(() => loadTasks(file), /non-empty array/);
});
