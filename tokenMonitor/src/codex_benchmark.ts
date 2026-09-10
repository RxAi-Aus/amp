import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

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

export interface CompletedRun extends PlannedRun {
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  metrics: RunMetrics;
}

const RULES = `You are doing a READ-ONLY investigation of this repository.
Rules: do not edit or create files, do not commit, and do not create or comment
on GitHub issues. You may read files and run read-only shell commands. Before
any AMP action, check AMP_DISABLE in the environment; when it is 1, do not load,
read, or use AMP memory. Never display credential values. Answer in English,
under 300 words, naming exact file paths and function names. End with one line
exactly in this form: Recall used: #N, #M (list every AMP issue whose content
you relied on), or: Recall used: none.`;

export const DEFAULT_TASKS_FILE = 'config/tasks.json';

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

type MetricKey = 'inputTokens' | 'uncachedInputTokens' | 'cachedInputTokens' | 'outputTokens' | 'toolOutputBytes' | 'commandCalls' | 'durationMs';
const METRICS: MetricKey[] = ['inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'outputTokens', 'toolOutputBytes', 'commandCalls', 'durationMs'];

export function summarize(runs: CompletedRun[]) {
  const models = [...new Set(runs.map((run) => run.model))];
  const result: Record<string, any> = {};
  for (const model of models) {
    const modelRuns = runs.filter((run) => run.model === model && run.exitCode === 0);
    const arms: Record<Arm, any> = { on: {}, off: {} };
    for (const arm of ['on', 'off'] as const) {
      const subset = modelRuns.filter((run) => run.arm === arm);
      arms[arm].runs = subset.length;
      for (const key of METRICS) arms[arm][key] = subset.reduce((sum, run) => sum + run.metrics[key], 0);
      arms[arm].recallCorrect = subset.filter((run) => run.metrics.recallCorrect).length;
      const memoryRuns = subset.filter((run) => run.task.expectedIssue !== null);
      const controlRuns = subset.filter((run) => run.task.expectedIssue === null);
      arms[arm].memoryHits = memoryRuns.filter((run) => run.metrics.recallCorrect).length;
      arms[arm].memoryEligible = memoryRuns.length;
      arms[arm].controlCorrect = controlRuns.filter((run) => run.metrics.recallCorrect).length;
      arms[arm].controls = controlRuns.length;
      arms[arm].signalHits = subset.reduce((sum, run) => sum + run.metrics.signalHits, 0);
      arms[arm].signalTotal = subset.reduce((sum, run) => sum + run.metrics.signalTotal, 0);
      arms[arm].commandFailures = subset.reduce((sum, run) => sum + run.metrics.commandFailures, 0);
    }
    const change: Record<string, number | null> = {};
    for (const key of METRICS) {
      const off = arms.off[key];
      change[key] = off === 0 ? null : ((arms.on[key] - off) / off) * 100;
    }
    const successfulPairs = [...new Set(modelRuns.map((run) => run.pair))].flatMap((pair) => {
      const on = modelRuns.find((run) => run.pair === pair && run.arm === 'on');
      const off = modelRuns.find((run) => run.pair === pair && run.arm === 'off');
      return on && off ? [{ pair, on, off }] : [];
    });
    const pairedLower: Record<string, number> = {};
    for (const key of METRICS) {
      pairedLower[key] = successfulPairs.filter(({ on, off }) => on.metrics[key] < off.metrics[key]).length;
    }
    result[model] = {
      arms,
      pairs: successfulPairs.length,
      ampOnVsOffPercent: change,
      ampOnLowerPairs: pairedLower,
    };
  }
  return {
    generatedAt: new Date().toISOString(),
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
    '',
    '| Model | Pairs | Input tokens Δ | Uncached input Δ | Tool output Δ | Time Δ | Input lower | Memory hits | Control correct | Signal coverage on/off |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [model, data] of Object.entries(summary.models) as [string, any][]) {
    const p = data.ampOnVsOffPercent;
    lines.push(`| ${model} | ${data.pairs} | ${pct(p.inputTokens)} | ${pct(p.uncachedInputTokens)} | ${pct(p.toolOutputBytes)} | ${pct(p.durationMs)} | ${data.ampOnLowerPairs.inputTokens}/${data.pairs} | ${data.arms.on.memoryHits}/${data.arms.on.memoryEligible} | ${data.arms.on.controlCorrect}/${data.arms.on.controls} | ${data.arms.on.signalHits}/${data.arms.on.signalTotal} vs ${data.arms.off.signalHits}/${data.arms.off.signalTotal} |`);
  }
  lines.push('', 'Negative percentages mean AMP used less than the disabled arm.', 'Token counts come directly from Codex `turn.completed` usage. `cached_input_tokens` is a subset of `input_tokens`; uncached input is their difference.', 'Signal coverage is a deterministic keyword check, not an independent answer-quality grade.', '');
  return lines.join('\n');
}

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-z0-9.-]+/gi, '-');
}

