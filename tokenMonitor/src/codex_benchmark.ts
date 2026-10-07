import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { rulesFor } from './prompt_rules.js';

export type Arm = 'on' | 'off';

export interface TaskDefinition {
  id: string;
  question: string;
  expectedIssue: number | null;
  signals: string[];
}

export interface PlannedRun {
  id: string;
  model: string;
  reasoning: string;
  pair: number;
  task: TaskDefinition;
  arm: Arm;
}

export interface RunMetrics {
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  toolOutputBytes: number;
  commandCalls: number;
  commandFailures: number;
  eventErrors: number;
  durationMs: number;
  recallLine: string;
  citedIssues: number[];
  recallCorrect: boolean;
  signalHits: number;
  signalTotal: number;
  answerChars: number;
  threadId: string;
  failureMessage: string;
}

/**
 * Per-model-call accounting from a Codex session rollout. `turn.completed` in
 * the --json stream already carries reasoning_output_tokens, so rollouts are
 * not needed for the output split; they are the only place Codex exposes each
 * model call's own usage (`last_token_usage`), which is what shows how many
 * round-trips a run made and whether its first call hit a warm prompt cache.
 */
export interface RolloutMetrics {
  modelCalls: number;             // distinct token_count events (Codex repeats the last one when a task ends)
  startInputTokens: number;       // first call: system prompt, tools, AGENTS.md, injected recall
  startCachedInputTokens: number; // 0 = the run started on a cold prompt cache
  peakInputTokens: number;        // largest single-call input: how far the context grew
  inputTokens: number;            // final cumulative total; matches Σ turn.completed input_tokens
}

export interface CompletedRun extends PlannedRun {
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  ledger?: unknown | null;
  metrics: RunMetrics;
  rulesVersion?: number;          // absent on runs recorded before prompt_rules.ts existed (= v1)
  rollout?: RolloutMetrics | null; // present only on runs recorded with --rollouts
}

/** USD per 1M tokens. Reasoning tokens bill at the output rate. */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export type PriceTable = Record<string, ModelPrice>;

export const EXPECTED_INJECTED_ISSUES = [355, 368, 373] as const;
const MODELS_REQUIRED_ERROR = '--models is required, e.g. --models gpt-6-sol,gpt-6-luna';

export function requireModelArgumentValue(args: string[]): void {
  const index = args.indexOf('--models');
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) {
    throw new Error(MODELS_REQUIRED_ERROR);
  }
}

export function parseModels(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    throw new Error(MODELS_REQUIRED_ERROR);
  }
  const models = value.split(',').map((model) => model.trim()).filter(Boolean);
  if (models.length === 0) {
    throw new Error(MODELS_REQUIRED_ERROR);
  }
  return models;
}

/**
 * --hooks trusts the home's hooks and --rollouts writes a session file per run,
 * so both need a CODEX_HOME that is not the user's own ~/.codex.
 */
export function validateIsolatedHome(codexHome: string | undefined, flag: string, userCodexHome = join(homedir(), '.codex')): string {
  if (!codexHome || codexHome.trim() === '') throw new Error(`${flag} requires CODEX_HOME to be set`);
  const resolved = resolve(codexHome);
  const defaultHome = resolve(userCodexHome);
  const canonical = (path: string) => existsSync(path) ? realpathSync(path) : path;
  if (canonical(resolved) === canonical(defaultHome)) {
    throw new Error(`${flag} refuses CODEX_HOME when it resolves to ~/.codex`);
  }
  return resolved;
}

/**
 * Every flag between `exec` and `-m` is run isolation, recorded verbatim in the
 * summary. --ignore-rules drops execpolicy .rules files (on a working machine
 * ~/.codex/rules/default.rules is a growing list of one-off approvals);
 * `--disable memories` keeps Codex's own cross-session memory out, so AMP is the
 * only memory under test. Neither stops AGENTS.md: $CODEX_HOME/AGENTS.md and
 * the project's AGENTS.md still load, identically in both arms.
 */
export function buildCodexArgs(run: PlannedRun, project: string, hooks = false, rollouts = false): string[] {
  const args = ['exec', '--json'];
  if (!rollouts) args.push('--ephemeral');
  if (hooks) args.push('--dangerously-bypass-hook-trust');
  else args.push('--ignore-user-config');
  args.push('--ignore-rules', '--disable', 'memories');
  args.push(
    '-m', run.model,
    '-c', `model_reasoning_effort=${run.reasoning}`,
    '-c', 'approval_policy=never',
    '-s', 'read-only',
    '-C', project,
    `${rulesFor(hooks ? 'L2' : 'L1').text}\n\nQuestion: ${run.task.question}`,
  );
  return args;
}

