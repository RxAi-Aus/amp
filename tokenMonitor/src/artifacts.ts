import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expandHome, primaryModel, type TokmonConfig } from './config.js';
import { estimateForModel, measure, type TextMeasure } from './tokenize.js';

export type ArtifactCategory =
  | 'injection'   // C1: injected every session start (INDEX.md + not_indexed.md)
  | 'digest'      // AGENTS.md — the folderless-agent digest
  | 'region'      // REGION-*.md pointer tables, loaded on demand
  | 'protocol'    // PROTOCOL.md worst-case full read
  | 'skill'       // rxai-amp skill files
  | 'cache';      // .rxai-cache mirror of issue bodies/comments

export interface Artifact extends TextMeasure {
  path: string;       // display path, relative to its repo root
  category: ArtifactCategory;
}

export interface BudgetVerdict {
  injectionRawTokens: number;
  injectionEstTokens: number;  // calibrated for the primary model
  budgetTokens: number;
  usedRatio: number;
  status: 'OK' | 'WARN' | 'OVER';
}

export interface ScanResult {
  scannedAt: string;
  memoryRepoPath: string;
  artifacts: Artifact[];
  totalsByCategory: Record<string, { files: number; bytes: number; rawTokens: number }>;
  budget: BudgetVerdict;
}

function readArtifact(root: string, rel: string, category: ArtifactCategory): Artifact | null {
  const full = join(root, rel);
  if (!existsSync(full)) return null;
  const text = readFileSync(full, 'utf8');
  return { path: rel, category, ...measure(text) };
}

function walkCache(dir: string, root: string, out: Artifact[], depth = 0): void {
  if (depth > 4 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCache(full, root, out, depth + 1);
    } else if (/\.(json|md|txt)$/.test(entry.name)) {
      try {
        const text = readFileSync(full, 'utf8');
        out.push({ path: relative(root, full), category: 'cache', ...measure(text) });
      } catch {
        // unreadable cache entry — skip, the cache is advisory anyway
      }
    }
  }
}

export function scanArtifacts(cfg: TokmonConfig): ScanResult {
  const memRoot = expandHome(cfg.memoryRepoPath);
  const devRoot = expandHome(cfg.devRepoPath);
  if (!existsSync(memRoot)) {
    throw new Error(`memory repo not found at ${memRoot} — edit tokmon.config.json`);
  }

  const artifacts: Artifact[] = [];
  const push = (a: Artifact | null) => { if (a) artifacts.push(a); };

  push(readArtifact(memRoot, 'INDEX.md', 'injection'));
  push(readArtifact(memRoot, 'not_indexed.md', 'injection'));
  push(readArtifact(memRoot, 'AGENTS.md', 'digest'));
  push(readArtifact(memRoot, 'PROTOCOL.md', 'protocol'));
  for (const name of readdirSync(memRoot)) {
    if (/^REGION-.+\.md$/.test(name)) push(readArtifact(memRoot, name, 'region'));
  }

  const skillDir = join(devRoot, '.claude', 'skills', 'rxai-amp');
  if (existsSync(skillDir)) {
    const stack = [skillDir];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith('.md')) {
          push({ path: relative(devRoot, full), category: 'skill', ...measure(readFileSync(full, 'utf8')) });
        }
      }
    }
  }

  const cacheDir = join(memRoot, '.rxai-cache');
  if (existsSync(cacheDir) && statSync(cacheDir).isDirectory()) {
    walkCache(cacheDir, memRoot, artifacts);
  }

  const totalsByCategory: ScanResult['totalsByCategory'] = {};
  for (const a of artifacts) {
    const t = (totalsByCategory[a.category] ??= { files: 0, bytes: 0, rawTokens: 0 });
    t.files += 1;
    t.bytes += a.bytes;
    t.rawTokens += a.rawTokens;
  }

  const injectionRaw = totalsByCategory['injection']?.rawTokens ?? 0;
  const model = primaryModel(cfg);
  const injectionEst = estimateForModel(injectionRaw, model);
  const budget = cfg.budgets.recallInjectionTokens;
  const ratio = budget > 0 ? injectionEst / budget : 0;
  const status: BudgetVerdict['status'] =
    ratio > 1 ? 'OVER' : ratio >= cfg.budgets.warnRatio ? 'WARN' : 'OK';

  return {
    scannedAt: new Date().toISOString(),
    memoryRepoPath: memRoot,
    artifacts,
    totalsByCategory,
    budget: {
      injectionRawTokens: injectionRaw,
      injectionEstTokens: injectionEst,
      budgetTokens: budget,
      usedRatio: ratio,
      status,
    },
  };
}