async function runOne(run: PlannedRun, project: string, memorySlug: string, outDir: string, timeoutMinutes: number): Promise<CompletedRun> {
  const prompt = `${RULES}\n\nQuestion: ${run.task.question}`;
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config',
    '-m', run.model,
    '-c', `model_reasoning_effort=${run.reasoning}`,
    '-c', 'approval_policy=never',
    '-s', 'read-only',
    '-C', project,
    prompt,
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RXAI_AMP_SLUG: memorySlug,
    RXAI_AMP_AGENT: 'codex',
  };
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
  return { ...run, startedAt, finishedAt, exitCode, metrics };
}

function loadCompleted(path: string): CompletedRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as CompletedRun]; } catch { return []; }
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      cases: { type: 'string', default: '20' },
      models: { type: 'string', default: 'gpt-6-astra,gpt-5.6-sol' },
      reasoning: { type: 'string', default: 'medium' },
      project: { type: 'string' },
      'memory-repo': { type: 'string' },
      'memory-slug': { type: 'string' },
      out: { type: 'string', default: join(process.cwd(), 'data', 'codex-amp-ab', 'latest') },
      timeout: { type: 'string', default: '12' },
    },
  });
  const models = values.models!.split(',').map((model) => model.trim()).filter(Boolean);
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
  mkdirSync(outDir, { recursive: true });
  const resultsPath = join(outDir, 'results.ndjson');
  const completed = loadCompleted(resultsPath);
  const completedIds = new Set(completed.filter((run) => run.exitCode === 0).map((run) => run.id));

  for (const [index, run] of schedule.entries()) {
    if (completedIds.has(run.id)) {
      process.stdout.write(`[${index + 1}/${schedule.length}] skip ${run.id}\n`);
      continue;
    }
    process.stdout.write(`[${index + 1}/${schedule.length}] start ${run.id}\n`);
    const result = await runOne(run, project, memorySlug, outDir, Number(values.timeout));
    appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
    completed.push(result);
    process.stdout.write(`[${index + 1}/${schedule.length}] done ${run.id} exit=${result.exitCode} input=${result.metrics.inputTokens} cached=${result.metrics.cachedInputTokens} tools=${result.metrics.commandCalls} time=${Math.round(result.metrics.durationMs / 1000)}s recall=${result.metrics.recallLine || 'missing'}\n`);
    if (result.exitCode !== 0 && /usage limit|rate limit|quota/i.test(result.metrics.failureMessage)) {
      process.stdout.write(`[paused] ${result.metrics.failureMessage}\n`);
      break;
    }
  }

  const latestById = new Map<string, CompletedRun>();
  for (const run of completed) latestById.set(run.id, run);
  const finalRuns = schedule.map((run) => latestById.get(run.id)).filter((run): run is CompletedRun => Boolean(run));
  const summary = summarize(finalRuns);
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), renderReport(summary));
  process.stdout.write(renderReport(summary));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`benchmark error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
