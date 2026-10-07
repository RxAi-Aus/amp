import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexArgs,
  buildSchedule,
  codexFlags,
  costUsd,
  findRollout,
  hasExactInjectedLedger,
  loadPrices,
  loadTasks,
  parseCodexJsonl,
  parseCodexRollout,
  parseModels,
  requireModelArgumentValue,
  summarize,
  validateIsolatedHome,
  type CompletedRun,
  type TaskDefinition,
  renderReport,
} from '../src/codex_benchmark.js';
import { L1_RULES_VERSION, RULES, RULES_L1, RULES_VERSION, rulesFor } from '../src/prompt_rules.js';

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

test('parseModels requires a non-empty explicit model list', () => {
  for (const missing of [undefined, '', '  ', ', ,']) {
    assert.throws(
      () => parseModels(missing),
      (error: Error) => error.message === '--models is required, e.g. --models gpt-6-sol,gpt-6-luna',
    );
  }
  assert.deepEqual(parseModels(' gpt-6-sol, ,gpt-6-luna '), ['gpt-6-sol', 'gpt-6-luna']);
});

test('a present --models flag without a value gets the required-models error', () => {
  for (const args of [['--models'], ['--models', '--hooks']]) {
    assert.throws(
      () => requireModelArgumentValue(args),
      (error: Error) => error.message === '--models is required, e.g. --models gpt-6-sol,gpt-6-luna',
    );
  }
  assert.doesNotThrow(() => requireModelArgumentValue(['--models', 'gpt-6-sol']));
});

test('hooks and rollouts modes require an isolated CODEX_HOME and reject the user home including symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'amp-codex-home-'));
  const userHome = join(root, '.codex');
  const aliasHome = join(root, 'home-alias');
  mkdirSync(userHome);
  symlinkSync(userHome, aliasHome, 'dir');

  assert.throws(() => validateIsolatedHome(undefined, '--hooks', userHome), /^Error: --hooks requires CODEX_HOME/);
  assert.throws(() => validateIsolatedHome(undefined, '--rollouts', userHome), /^Error: --rollouts requires CODEX_HOME/);
  assert.throws(() => validateIsolatedHome(userHome, '--hooks', userHome), /resolves to ~\/\.codex/);
  assert.throws(() => validateIsolatedHome(aliasHome, '--rollouts', userHome), /resolves to ~\/\.codex/);
  assert.equal(validateIsolatedHome(join(root, 'isolated'), '--hooks', userHome), join(root, 'isolated'));
});

test('L1 keeps ignore-user-config while L2 loads hooks with the isolated-home trust bypass', () => {
  const run = buildSchedule(['gpt-6-sol'], 'medium', 2, TASKS)[0];
  const l1 = buildCodexArgs(run, '/tmp/project');
  const l2 = buildCodexArgs(run, '/tmp/project', true);

  assert.ok(l1.includes('--ignore-user-config'));
  assert.ok(!l1.includes('--dangerously-bypass-hook-trust'));
  assert.ok(!l2.includes('--ignore-user-config'));
  assert.ok(l2.includes('--dangerously-bypass-hook-trust'));
});

test('both levels drop execpolicy rules and Codex-native memories; --rollouts only drops --ephemeral', () => {
  const run = buildSchedule(['gpt-6-sol'], 'medium', 2, TASKS)[0];
  const l1 = buildCodexArgs(run, '/tmp/project');
  const l2 = buildCodexArgs(run, '/tmp/project', true);
  const l2Rollouts = buildCodexArgs(run, '/tmp/project', true, true);

  assert.equal(codexFlags(l1), '--json --ephemeral --ignore-user-config --ignore-rules --disable memories');
  assert.equal(codexFlags(l2), '--json --ephemeral --dangerously-bypass-hook-trust --ignore-rules --disable memories');
  assert.equal(codexFlags(l2Rollouts), '--json --dangerously-bypass-hook-trust --ignore-rules --disable memories');
  assert.deepEqual(l2Rollouts.slice(l2Rollouts.indexOf('-m')), l2.slice(l2.indexOf('-m')), 'model, effort, sandbox and prompt are unchanged');
});

test('L2 sends the shared v2 hook-delivery rules; L1 keeps the AMP_DISABLE sentence that guards its off arm', () => {
  const run = buildSchedule(['gpt-6-sol'], 'medium', 2, TASKS)[0];
  const l1Prompt = buildCodexArgs(run, '/tmp/project').at(-1)!;
  const l2Prompt = buildCodexArgs(run, '/tmp/project', true).at(-1)!;

  assert.ok(l2Prompt.startsWith(RULES), 'L2 prompt is the shared RULES text');
  assert.match(l2Prompt, /injected into your context by hooks — at session start\s+and\/or alongside this prompt/);
  assert.doesNotMatch(l2Prompt, /AMP_DISABLE/);
  assert.ok(l1Prompt.startsWith(RULES_L1));
  assert.match(l1Prompt, /check AMP_DISABLE in the environment/);
  assert.doesNotMatch(l1Prompt, /injected into your context by hooks/);
  for (const prompt of [l1Prompt, l2Prompt]) assert.match(prompt, /or: Recall used: none\.\n\nQuestion: Q1$/);
  assert.deepEqual(rulesFor('L2'), { text: RULES, version: RULES_VERSION });
  assert.deepEqual(rulesFor('L1'), { text: RULES_L1, version: L1_RULES_VERSION });
  assert.equal(RULES_VERSION, 2);
  assert.equal(L1_RULES_VERSION, 1);
});

