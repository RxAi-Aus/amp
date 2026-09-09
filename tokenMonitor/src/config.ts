import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ModelConfig {
  id: string;
  label: string;
  /** transcript model ids are matched against these prefixes */
  match: string[];
  /** multiplier applied to the raw o200k_base count to estimate this model's tokens */
  calibrationRatio: number;
  pricePerMTokInput: number;
  pricePerMTokOutput: number;
  /** cache-read price as a fraction of input price */
  cacheReadRatio: number;
  /** cache-write price as a multiple of input price */
  cacheWriteRatio: number;
  pricing: 'official' | 'estimate — edit me';
}

export interface TokmonConfig {
  memoryRepoPath: string;
  devRepoPath: string;
  claudeProjectsDir: string;
  /** a Claude Code project dir counts as a memory project when its name contains one of these */
  memoryProjectMarkers: string[];
  budgets: { recallInjectionTokens: number; warnRatio: number };
  models: ModelConfig[];
  port: number;
  watchIntervalMinutes: number;
}

// Prices verified against Anthropic docs 2026-08-08. o200k_base undercounts
// Claude tokens by ~15-20%, hence calibrationRatio 1.18 for the Claude family.
const DEFAULT_CONFIG: TokmonConfig = {
  memoryRepoPath: '~/Documents/AgentMemory',
  devRepoPath: '~/Documents/githubMemoryAgent',
  claudeProjectsDir: '~/.claude/projects',
  memoryProjectMarkers: ['AgentMemory', 'githubMemoryAgent'],
  budgets: { recallInjectionTokens: 4000, warnRatio: 0.8 },
  models: [
    {
      id: 'claude-fable-5', label: 'Claude Fable 5', match: ['claude-fable-5', 'claude-mythos'],
      calibrationRatio: 1.18, pricePerMTokInput: 10, pricePerMTokOutput: 50,
      cacheReadRatio: 0.1, cacheWriteRatio: 1.25, pricing: 'official',
    },
    {
      id: 'claude-opus-5', label: 'Claude Opus 5', match: ['claude-opus'],
      calibrationRatio: 1.18, pricePerMTokInput: 5, pricePerMTokOutput: 25,
      cacheReadRatio: 0.1, cacheWriteRatio: 1.25, pricing: 'official',
    },
    {
      id: 'claude-sonnet-5', label: 'Claude Sonnet 5', match: ['claude-sonnet'],
      calibrationRatio: 1.18, pricePerMTokInput: 3, pricePerMTokOutput: 15,
      cacheReadRatio: 0.1, cacheWriteRatio: 1.25, pricing: 'official',
    },
    {
      id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', match: ['claude-haiku'],
      calibrationRatio: 1.18, pricePerMTokInput: 1, pricePerMTokOutput: 5,
      cacheReadRatio: 0.1, cacheWriteRatio: 1.25, pricing: 'official',
    },
    {
      id: 'gpt-5', label: 'GPT-5 family', match: ['gpt-5', 'gpt-4o'],
      calibrationRatio: 1.0, pricePerMTokInput: 1.25, pricePerMTokOutput: 10,
      cacheReadRatio: 0.1, cacheWriteRatio: 1.0, pricing: 'estimate — edit me',
    },
    {
      id: 'gemini-flash', label: 'Gemini Flash family', match: ['gemini'],
      calibrationRatio: 1.05, pricePerMTokInput: 0.3, pricePerMTokOutput: 2.5,
      cacheReadRatio: 0.25, cacheWriteRatio: 1.0, pricing: 'estimate — edit me',
    },
  ],
  port: 4173,
  watchIntervalMinutes: 5,
};

export function packageRoot(): string {
  // dist/src/config.js -> package root is two levels up
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function dataDir(): string {
  const dir = join(packageRoot(), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(configPath?: string): TokmonConfig {
  const path = configPath ?? join(packageRoot(), 'tokmon.config.json');
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TokmonConfig>;
  const cfg: TokmonConfig = { ...structuredClone(DEFAULT_CONFIG), ...raw };
  if (!Array.isArray(cfg.models) || cfg.models.length === 0) {
    throw new Error(`tokmon.config.json: "models" must be a non-empty array`);
  }
  if (!cfg.budgets || typeof cfg.budgets.recallInjectionTokens !== 'number') {
    throw new Error(`tokmon.config.json: "budgets.recallInjectionTokens" must be a number`);
  }
  return cfg;
}

/** The first model row is the primary agent's model — budget verdicts use it. */
export function primaryModel(cfg: TokmonConfig): ModelConfig {
  return cfg.models[0];
}

export function matchModel(cfg: TokmonConfig, transcriptModelId: string): ModelConfig | undefined {
  return cfg.models.find((m) => m.match.some((prefix) => transcriptModelId.startsWith(prefix)));
}
