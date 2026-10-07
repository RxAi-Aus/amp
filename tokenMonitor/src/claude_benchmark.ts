import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildSchedule, loadTasks, type Arm, type PlannedRun, type TaskDefinition } from './codex_benchmark.js';
import { RULES, RULES_VERSION } from './prompt_rules.js';

/**
 * Claude Code AMP A/B benchmark — the L2 (hook-delivered) counterpart of
 * codex_benchmark.ts. One case is one fresh `claude -p` session over the
 * project under test; the AMP-on arm runs the installed SessionStart /
 * PostToolUse / Stop hooks, the AMP-off arm sets AMP_DISABLE=1 so the same
 * hooks become no-ops. Prompts, tool allowlist and model are identical.
 *
 * Usage comes from the `assistant` events (one per API call: input,
 * cache-creation, cache-read, output) and the final `result` event (wall time,
 * turn count, list-price cost as Claude Code reports it).
 */

export interface ClaudeRunMetrics {
  contextTokens: number;          // Σ per-call (input + cache_creation + cache_read): total context processed
  uncachedInputTokens: number;    // Σ (input + cache_creation)
  cachedInputTokens: number;      // Σ cache_read
  outputTokens: number;
  thinkingTokens: number;
  startContextTokens: number;     // context of the first API call (system prompt + injected recall)
  apiCalls: number;               // assistant messages
  numTurns: number;               // as reported by the result event
  stopTailCalls: number;          // assistant messages after the answer (a Stop-hook block shows up here)
  toolCalls: number;
  readCalls: number;              // Read + Grep + Glob
  bashCalls: number;
  toolDenials: number;            // tool_result marked is_error (permission denials, failed commands)
  toolOutputBytes: number;        // tool_result bytes up to and including the answer
  durationMs: number;             // wall time measured by the runner
  apiDurationMs: number;
  costUsd: number;
  recallLine: string;
  citedIssues: number[];
  recallCorrect: boolean;
  signalHits: number;
  signalTotal: number;
  answerChars: number;
  sessionId: string;
  isError: boolean;
  failureMessage: string;
}

export interface ClaudeCompletedRun extends PlannedRun {
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  ledger: unknown;
  metrics: ClaudeRunMetrics;
  rulesVersion?: number;          // absent on runs recorded before RULES_VERSION existed (= v1)
}

/** One record the session ledger says the hooks injected, and at which tier. */
export interface InjectedRecord { issue: number; tier: string }

/**
 * What the AMP-on session's ledger says reached the context. `via: "inject"`
 * entries only — records the agent fetched itself are not recall. A missing
 * `tier` is a pre-v2.11 ledger, where session start injected the summary tier.
 */
export function injectedFromLedger(ledger: unknown): InjectedRecord[] {
  const surfaced = (ledger as any)?.recall?.surfaced;
  if (!Array.isArray(surfaced)) return [];
  return surfaced
    .filter((entry: any) => entry?.via === 'inject' && Number.isFinite(Number(entry?.issue)))
    .map((entry: any) => ({ issue: Number(entry.issue), tier: typeof entry?.tier === 'string' ? entry.tier : 'summary' }));
}

/**
 * The tier at which the task's expected issue reached the context per the
 * ledger: 'summary' (its excerpt was in context), 'pointer' (title only — the
 * prompt stage did not expand it), or null (never injected, or a control task).
 */
export function expectedInjectionTier(ledger: unknown, task: TaskDefinition): string | null {
  if (task.expectedIssue === null) return null;
  const hits = injectedFromLedger(ledger).filter((record) => record.issue === task.expectedIssue);
  if (hits.length === 0) return null;
  return hits.some((record) => record.tier === 'summary') ? 'summary' : hits[0].tier;
}

// Prompt rules and their version live in prompt_rules.ts, shared with the Codex
// runner; this runner is always hook-delivered (L2).
export { RULES, RULES_VERSION };

export const ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(tree:*)',
  'Bash(rg:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(sed -n:*)',
  'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git branch:*)',
];
export const DISALLOWED_TOOLS = [
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'Skill', 'Workflow', 'ToolSearch',
];

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => (block?.type === 'text' ? String(block.text ?? '') : '')).join('');
}

function bytesOf(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, block: any) => {
    if (block?.type === 'text') return sum + Buffer.byteLength(String(block.text ?? ''), 'utf8');
    return sum + Buffer.byteLength(JSON.stringify(block ?? ''), 'utf8');
  }, 0);
}