export function hasExactInjectedLedger(ledger: unknown): boolean {
  if (!ledger || typeof ledger !== 'object') return false;
  const surfaced = (ledger as any).recall?.surfaced;
  if (!Array.isArray(surfaced) || surfaced.length !== EXPECTED_INJECTED_ISSUES.length) return false;
  const entries = surfaced.map((entry: any) => ({ issue: Number(entry?.issue), via: entry?.via }));
  if (entries.some((entry: { via: unknown }) => entry.via !== 'inject')) return false;
  const actual = entries.map((entry: { issue: number }) => entry.issue).sort((a: number, b: number) => a - b);
  const expected = [...EXPECTED_INJECTED_ISSUES].sort((a, b) => a - b);
  return actual.every((issue: number, index: number) => issue === expected[index]);
}

export function codexFlags(args: string[]): string {
  return args.slice(1, args.indexOf('-m')).join(' ');
}

export const DEFAULT_TASKS_FILE = 'config/tasks.json';
export const DEFAULT_PRICES_FILE = 'config/prices.json';

/**
 * The task table is the benchmark's only project-specific input: real questions
 * about a real repository, each paired with the memory issue it should surface.
 * It lives outside the source tree so a public harness never carries a private
 * substrate -- copy config/tasks.example.json and edit it.
 */