test('exact injection check requires only the three pinned issues via inject', () => {
  const exact = { recall: { surfaced: [355, 368, 373].map((issue) => ({ issue, via: 'inject' })) } };
  assert.equal(hasExactInjectedLedger(exact), true);
  assert.equal(hasExactInjectedLedger({ recall: { surfaced: [...exact.recall.surfaced, { issue: 999, via: 'inject' }] } }), false);
  assert.equal(hasExactInjectedLedger({ recall: { surfaced: [{ issue: 355, via: 'agent' }, { issue: 368, via: 'inject' }, { issue: 373, via: 'inject' }] } }), false);
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
  assert.equal(metrics.reasoningOutputTokens, 5);
});

// Shape copied from a codex-cli 0.156 rollout: rate-limit-only updates carry
// info: null, and the last token_count is repeated when a task completes.
function tokenCount(total: [number, number, number, number], last: [number, number, number, number]) {
  const usage = ([input, cached, output, reasoning]: [number, number, number, number]) => ({
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
    output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
  });
  return { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(total), last_token_usage: usage(last), model_context_window: 258400 } } };
}

test('parseCodexRollout counts distinct model calls and reads the first call\'s cache state', () => {
  const lines = [
    { type: 'session_meta', payload: { id: 'thread-1' } },
    { type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: {} } },
    tokenCount([75185, 0, 231, 174], [75185, 0, 231, 174]),
    tokenCount([150652, 74496, 386, 250], [75467, 74496, 155, 76]),
    tokenCount([226380, 148992, 451, 290], [75728, 74496, 65, 40]),
    { type: 'event_msg', payload: { type: 'task_complete' } },
    tokenCount([226380, 148992, 451, 290], [75728, 74496, 65, 40]),
  ].map((event) => JSON.stringify(event)).join('\n');
  assert.deepEqual(parseCodexRollout(lines), {
    modelCalls: 3,
    startInputTokens: 75185,
    startCachedInputTokens: 0,
    peakInputTokens: 75728,
    inputTokens: 226380,
  });
  assert.equal(parseCodexRollout('').modelCalls, 0);
});

test('findRollout locates the session file by thread id under sessions/YYYY/MM/DD', () => {
  const home = mkdtempSync(join(tmpdir(), 'amp-codex-rollout-'));
  const day = join(home, 'sessions', '2026', '09', '23');
  mkdirSync(day, { recursive: true });
  const threadId = '01a0cc22-540f-7b82-ba96-86f6ec99ec45';
  writeFileSync(join(day, 'rollout-2026-09-23T12-39-56-other.jsonl'), '');
  writeFileSync(join(day, `rollout-2026-09-23T12-39-56-${threadId}.jsonl`), '');
  assert.equal(findRollout(home, threadId), join(day, `rollout-2026-09-23T12-39-56-${threadId}.jsonl`));
  assert.equal(findRollout(home, 'missing'), null);
  assert.equal(findRollout(home, ''), null);
  assert.equal(findRollout(join(home, 'nowhere'), threadId), null);
});

test('costUsd reproduces the published worked example and bills reasoning once', () => {
  const { models } = loadPrices('config/prices.json');
  // 12,450 input of which 10,240 cached; 4,822 output of which 4,180 reasoning.
  const sol = { uncachedInputTokens: 2210, cachedInputTokens: 10240, outputTokens: 4822 };
  assert.equal(costUsd(sol, models['gpt-6-sol']).toFixed(6), '0.054688');
  const luna = { uncachedInputTokens: 2210, cachedInputTokens: 10240, outputTokens: 1480 };
  assert.equal(costUsd(luna, models['gpt-6-luna']).toFixed(7), '0.0010634');
});