export function parseClaudeJsonl(jsonl: string, task: TaskDefinition, durationMs: number): ClaudeRunMetrics {
  const m: ClaudeRunMetrics = {
    contextTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0,
    startContextTokens: 0, apiCalls: 0, numTurns: 0, stopTailCalls: 0,
    toolCalls: 0, readCalls: 0, bashCalls: 0, toolDenials: 0, toolOutputBytes: 0,
    durationMs, apiDurationMs: 0, costUsd: 0,
    recallLine: '', citedIssues: [], recallCorrect: false, signalHits: 0, signalTotal: task.signals.length,
    answerChars: 0, sessionId: '', isError: false, failureMessage: '',
  };
  // First pass: find the answer (last assistant message carrying a Recall line,
  // else the last assistant text) so tool output can be counted up to it.
  const events: any[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { events.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  let answerIndex = -1;
  let lastTextIndex = -1;
  events.forEach((event, index) => {
    if (event.type !== 'assistant') return;
    const text = textOf(event.message?.content);
    if (text.trim()) lastTextIndex = index;
    if (/^Recall used:/im.test(text)) answerIndex = index;
  });
  if (answerIndex < 0) answerIndex = lastTextIndex;
  let answer = '';

  events.forEach((event, index) => {
    if (event.type === 'system' && event.subtype === 'init') m.sessionId = String(event.session_id ?? '');
    if (event.type === 'assistant') {
      const usage = event.message?.usage ?? {};
      const input = Number(usage.input_tokens ?? 0);
      const created = Number(usage.cache_creation_input_tokens ?? 0);
      const read = Number(usage.cache_read_input_tokens ?? 0);
      if (m.apiCalls === 0) m.startContextTokens = input + created + read;
      m.apiCalls += 1;
      m.contextTokens += input + created + read;
      m.uncachedInputTokens += input + created;
      m.cachedInputTokens += read;
      m.outputTokens += Number(usage.output_tokens ?? 0);
      if (index > answerIndex && answerIndex >= 0) m.stopTailCalls += 1;
      for (const block of event.message?.content ?? []) {
        if (block?.type !== 'tool_use') continue;
        m.toolCalls += 1;
        if (['Read', 'Grep', 'Glob'].includes(block.name)) m.readCalls += 1;
        if (block.name === 'Bash') m.bashCalls += 1;
      }
      if (index === answerIndex) answer = textOf(event.message?.content);
    }
    if (event.type === 'user') {
      const content = event.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        if (block.is_error) m.toolDenials += 1;
        if (answerIndex < 0 || index < answerIndex) m.toolOutputBytes += bytesOf(block.content);
      }
    }
    if (event.type === 'result') {
      m.numTurns = Number(event.num_turns ?? 0);
      m.apiDurationMs = Number(event.duration_api_ms ?? 0);
      m.costUsd = Number(event.total_cost_usd ?? 0);
      m.thinkingTokens = Number(event.usage?.output_tokens_details?.thinking_tokens ?? 0);
      m.isError = Boolean(event.is_error);
      if (event.is_error || event.subtype !== 'success') m.failureMessage = String(event.subtype ?? '') + (event.result ? `: ${String(event.result).slice(0, 300)}` : '');
    }
  });

  const recallMatch = answer.match(/^Recall used:\s*([^\n]+)$/im);
  m.recallLine = recallMatch?.[1]?.trim() ?? '';
  m.citedIssues = [...m.recallLine.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
  m.recallCorrect = task.expectedIssue === null
    ? /\bnone\b/i.test(m.recallLine) && m.citedIssues.length === 0
    : m.citedIssues.includes(task.expectedIssue);
  const lower = answer.toLowerCase();
  m.signalHits = task.signals.filter((signal) => lower.includes(signal.toLowerCase())).length;
  m.answerChars = answer.length;
  return m;
}

type MetricKey = 'contextTokens' | 'uncachedInputTokens' | 'cachedInputTokens' | 'outputTokens' | 'toolOutputBytes' | 'toolCalls' | 'readCalls' | 'apiCalls' | 'durationMs' | 'costUsd';
export const CLAUDE_METRICS: MetricKey[] = ['contextTokens', 'uncachedInputTokens', 'cachedInputTokens', 'outputTokens', 'toolOutputBytes', 'toolCalls', 'readCalls', 'apiCalls', 'durationMs', 'costUsd'];

export function summarizeClaude(runs: ClaudeCompletedRun[]) {
  const models = [...new Set(runs.map((run) => run.model))];
  const result: Record<string, any> = {};
  for (const model of models) {
    const modelRuns = runs.filter((run) => run.model === model && run.exitCode === 0 && !run.metrics.isError);
    const arms: Record<Arm, any> = { on: {}, off: {} };
    for (const arm of ['on', 'off'] as const) {
      const subset = modelRuns.filter((run) => run.arm === arm);
      arms[arm].runs = subset.length;
      for (const key of CLAUDE_METRICS) arms[arm][key] = subset.reduce((sum, run) => sum + run.metrics[key], 0);
      arms[arm].startContextTokens = subset.length ? Math.round(subset.reduce((sum, run) => sum + run.metrics.startContextTokens, 0) / subset.length) : 0;
      arms[arm].stopTailCalls = subset.reduce((sum, run) => sum + run.metrics.stopTailCalls, 0);
      arms[arm].stopBlocked = subset.filter((run) => run.metrics.stopTailCalls > 0).length;
      arms[arm].toolDenials = subset.reduce((sum, run) => sum + run.metrics.toolDenials, 0);
      const memoryRuns = subset.filter((run) => run.task.expectedIssue !== null);
      const controlRuns = subset.filter((run) => run.task.expectedIssue === null);
      arms[arm].memoryEligible = memoryRuns.length;
      // Ledger side: did the hooks deliver the expected record, and at which tier.
      arms[arm].memoryInjected = memoryRuns.filter((run) => expectedInjectionTier(run.ledger, run.task) !== null).length;
      arms[arm].memorySummaryInjected = memoryRuns.filter((run) => expectedInjectionTier(run.ledger, run.task) === 'summary').length;
      // Model side: did the answer's Recall line name it.
      arms[arm].memoryCited = memoryRuns.filter((run) => run.metrics.recallCorrect).length;
      arms[arm].controls = controlRuns.length;
      // Ledger side for controls: nothing expanded to the summary tier.
      arms[arm].controlSilent = controlRuns.filter((run) => !injectedFromLedger(run.ledger).some((record) => record.tier === 'summary')).length;
      // Model side for controls: the answer said none.
      arms[arm].controlNone = controlRuns.filter((run) => run.metrics.recallCorrect).length;
      arms[arm].signalHits = subset.reduce((sum, run) => sum + run.metrics.signalHits, 0);
      arms[arm].signalTotal = subset.reduce((sum, run) => sum + run.metrics.signalTotal, 0);
    }
    const change: Record<string, number | null> = {};
    for (const key of CLAUDE_METRICS) {
      const off = arms.off[key];
      change[key] = off === 0 ? null : ((arms.on[key] - off) / off) * 100;
    }
    const pairs = [...new Set(modelRuns.map((run) => run.pair))].flatMap((pair) => {
      const on = modelRuns.find((run) => run.pair === pair && run.arm === 'on');
      const off = modelRuns.find((run) => run.pair === pair && run.arm === 'off');
      return on && off ? [{ pair, on, off }] : [];
    });
    const pairedLower: Record<string, number> = {};
    for (const key of CLAUDE_METRICS) pairedLower[key] = pairs.filter(({ on, off }) => on.metrics[key] < off.metrics[key]).length;
    const byTask: Record<string, any> = {};
    for (const task of [...new Set(modelRuns.map((run) => run.task.id))]) {
      byTask[task] = { on: [], off: [] };
      for (const run of modelRuns.filter((run) => run.task.id === task)) {
        byTask[task][run.arm].push({
          pair: run.pair, toolOutputBytes: run.metrics.toolOutputBytes, readCalls: run.metrics.readCalls, toolCalls: run.metrics.toolCalls,
          startContextTokens: run.metrics.startContextTokens, contextTokens: run.metrics.contextTokens, apiCalls: run.metrics.apiCalls,
          durationMs: run.metrics.durationMs, costUsd: run.metrics.costUsd, recallLine: run.metrics.recallLine, stopTailCalls: run.metrics.stopTailCalls,
          injected: injectedFromLedger(run.ledger).map((record) => `#${record.issue}:${record.tier}`),
          expectedInjectionTier: expectedInjectionTier(run.ledger, run.task),
        });
      }
    }
    const effort = [...new Set(modelRuns.map((run) => run.reasoning))].join(', ') || 'n/a';
    result[model] = { effort, arms, pairs: pairs.length, ampOnVsOffPercent: change, ampOnLowerPairs: pairedLower, byTask };
  }
  return {
    generatedAt: new Date().toISOString(),
    rulesVersions: [...new Set(runs.map((run) => run.rulesVersion ?? 1))].sort((a, b) => a - b),
    completedRuns: runs.filter((run) => run.exitCode === 0 && !run.metrics.isError).length,
    failedRuns: runs.filter((run) => run.exitCode !== 0 || run.metrics.isError).length,
    models: result,
  };
}

export function renderClaudeReport(summary: ReturnType<typeof summarizeClaude>): string {
  const lines = [
    '# Claude Code AMP A/B Benchmark',
    '',
    `Generated: ${summary.generatedAt}`,
    `Successful cases: ${summary.completedRuns}; failed attempts: ${summary.failedRuns}`,
    `Prompt rules: v${summary.rulesVersions.join(', v')}`,
    '',
    '| Model | Effort | Pairs | Context Δ | Uncached input Δ | Tool output Δ | Reads Δ | Time Δ | Cost Δ | Cost lower | Start ctx on/off | Stop blocked | Injected (ledger) | Cited (model) | Control silent (ledger) | Control none (model) | Signal coverage on/off |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [model, data] of Object.entries(summary.models) as [string, any][]) {
    const p = data.ampOnVsOffPercent;
    lines.push(`| ${model} | ${data.effort} | ${data.pairs} | ${pct(p.contextTokens)} | ${pct(p.uncachedInputTokens)} | ${pct(p.toolOutputBytes)} | ${pct(p.readCalls)} | ${pct(p.durationMs)} | ${pct(p.costUsd)} | ${data.ampOnLowerPairs.costUsd}/${data.pairs} | ${data.arms.on.startContextTokens}/${data.arms.off.startContextTokens} | ${data.arms.on.stopBlocked}/${data.arms.on.runs} | ${injectedCell(data.arms.on)} | ${data.arms.on.memoryCited}/${data.arms.on.memoryEligible} | ${data.arms.on.controlSilent}/${data.arms.on.controls} | ${data.arms.on.controlNone}/${data.arms.on.controls} | ${data.arms.on.signalHits}/${data.arms.on.signalTotal} vs ${data.arms.off.signalHits}/${data.arms.off.signalTotal} |`);
  }
  lines.push('', 'Negative percentages mean AMP used less than the disabled arm.',
    'Context = Σ per API call (input + cache creation + cache read). Cost is the list-price estimate Claude Code reports in its result event.',
    'Injected (ledger) = memory tasks whose expected issue the AMP-on ledger records as injected at the summary tier (title-only listings noted as pointer); Cited (model) = those whose answer names it on the Recall used: line. They differ when the model had the summary and did not attribute it.',
    'Control silent (ledger) = control tasks where nothing reached the summary tier; Control none (model) = control answers that said none.',
    'Signal coverage is a deterministic keyword check, not an independent answer-quality grade.', '');
  return lines.join('\n');
}

function injectedCell(arm: any): string {
  const pointerOnly = arm.memoryInjected - arm.memorySummaryInjected;
  return `${arm.memorySummaryInjected}/${arm.memoryEligible}${pointerOnly > 0 ? ` (+${pointerOnly} pointer)` : ''}`;
}

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

async function runOne(run: PlannedRun, project: string, memoryRepo: string | null, outDir: string, timeoutMinutes: number, effort: string | undefined): Promise<ClaudeCompletedRun> {
  const prompt = `${RULES}\n\nQuestion: ${run.task.question}`;
  const args = [
    '-p', '--model', run.model, '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--setting-sources', 'user', '--no-session-persistence', '--permission-mode', 'default',
    '--allowedTools', ...ALLOWED_TOOLS, '--disallowedTools', ...DISALLOWED_TOOLS,
  ];
  if (effort) args.push('--effort', effort);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (memoryRepo) env.RXAI_AMP_REPO = memoryRepo;
  if (run.arm === 'off') env.AMP_DISABLE = '1';
  else delete env.AMP_DISABLE;

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const child = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(prompt);
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
  writeFileSync(join(outDir, `${run.id}.jsonl`), jsonl);
  writeFileSync(join(outDir, `${run.id}.stderr.txt`), Buffer.concat(stderr).toString('utf8'));
  const metrics = parseClaudeJsonl(jsonl, run.task, Date.now() - started);
  const answerEvent = [...jsonl.split('\n')].reverse().map((line) => {
    try { const event = JSON.parse(line); return event?.type === 'assistant' ? textOf(event.message?.content) : ''; } catch { return ''; }
  }).find((text) => /^Recall used:/im.test(text)) ?? '';
  writeFileSync(join(outDir, `${run.id}.answer.md`), answerEvent);
  let ledger: unknown = null;
  if (metrics.sessionId) {
    const ledgerPath = join(process.env.RXAI_AMP_HOME ?? join(homedir(), '.rxai-amp'), 'sessions', `${metrics.sessionId}.json`);
    if (existsSync(ledgerPath)) {
      try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch { ledger = null; }
    }
  }
  return { ...run, startedAt, finishedAt, exitCode, ledger, metrics, rulesVersion: RULES_VERSION };
}

export const EFFORT_UNSET = 'unset';

/**
 * --models has no default: a benchmark result is only meaningful next to the
 * model that produced it, and a silent default is how a run ends up measuring
 * something other than what its report names.
 */
export function parseModels(value: string | undefined): string[] {
  const models = (value ?? '').split(',').map((model) => model.trim()).filter(Boolean);
  if (models.length === 0) {
    throw new Error('--models is required, e.g. --models claude-opus-5-5 (comma-separate several to interleave them)');
  }
  return models;
}

function loadCompleted(path: string): ClaudeCompletedRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as ClaudeCompletedRun]; } catch { return []; }
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      cases: { type: 'string', default: '16' },
      models: { type: 'string' },
      effort: { type: 'string' },
      project: { type: 'string' },
      'memory-repo': { type: 'string' },
      out: { type: 'string', default: join(process.cwd(), 'data', 'claude-amp-ab', 'latest') },
      timeout: { type: 'string', default: '15' },
    },
  });
  const models = parseModels(values.models);
  const schedule = buildSchedule(models, values.effort ?? EFFORT_UNSET, Number(values.cases), loadTasks());
  process.stdout.write(`models: ${models.join(', ')} · effort: ${values.effort ?? `${EFFORT_UNSET} (Claude Code resolves it from user settings; not recorded)`}\n`);
  if (!values.project) throw new Error('--project is required');
  const project = resolve(values.project);
  const outDir = resolve(values.out!);
  const memoryRepo = values['memory-repo'] ? resolve(values['memory-repo']) : null;
  if (!existsSync(project)) throw new Error(`project not found: ${project}`);
  if (memoryRepo && !existsSync(join(memoryRepo, 'INDEX.md'))) throw new Error(`memory repo has no INDEX.md: ${memoryRepo}`);
  mkdirSync(outDir, { recursive: true });
  const resultsPath = join(outDir, 'results.ndjson');
  const completed = loadCompleted(resultsPath);
  const completedIds = new Set(completed.filter((run) => run.exitCode === 0 && !run.metrics.isError).map((run) => run.id));

  for (const [index, run] of schedule.entries()) {
    if (completedIds.has(run.id)) {
      process.stdout.write(`[${index + 1}/${schedule.length}] skip ${run.id}\n`);
      continue;
    }
    process.stdout.write(`[${index + 1}/${schedule.length}] start ${run.id}\n`);
    const result = await runOne(run, project, memoryRepo, outDir, Number(values.timeout), values.effort);
    appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
    completed.push(result);
    const mt = result.metrics;
    process.stdout.write(`[${index + 1}/${schedule.length}] done ${run.id} exit=${result.exitCode} err=${mt.isError} start=${mt.startContextTokens} ctx=${mt.contextTokens} tools=${mt.toolCalls} out=${Math.round(mt.toolOutputBytes / 1024)}KB calls=${mt.apiCalls} tail=${mt.stopTailCalls} time=${Math.round(mt.durationMs / 1000)}s cost=$${mt.costUsd.toFixed(2)} recall=${mt.recallLine || 'missing'}\n`);
    if (mt.isError && /rate.?limit|usage limit|out of credits|quota/i.test(mt.failureMessage)) {
      process.stdout.write(`[paused] ${mt.failureMessage}\n`);
      break;
    }
  }

  const latestById = new Map<string, ClaudeCompletedRun>();
  for (const run of completed) latestById.set(run.id, run);
  const finalRuns = schedule.map((run) => latestById.get(run.id)).filter((run): run is ClaudeCompletedRun => Boolean(run));
  const summary = summarizeClaude(finalRuns);
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), renderClaudeReport(summary));
  process.stdout.write(renderClaudeReport(summary));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`benchmark error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
