import { execFileSync } from 'node:child_process';
import { expandHome, type TokmonConfig } from './config.js';
import { measure } from './tokenize.js';
import { appendSnapshot, readSnapshots, type Snapshot } from './snapshots.js';

const TRACKED = ['INDEX.md', 'not_indexed.md'];
const MAX_POINTS = 60;

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Read-only walk of the memory repo's history; only `git log` and `git show` are used. */
export function backfill(cfg: TokmonConfig, sinceIso?: string): Snapshot[] {
  const repo = expandHome(cfg.memoryRepoPath);
  const logArgs = ['log', '--format=%H %cI', '--', ...TRACKED];
  if (sinceIso) logArgs.splice(1, 0, `--since=${sinceIso}`);
  const lines = git(repo, logArgs).trim().split('\n').filter(Boolean);
  if (lines.length === 0) return [];

  // oldest first, evenly sampled down to MAX_POINTS
  const commits = lines
    .map((l) => {
      const [sha, ts] = l.split(' ');
      return { sha, ts };
    })
    .reverse();
  const step = Math.max(1, Math.ceil(commits.length / MAX_POINTS));
  const sampled = commits.filter((_, i) => i % step === 0 || i === commits.length - 1);

  const already = new Set(readSnapshots().map((s) => s.commit).filter(Boolean));
  const produced: Snapshot[] = [];

  for (const { sha, ts } of sampled) {
    if (already.has(sha)) continue;
    let injectionRaw = 0;
    let bytes = 0;
    let files = 0;
    for (const file of TRACKED) {
      let text = '';
      try {
        text = git(repo, ['show', `${sha}:${file}`]);
      } catch {
        continue; // file did not exist at this commit
      }
      const m = measure(text);
      injectionRaw += m.rawTokens;
      bytes += m.bytes;
      files += 1;
    }
    if (files === 0) continue;
    const snap: Snapshot = {
      ts,
      historical: true,
      commit: sha,
      injectionRawTokens: injectionRaw,
      budgetStatus:
        injectionRaw * 1.18 > cfg.budgets.recallInjectionTokens ? 'OVER'
        : injectionRaw * 1.18 >= cfg.budgets.recallInjectionTokens * cfg.budgets.warnRatio ? 'WARN'
        : 'OK',
      totalsByCategory: { injection: { files, bytes, rawTokens: injectionRaw } },
      perModelEstimates: {},
    };
    appendSnapshot(snap);
    produced.push(snap);
  }
  return produced;
}