test('loadPrices treats a missing file as no prices and rejects malformed entries', () => {
  const missing = loadPrices('config/definitely-not-here.json');
  assert.deepEqual(missing.models, {});
  assert.match(missing.source, /^none/);

  const file = join(mkdtempSync(join(tmpdir(), 'amp-prices-')), 'prices.json');
  writeFileSync(file, JSON.stringify({ source: 'list', checked: '2026-09-23', models: { m: { input: 1, cachedInput: 0.1, output: 5 } } }));
  const loaded = loadPrices(file);
  assert.deepEqual(loaded.models, { m: { input: 1, cachedInput: 0.1, output: 5 } });
  assert.match(loaded.source, /\(list, checked 2026-09-23\)$/);

  writeFileSync(file, JSON.stringify({ models: { m: { input: 1, output: 5 } } }));
  assert.throws(() => loadPrices(file), /models\.m\.cachedInput must be a non-negative number/);
  writeFileSync(file, JSON.stringify({ m: { input: 1, cachedInput: 0.1, output: 5 } }));
  assert.throws(() => loadPrices(file), /expected a "models" object/);
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
    {
      ...base,
      id: 'on',
      model: 'm',
      arm: 'on',
      ledger: { recall: { surfaced: [355, 368, 373].map((issue) => ({ issue, via: 'inject' })) } },
      metrics: metric(80),
    },
    { ...base, id: 'off', model: 'm', arm: 'off', metrics: metric(100) },
  ];
  const summary = summarize(runs);
  assert.equal(summary.models.m.ampOnVsOffPercent.inputTokens, -20);
  assert.equal(summary.models.m.ampOnLowerPairs.inputTokens, 1);
  assert.equal(summary.models.m.pairs, 1);
  assert.equal(summary.models.m.ampOnLedgerCheck.exactInjectedIssues, 1);
  assert.deepEqual(summary.rulesVersions, [1], 'runs without a recorded version are v1');
  assert.equal(summary.models.m.arms.on.memoryCited, 0);
  assert.equal(summary.models.m.arms.on.controlNone, 0);
  const report = renderReport({ ...summary, deliveryLevel: 'L2' } as any);
  assert.match(report, /Prompt rules: v1/);
  assert.match(report, /\| Cited \(model\) \| Control none \(model\) \| Injected ledgers exact \|/);
  assert.equal(summary.models.m.price, null);
  assert.equal(summary.models.m.ampOnVsOffPercent.costUsd, undefined, 'no price, no cost');
  assert.match(report, /\| m \| n\/a \| n\/a \| n\/a \| n\/a \|/);
  assert.doesNotMatch(report, /Per-call telemetry/, 'no rollouts, no rollout table');
});

test('summarize prices each arm and splits output into reasoning and visible tokens', () => {
  const base = { reasoning: 'medium', pair: 1, task: TASKS[0], startedAt: '', finishedAt: '', exitCode: 0, model: 'm' };
  const metric = (uncached: number, cached: number, output: number, reasoning: number) => ({
    inputTokens: uncached + cached, cachedInputTokens: cached, uncachedInputTokens: uncached, outputTokens: output,
    reasoningOutputTokens: reasoning, toolOutputBytes: 0, commandCalls: 1, commandFailures: 0,
    eventErrors: 0, durationMs: 1, recallLine: '', citedIssues: [], recallCorrect: false,
    signalHits: 0, signalTotal: 4, answerChars: 1, threadId: '', failureMessage: '',
  });
  const rollout = (calls: number, startCached: number) => ({ modelCalls: calls, startInputTokens: 1000, startCachedInputTokens: startCached, peakInputTokens: 2000, inputTokens: 5000 });
  const runs: CompletedRun[] = [
    // on: $1 uncached + $0.10 cached + $2 output = $3.10; off: $2 + $0.10 + $3 = $5.10
    { ...base, id: 'on', arm: 'on', metrics: metric(1_000_000, 1_000_000, 400_000, 300_000), rollout: rollout(4, 0) },
    { ...base, id: 'off', arm: 'off', metrics: metric(2_000_000, 1_000_000, 600_000, 200_000), rollout: rollout(6, 900) },
  ];
  const summary = summarize(runs, { m: { input: 1, cachedInput: 0.1, output: 5 } });
  const m = summary.models.m;
  assert.equal(m.arms.on.costUsd.toFixed(2), '3.10');
  assert.equal(m.arms.off.costUsd.toFixed(2), '5.10');
  assert.equal(m.ampOnLowerPairs.costUsd, 1);
  assert.equal(m.arms.on.visibleOutputTokens, 100_000);
  assert.equal(m.arms.off.visibleOutputTokens, 400_000);
  assert.equal(m.ampOnVsOffPercent.visibleOutputTokens, -75);
  assert.equal(m.ampOnVsOffPercent.reasoningOutputTokens, 50);
  assert.equal(m.arms.on.coldStarts, 1);
  assert.equal(m.arms.off.coldStarts, 0);

  const report = renderReport({ ...summary, priceSource: 'test' } as any);
  assert.match(report, /\| m \| \$1 \/ \$0\.1 \/ \$5 \| \$3\.1000 \/ \$5\.1000 \| -39\.2% \| 1\/1 \| -33\.3% \| \+50\.0% \| -75\.0% \| 75% \/ 33% \|/);
  assert.match(report, /## Per-call telemetry/);
  assert.match(report, /\| m \| 1\/1 \| 4\.0 \/ 6\.0 \| 1,000 \/ 1,000 \| 2,000 \/ 2,000 \| 1\/1 \/ 0\/1 \|/);
  assert.match(report, /Prices: test/);
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