export function loadTasks(file = process.env.AMP_BENCH_TASKS ?? DEFAULT_TASKS_FILE): TaskDefinition[] {
  const path = resolve(file);
  if (!existsSync(path)) {
    throw new Error(
      `task table not found: ${path}\n` +
        `The questions are specific to the repository under test, so they are not committed. ` +
        `Copy config/tasks.example.json to ${DEFAULT_TASKS_FILE} and edit it, or point ` +
        `AMP_BENCH_TASKS at another file.`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${path}: expected a non-empty array of tasks`);
  }
  return parsed.map((raw, index) => {
    const task = raw as Partial<TaskDefinition>;
    const at = `${path}[${index}]`;
    if (typeof task.id !== 'string' || task.id === '') throw new Error(`${at}: id must be a non-empty string`);
    if (typeof task.question !== 'string' || task.question === '') throw new Error(`${at}: question must be a non-empty string`);
    if (task.expectedIssue !== null && typeof task.expectedIssue !== 'number') throw new Error(`${at}: expectedIssue must be a number or null`);
    if (!Array.isArray(task.signals) || task.signals.some((signal) => typeof signal !== 'string')) {
      throw new Error(`${at}: signals must be an array of strings`);
    }
    return { id: task.id, question: task.question, expectedIssue: task.expectedIssue, signals: task.signals };
  });
}

export function buildSchedule(models: string[], reasoning: string, cases: number, tasks: TaskDefinition[]): PlannedRun[] {
  if (models.length === 0) throw new Error('at least one model is required');
  if (tasks.length === 0) throw new Error('at least one task is required');
  const casesPerPairRound = models.length * 2;
  if (!Number.isInteger(cases) || cases <= 0 || cases % casesPerPairRound !== 0) {
    throw new Error(`--cases must be a positive multiple of ${casesPerPairRound}`);
  }
  const pairsPerModel = cases / casesPerPairRound;
  const schedule: PlannedRun[] = [];
  for (let pairIndex = 0; pairIndex < pairsPerModel; pairIndex += 1) {
    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const model = models[modelIndex];
      const task = tasks[(pairIndex + modelIndex) % tasks.length];
      const pair = pairIndex + 1;
      const order: Arm[] = (pairIndex + modelIndex) % 2 === 0 ? ['on', 'off'] : ['off', 'on'];
      for (const arm of order) {
        schedule.push({
          id: `${sanitize(model)}-p${pair}-${task.id}-${arm}`,
          model,
          reasoning,
          pair,
          task,
          arm,
        });
      }
    }
  }
  return schedule;
}

export function parseCodexJsonl(jsonl: string, task: TaskDefinition, durationMs: number): RunMetrics {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let toolOutputBytes = 0;
  let commandCalls = 0;
  let commandFailures = 0;
  let eventErrors = 0;
  let answer = '';
  let threadId = '';
  let failureMessage = '';

  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started') threadId = String(event.thread_id ?? '');
    if (event.type === 'error') failureMessage = String(event.message ?? '');
    if (event.type === 'turn.failed') failureMessage = String(event.error?.message ?? failureMessage);
    if (event.type === 'turn.completed' && event.usage) {
      inputTokens += Number(event.usage.input_tokens ?? 0);
      cachedInputTokens += Number(event.usage.cached_input_tokens ?? 0);
      outputTokens += Number(event.usage.output_tokens ?? 0);
      reasoningOutputTokens += Number(event.usage.reasoning_output_tokens ?? 0);
    }
    if (event.type !== 'item.completed') continue;
    const item = event.item ?? {};
    if (item.type === 'error') eventErrors += 1;
    if (item.type === 'command_execution') {
      commandCalls += 1;
      toolOutputBytes += Buffer.byteLength(String(item.aggregated_output ?? ''), 'utf8');
      if (typeof item.exit_code === 'number' && item.exit_code !== 0) commandFailures += 1;
    }
    if (item.type === 'agent_message') answer = String(item.text ?? '');
  }

  const recallMatch = answer.match(/^Recall used:\s*([^\n]+)$/im);
  const recallLine = recallMatch?.[1]?.trim() ?? '';
  const citedIssues = [...recallLine.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
  const recallCorrect = task.expectedIssue === null
    ? /\bnone\b/i.test(recallLine) && citedIssues.length === 0
    : citedIssues.includes(task.expectedIssue);
  const lower = answer.toLowerCase();
  const signalHits = task.signals.filter((signal) => lower.includes(signal.toLowerCase())).length;

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens,
    reasoningOutputTokens,
    toolOutputBytes,
    commandCalls,
    commandFailures,
    eventErrors,
    durationMs,
    recallLine,
    citedIssues,
    recallCorrect,
    signalHits,
    signalTotal: task.signals.length,
    answerChars: answer.length,
    threadId,
    failureMessage,
  };
}

export function parseCodexRollout(jsonl: string): RolloutMetrics {
  const metrics: RolloutMetrics = { modelCalls: 0, startInputTokens: 0, startCachedInputTokens: 0, peakInputTokens: 0, inputTokens: 0 };
  let lastTotal = -1;
  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
    const total = event.payload.info?.total_token_usage;
    const last = event.payload.info?.last_token_usage;
    if (!total || !last) continue;                                 // rate-limit-only updates carry info: null
    const totalTokens = Number(total.total_tokens ?? 0);
    if (totalTokens === lastTotal) continue;                        // repeated emission, not a new call
    lastTotal = totalTokens;
    const input = Number(last.input_tokens ?? 0);
    if (metrics.modelCalls === 0) {
      metrics.startInputTokens = input;
      metrics.startCachedInputTokens = Number(last.cached_input_tokens ?? 0);
    }
    metrics.modelCalls += 1;
    metrics.peakInputTokens = Math.max(metrics.peakInputTokens, input);
    metrics.inputTokens = Number(total.input_tokens ?? 0);
  }
  return metrics;
}

/** Rollouts are named rollout-<timestamp>-<thread id>.jsonl under $CODEX_HOME/sessions/YYYY/MM/DD. */
export function findRollout(codexHome: string, threadId: string): string | null {
  const sessions = join(codexHome, 'sessions');
  if (!threadId || !existsSync(sessions)) return null;
  const suffix = `-${threadId}.jsonl`;
  const match = readdirSync(sessions, { recursive: true, encoding: 'utf8' })
    .find((entry) => entry.endsWith(suffix) && entry.split(/[\\/]/).at(-1)!.startsWith('rollout-'));
  return match ? join(sessions, match) : null;
}

/**
 * List prices live in a committed config file because they change and the
 * benchmark never learns them from Codex (a ChatGPT-plan run is not billed per
 * token). A missing file is not an error: the cost columns read n/a.
 */
export function loadPrices(file = process.env.AMP_BENCH_PRICES ?? DEFAULT_PRICES_FILE): { models: PriceTable; source: string } {
  const path = resolve(file);
  if (!existsSync(path)) return { models: {}, source: `none (${file} not found)` };
  const parsed: any = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed.models !== 'object' || parsed.models === null) throw new Error(`${path}: expected a "models" object`);
  const models: PriceTable = {};
  for (const [model, raw] of Object.entries(parsed.models) as [string, any][]) {
    for (const field of ['input', 'cachedInput', 'output'] as const) {
      if (typeof raw?.[field] !== 'number' || !Number.isFinite(raw[field]) || raw[field] < 0) {
        throw new Error(`${path}: models.${model}.${field} must be a non-negative number (USD per 1M tokens)`);
      }
    }
    models[model] = { input: raw.input, cachedInput: raw.cachedInput, output: raw.output };
  }
  const provenance = [parsed.source, parsed.checked && `checked ${parsed.checked}`].filter(Boolean).join(', ');
  return { models, source: provenance ? `${file} (${provenance})` : file };
}

/** output_tokens already includes reasoning_output_tokens, so reasoning is billed once, at the output rate. */
export function costUsd(metrics: Pick<RunMetrics, 'uncachedInputTokens' | 'cachedInputTokens' | 'outputTokens'>, price: ModelPrice): number {
  return (metrics.uncachedInputTokens * price.input + metrics.cachedInputTokens * price.cachedInput + metrics.outputTokens * price.output) / 1e6;
}

type MetricKey = 'inputTokens' | 'uncachedInputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningOutputTokens' | 'visibleOutputTokens' | 'toolOutputBytes' | 'commandCalls' | 'durationMs' | 'costUsd';
const METRICS: MetricKey[] = ['inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'visibleOutputTokens', 'toolOutputBytes', 'commandCalls', 'durationMs', 'costUsd'];

function metricValue(run: CompletedRun, key: MetricKey, price: ModelPrice | undefined): number {
  if (key === 'visibleOutputTokens') return Math.max(0, run.metrics.outputTokens - run.metrics.reasoningOutputTokens);
  if (key === 'costUsd') return price ? costUsd(run.metrics, price) : 0;
  return run.metrics[key];
}

export function summarize(runs: CompletedRun[], prices: PriceTable = {}) {
  const models = [...new Set(runs.map((run) => run.model))];
  const result: Record<string, any> = {};
  for (const model of models) {
    const price = prices[model];
    const keys = price ? METRICS : METRICS.filter((key) => key !== 'costUsd');
    const modelRuns = runs.filter((run) => run.model === model && run.exitCode === 0);
    const arms: Record<Arm, any> = { on: {}, off: {} };
    for (const arm of ['on', 'off'] as const) {
      const subset = modelRuns.filter((run) => run.arm === arm);
      arms[arm].runs = subset.length;
      for (const key of keys) arms[arm][key] = subset.reduce((sum, run) => sum + metricValue(run, key, price), 0);
      const rollouts = subset.flatMap((run) => run.rollout ? [run.rollout] : []);
      arms[arm].rollouts = rollouts.length;
      arms[arm].modelCalls = rollouts.reduce((sum, rollout) => sum + rollout.modelCalls, 0);
      arms[arm].startInputTokens = rollouts.reduce((sum, rollout) => sum + rollout.startInputTokens, 0);
      arms[arm].peakInputTokens = rollouts.reduce((sum, rollout) => sum + rollout.peakInputTokens, 0);
      arms[arm].coldStarts = rollouts.filter((rollout) => rollout.startCachedInputTokens === 0).length;
      arms[arm].recallCorrect = subset.filter((run) => run.metrics.recallCorrect).length;
      const memoryRuns = subset.filter((run) => run.task.expectedIssue !== null);
      const controlRuns = subset.filter((run) => run.task.expectedIssue === null);
      arms[arm].memoryEligible = memoryRuns.length;
      // Model side only: the ledger side for Codex is ampOnLedgerCheck (exact three-issue injection).
      arms[arm].memoryCited = memoryRuns.filter((run) => run.metrics.recallCorrect).length;
      arms[arm].controlNone = controlRuns.filter((run) => run.metrics.recallCorrect).length;
      arms[arm].controls = controlRuns.length;
      arms[arm].signalHits = subset.reduce((sum, run) => sum + run.metrics.signalHits, 0);
      arms[arm].signalTotal = subset.reduce((sum, run) => sum + run.metrics.signalTotal, 0);
      arms[arm].commandFailures = subset.reduce((sum, run) => sum + run.metrics.commandFailures, 0);
    }
    const ampOnRuns = runs.filter((run) => run.model === model && run.arm === 'on');
    const ampOnLedgers = ampOnRuns.filter((run) => run.ledger && typeof run.ledger === 'object');
    const exactInjectedLedgers = ampOnRuns.filter((run) => hasExactInjectedLedger(run.ledger)).length;
    const change: Record<string, number | null> = {};
    for (const key of keys) {
      const off = arms.off[key];
      change[key] = off === 0 ? null : ((arms.on[key] - off) / off) * 100;
    }
    const successfulPairs = [...new Set(modelRuns.map((run) => run.pair))].flatMap((pair) => {
      const on = modelRuns.find((run) => run.pair === pair && run.arm === 'on');
      const off = modelRuns.find((run) => run.pair === pair && run.arm === 'off');
      return on && off ? [{ pair, on, off }] : [];
    });
    const pairedLower: Record<string, number> = {};
    for (const key of keys) {
      pairedLower[key] = successfulPairs.filter(({ on, off }) => metricValue(on, key, price) < metricValue(off, key, price)).length;
    }
    result[model] = {
      price: price ?? null,
      arms,
      pairs: successfulPairs.length,
      ampOnVsOffPercent: change,
      ampOnLowerPairs: pairedLower,
      ampOnLedgerCheck: {
        cases: ampOnRuns.length,
        ledgers: ampOnLedgers.length,
        exactInjectedIssues: exactInjectedLedgers,
        expectedIssues: [...EXPECTED_INJECTED_ISSUES],
      },
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    rulesVersions: [...new Set(runs.map((run) => run.rulesVersion ?? 1))].sort((a, b) => a - b),
    completedRuns: runs.filter((run) => run.exitCode === 0).length,
    failedRuns: runs.filter((run) => run.exitCode !== 0).length,
    models: result,
  };
}

export function renderReport(summary: ReturnType<typeof summarize>): string {
  const lines = [
    '# Codex AMP A/B Benchmark',
    '',
    `Generated: ${summary.generatedAt}`,
    `Successful cases: ${summary.completedRuns}; failed attempts: ${summary.failedRuns}`,
    `Delivery level: ${(summary as any).deliveryLevel ?? 'L1'}`,
    `Reasoning: ${(summary as any).reasoning ?? 'n/a'}`,
    `Memory snapshot commit: ${(summary as any).memorySnapshotCommit ?? 'n/a'}`,
    `Project commit: ${(summary as any).projectCommit ?? 'n/a'}`,
    `Hook trust: ${(summary as any).hookTrust ?? 'not applicable'}`,
    `Prompt rules: v${(summary.rulesVersions ?? [1]).join(', v')}`,
    `Codex flags: ${(summary as any).codexFlags ?? 'not recorded'}`,
    `Prices: ${(summary as any).priceSource ?? 'none'}`,
    '',
    '| Model | Pairs | Input tokens Δ | Uncached input Δ | Tool output Δ | Time Δ | Input lower | Cited (model) | Control none (model) | Injected ledgers exact | Signal coverage on/off |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [model, data] of Object.entries(summary.models) as [string, any][]) {
    const p = data.ampOnVsOffPercent;
    const check = data.ampOnLedgerCheck ?? { cases: 0, exactInjectedIssues: 0 };
    lines.push(`| ${model} | ${data.pairs} | ${pct(p.inputTokens)} | ${pct(p.uncachedInputTokens)} | ${pct(p.toolOutputBytes)} | ${pct(p.durationMs)} | ${data.ampOnLowerPairs.inputTokens}/${data.pairs} | ${data.arms.on.memoryCited}/${data.arms.on.memoryEligible} | ${data.arms.on.controlNone}/${data.arms.on.controls} | ${check.exactInjectedIssues}/${check.cases} | ${data.arms.on.signalHits}/${data.arms.on.signalTotal} vs ${data.arms.off.signalHits}/${data.arms.off.signalTotal} |`);
  }
  lines.push(
    '',
    '## Cost and output composition',
    '',
    '| Model | Price in / cached / out ($/1M) | Cost per case on / off | Cost Δ | Cost lower | Output Δ | Reasoning Δ | Visible output Δ | Reasoning share on / off |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  );
  for (const [model, data] of Object.entries(summary.models) as [string, any][]) {
    const p = data.ampOnVsOffPercent;
    const { on, off } = data.arms;
    const price = data.price ? `$${data.price.input} / $${data.price.cachedInput} / $${data.price.output}` : 'n/a';
    const cost = data.price ? `${usd(perCase(on.costUsd, on.runs))} / ${usd(perCase(off.costUsd, off.runs))}` : 'n/a';
    const costLower = data.price ? `${data.ampOnLowerPairs.costUsd}/${data.pairs}` : 'n/a';
    lines.push(`| ${model} | ${price} | ${cost} | ${pct(p.costUsd)} | ${costLower} | ${pct(p.outputTokens)} | ${pct(p.reasoningOutputTokens)} | ${pct(p.visibleOutputTokens)} | ${share(on.reasoningOutputTokens, on.outputTokens)} / ${share(off.reasoningOutputTokens, off.outputTokens)} |`);
  }
  const withRollouts = Object.entries(summary.models).filter(([, data]: [string, any]) => data.arms.on.rollouts + data.arms.off.rollouts > 0);
  if (withRollouts.length > 0) {
    lines.push(
      '',
      '## Per-call telemetry (Codex rollouts)',
      '',
      '| Model | Rollouts on/off | Model calls per case on / off | Start input on / off | Peak input on / off | Cold starts on / off |',
      '|---|---:|---:|---:|---:|---:|',
    );
    for (const [model, data] of withRollouts as [string, any][]) {
      const { on, off } = data.arms;
      lines.push(`| ${model} | ${on.rollouts}/${off.rollouts} | ${mean(on.modelCalls, on.rollouts, 1)} / ${mean(off.modelCalls, off.rollouts, 1)} | ${mean(on.startInputTokens, on.rollouts)} / ${mean(off.startInputTokens, off.rollouts)} | ${mean(on.peakInputTokens, on.rollouts)} / ${mean(off.peakInputTokens, off.rollouts)} | ${on.coldStarts}/${on.rollouts} / ${off.coldStarts}/${off.rollouts} |`);
    }
  }
  lines.push('', 'Negative percentages mean AMP used less than the disabled arm.', 'Cited (model) and Control none (model) read the answer\'s Recall used: line; Injected ledgers exact is the hooks\' side (L2 only). Prompt rules v2 is the shared hook-delivered wording; v1 is the L1 variant that tells the model to honour AMP_DISABLE itself.', 'Token counts come directly from Codex `turn.completed` usage. `cached_input_tokens` is a subset of `input_tokens`; uncached input is their difference.',
    'Cost is the API-equivalent at the listed prices: uncached input × input + cached input × cached + output × output. `output_tokens` already includes `reasoning_output_tokens`, so reasoning is billed once at the output rate; visible output is their difference. A ChatGPT-plan run is not billed per token, so the column says what the same traffic would cost on the API.',
    'Rollout columns are per-case means from `last_token_usage` in each session rollout (--rollouts). A cold start is a first model call with no cached input: the prompt cache did not hold the prefix. Arm order alternates by pair so cold starts should fall on both arms; the column checks that.',
    'Signal coverage is a deterministic keyword check, not an independent answer-quality grade.', '');
  return lines.join('\n');
}

function perCase(total: number, runs: number): number {
  return runs > 0 ? total / runs : NaN;
}

function usd(value: number): string {
  return Number.isFinite(value) ? `$${value.toFixed(4)}` : 'n/a';
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : 'n/a';
}

function mean(total: number, count: number, digits = 0): string {
  return count > 0 ? (total / count).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : 'n/a';
}

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-z0-9.-]+/gi, '-');
}

function loadSessionLedger(outDir: string, sessionId: string): unknown | null {
  if (!sessionId) return null;
  const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const ledgerPath = join(outDir, 'amp-home', 'sessions', `${safeId}.json`);
  if (!existsSync(ledgerPath)) return null;
  try { return JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch { return null; }
}

function getCommit(path: string): string {
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function runOne(
  run: PlannedRun,
  project: string,
  memoryRepo: string,
  memorySlug: string,
  outDir: string,
  timeoutMinutes: number,
  hooks: boolean,
  codexHome: string | null,
  rollouts: boolean,
): Promise<CompletedRun> {
  const args = buildCodexArgs(run, project, hooks, rollouts);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RXAI_AMP_REPO: memoryRepo,
    RXAI_AMP_SLUG: memorySlug,
    RXAI_AMP_AGENT: 'codex',
  };
  if (codexHome) env.CODEX_HOME = codexHome;
  if (hooks) env.RXAI_AMP_HOME = join(outDir, 'amp-home');
  if (run.arm === 'off') env.AMP_DISABLE = '1';
  else delete env.AMP_DISABLE;

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const child = spawn(process.env.CODEX_BIN ?? 'codex', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMinutes * 60_000);
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  }).finally(() => clearTimeout(timer));
  const finishedAt = new Date().toISOString();
  const jsonl = Buffer.concat(stdout).toString('utf8');
  const err = Buffer.concat(stderr).toString('utf8');
  writeFileSync(join(outDir, `${run.id}.jsonl`), jsonl);
  writeFileSync(join(outDir, `${run.id}.stderr.txt`), err);
  const metrics = parseCodexJsonl(jsonl, run.task, Date.now() - started);
  const answer = [...jsonl.split('\n')].reverse().map((line) => {
    try { const event = JSON.parse(line); return event?.item?.type === 'agent_message' ? String(event.item.text ?? '') : ''; }
    catch { return ''; }
  }).find(Boolean) ?? '';
  writeFileSync(join(outDir, `${run.id}.answer.md`), answer);
  const completed: CompletedRun = { ...run, startedAt, finishedAt, exitCode, metrics, rulesVersion: rulesFor(hooks ? 'L2' : 'L1').version };
  if (hooks) completed.ledger = loadSessionLedger(outDir, metrics.threadId);
  if (rollouts && codexHome) {
    const rolloutPath = findRollout(codexHome, metrics.threadId);
    if (rolloutPath) {
      copyFileSync(rolloutPath, join(outDir, `${run.id}.rollout.jsonl`));
      completed.rollout = parseCodexRollout(readFileSync(rolloutPath, 'utf8'));
    } else {
      completed.rollout = null;
      process.stdout.write(`[warn] no rollout for thread ${metrics.threadId || '(none)'} under ${join(codexHome, 'sessions')}\n`);
    }
  }
  return completed;
}

function loadCompleted(path: string): CompletedRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as CompletedRun]; } catch { return []; }
  });
}

function writeSummary(outDir: string, summary: ReturnType<typeof summarize>): void {
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), renderReport(summary));
  process.stdout.write(renderReport(summary));
}

/**
 * Re-summarize a finished run directory with the current prices and report
 * layout. Spends no tokens: results.ndjson is the data, and the run metadata
 * (delivery level, commits, flags) is carried over from the old summary.json.
 */
function reportOnly(outDir: string, prices: ReturnType<typeof loadPrices>): void {
  const resultsPath = join(outDir, 'results.ndjson');
  const latestById = new Map<string, CompletedRun>();
  for (const run of loadCompleted(resultsPath)) latestById.set(run.id, run);
  if (latestById.size === 0) throw new Error(`no results in ${resultsPath}`);
  const summaryPath = join(outDir, 'summary.json');
  const previous = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : {};
  writeSummary(outDir, { ...previous, ...summarize([...latestById.values()], prices.models), priceSource: prices.source });
}

async function main() {
  requireModelArgumentValue(process.argv.slice(2));
  const { values } = parseArgs({
    options: {
      cases: { type: 'string', default: '20' },
      models: { type: 'string' },
      reasoning: { type: 'string', default: 'medium' },
      project: { type: 'string' },
      'memory-repo': { type: 'string' },
      'memory-slug': { type: 'string' },
      hooks: { type: 'boolean', default: false },
      rollouts: { type: 'boolean', default: false },
      prices: { type: 'string' },
      'report-only': { type: 'boolean', default: false },
      out: { type: 'string', default: join(process.cwd(), 'data', 'codex-amp-ab', 'latest') },
      timeout: { type: 'string', default: '12' },
    },
  });
  const prices = loadPrices(values.prices);
  if (values['report-only']) {
    reportOnly(resolve(values.out!), prices);
    return;
  }
  const models = parseModels(values.models);
  const schedule = buildSchedule(models, values.reasoning!, Number(values.cases), loadTasks());
  if (!values.project) throw new Error('--project is required');
  const project = resolve(values.project);
  const outDir = resolve(values.out!);
  const ampConfigPath = join(homedir(), '.rxai-amp', 'config.json');
  const ampConfig = existsSync(ampConfigPath) ? JSON.parse(readFileSync(ampConfigPath, 'utf8')) : {};
  const configuredRepo = ampConfig?.memory_repo ?? {};
  const memoryRepoValue = values['memory-repo'] ?? configuredRepo.local_clone;
  const memorySlug = values['memory-slug'] ?? (
    configuredRepo.owner && configuredRepo.name ? `${configuredRepo.owner}/${configuredRepo.name}` : ''
  );
  if (!memoryRepoValue) throw new Error('--memory-repo is required when AMP config has no local clone');
  if (!memorySlug) throw new Error('--memory-slug is required when AMP config has no owner/name');
  const memoryRepo = resolve(memoryRepoValue);
  const cacheDir = join(memoryRepo, '.rxai-cache');
  if (!existsSync(project)) throw new Error(`project not found: ${project}`);
  if (!existsSync(cacheDir)) throw new Error(`AMP cache not found: ${cacheDir}; run cache:sync first`);
  const codexHome = values.hooks || values.rollouts
    ? validateIsolatedHome(process.env.CODEX_HOME, values.hooks ? '--hooks' : '--rollouts')
    : null;
  const memorySnapshotCommit = getCommit(memoryRepo);
  const projectCommit = getCommit(project);
  mkdirSync(outDir, { recursive: true });
  const resultsPath = join(outDir, 'results.ndjson');
  const completed = loadCompleted(resultsPath);
  if (values.hooks) {
    const invalidLedger = completed.find((run) => run.exitCode === 0 && (
      run.arm === 'on' ? !hasExactInjectedLedger(run.ledger) : Boolean(run.ledger)
    ));
    if (invalidLedger) {
      throw new Error(`L2 resume refused: ledger check failed for ${invalidLedger.id}`);
    }
  }
  const completedIds = new Set(completed.filter((run) => run.exitCode === 0).map((run) => run.id));
  let l2InjectionFailed = false;

  for (const [index, run] of schedule.entries()) {
    if (completedIds.has(run.id)) {
      process.stdout.write(`[${index + 1}/${schedule.length}] skip ${run.id}\n`);
      continue;
    }
    process.stdout.write(`[${index + 1}/${schedule.length}] start ${run.id}\n`);
    const result = await runOne(run, project, memoryRepo, memorySlug, outDir, Number(values.timeout), values.hooks!, codexHome, values.rollouts!);
    appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
    completed.push(result);
    const mt = result.metrics;
    const price = prices.models[run.model];
    const calls = result.rollout ? ` calls=${result.rollout.modelCalls} start=${result.rollout.startInputTokens}${result.rollout.startCachedInputTokens === 0 ? '(cold)' : ''}` : '';
    process.stdout.write(`[${index + 1}/${schedule.length}] done ${run.id} exit=${result.exitCode} input=${mt.inputTokens} cached=${mt.cachedInputTokens} out=${mt.outputTokens} reason=${mt.reasoningOutputTokens}${calls} tools=${mt.commandCalls} time=${Math.round(mt.durationMs / 1000)}s${price ? ` cost=$${costUsd(mt, price).toFixed(4)}` : ''} recall=${mt.recallLine || 'missing'}\n`);
    if (values.hooks && run.arm === 'on' && !hasExactInjectedLedger(result.ledger)) {
      process.stdout.write(`[stopped] L2 SessionStart did not ledger exactly ${EXPECTED_INJECTED_ISSUES.map((n) => `#${n}`).join(', ')} via inject for ${run.id}\n`);
      l2InjectionFailed = true;
      break;
    }
    if (values.hooks && run.arm === 'off' && result.ledger) {
      process.stdout.write(`[stopped] AMP-off session unexpectedly created a ledger for ${run.id}\n`);
      l2InjectionFailed = true;
      break;
    }
    if (result.exitCode !== 0 && /usage limit|rate limit|quota/i.test(result.metrics.failureMessage)) {
      process.stdout.write(`[paused] ${result.metrics.failureMessage}\n`);
      break;
    }
  }

  const latestById = new Map<string, CompletedRun>();
  for (const run of completed) latestById.set(run.id, run);
  const finalRuns = schedule.map((run) => latestById.get(run.id)).filter((run): run is CompletedRun => Boolean(run));
  const summary = {
    ...summarize(finalRuns, prices.models),
    deliveryLevel: values.hooks ? 'L2' : 'L1',
    reasoning: values.reasoning!,
    memorySnapshotCommit,
    projectCommit,
    hookTrust: values.hooks
      ? 'Pre-vetted isolated CODEX_HOME; --dangerously-bypass-hook-trust passed to each codex exec.'
      : 'not applicable',
    codexFlags: codexFlags(buildCodexArgs(schedule[0], project, values.hooks!, values.rollouts!)),
    priceSource: prices.source,
  };
  writeSummary(outDir, summary);
  if (l2InjectionFailed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`benchmark error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
