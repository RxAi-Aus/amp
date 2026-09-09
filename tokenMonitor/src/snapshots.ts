import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, type TokmonConfig } from './config.js';
import { estimateForModel } from './tokenize.js';
import type { ScanResult } from './artifacts.js';

export interface Snapshot {
  ts: string;
  historical?: boolean;          // true when produced by backfill from git history
  commit?: string;
  injectionRawTokens: number;
  budgetStatus: 'OK' | 'WARN' | 'OVER';
  totalsByCategory: Record<string, { files: number; bytes: number; rawTokens: number }>;
  perModelEstimates: Record<string, number>;   // total memory-artifact tokens per model
}

export function snapshotsPath(): string {
  return join(dataDir(), 'snapshots.ndjson');
}

export function snapshotFromScan(cfg: TokmonConfig, scan: ScanResult): Snapshot {
  const totalRaw = Object.values(scan.totalsByCategory).reduce((s, t) => s + t.rawTokens, 0);
  const perModelEstimates: Record<string, number> = {};
  for (const m of cfg.models) perModelEstimates[m.id] = estimateForModel(totalRaw, m);
  return {
    ts: scan.scannedAt,
    injectionRawTokens: scan.budget.injectionRawTokens,
    budgetStatus: scan.budget.status,
    totalsByCategory: scan.totalsByCategory,
    perModelEstimates,
  };
}

export function appendSnapshot(snap: Snapshot): void {
  // single-line atomic append; concurrent CLI + watch-mode writers each append
  // whole lines, and readers skip any torn/corrupted line defensively
  appendFileSync(snapshotsPath(), JSON.stringify(snap) + '\n');
}

export function readSnapshots(): Snapshot[] {
  const path = snapshotsPath();
  if (!existsSync(path)) return [];
  const out: Snapshot[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Snapshot);
    } catch {
      // torn write or corrupted line — ignore
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
