import { estimateForModel } from './tokenize.js';
import type { ScanResult } from './artifacts.js';
import type { Snapshot } from './snapshots.js';
import type { TokmonConfig } from './config.js';

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
function rpad(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

export function formatTable(rows: string[][], headers: string[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? pad(c, widths[i]) : rpad(c, widths[i]))).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

export function scanReport(cfg: TokmonConfig, scan: ScanResult): string {
  const catRows = Object.entries(scan.totalsByCategory).map(([cat, t]) => {
    const cells = [cat, String(t.files), String(t.bytes), String(t.rawTokens)];
    for (const m of cfg.models.slice(0, 3)) {
      cells.push(String(estimateForModel(t.rawTokens, m)));
    }
    return cells;
  });
  const headers = ['category', 'files', 'bytes', 'o200k'];
  for (const m of cfg.models.slice(0, 3)) headers.push(`≈${m.id}`);

  const b = scan.budget;
  const pct = (b.usedRatio * 100).toFixed(1);
  const budgetLine =
    `Recall budget [${b.status}]  injection ≈ ${b.injectionEstTokens} tokens ` +
    `(${b.injectionRawTokens} o200k) of ${b.budgetTokens} budget — ${pct}% used`;

  const totalRaw = Object.values(scan.totalsByCategory).reduce((s, t) => s + t.rawTokens, 0);
  const costRows = cfg.models.map((m) => {
    const est = estimateForModel(totalRaw, m);
    const dollars = (est / 1_000_000) * m.pricePerMTokInput;
    return [m.label, String(est), `$${dollars.toFixed(4)}`, m.pricing];
  });

  return [
    `AMP Token Monitor — scan of ${scan.memoryRepoPath} at ${scan.scannedAt}`,
    '',
    formatTable(catRows, headers),
    '',
    budgetLine,
    '',
    'Cost to read the full memory corpus once, as input tokens (calibrated ≈ estimates):',
    formatTable(costRows, ['model', '≈tokens', 'input cost', 'pricing']),
  ].join('\n');
}

export function trendReport(snapshots: Snapshot[]): string {
  const live = snapshots.filter((s) => !s.historical);
  if (live.length < 2) return 'Trend: need at least 2 snapshots — run scan again later.';
  const first = live[0];
  const last = live[live.length - 1];
  const days = Math.max(
    (Date.parse(last.ts) - Date.parse(first.ts)) / 86_400_000,
    1 / 24,
  );
  const total = (s: Snapshot) =>
    Object.values(s.totalsByCategory).reduce((sum, t) => sum + t.rawTokens, 0);
  const delta = total(last) - total(first);
  const perWeek = (delta / days) * 7;
  return (
    `Trend: ${total(first)} → ${total(last)} o200k tokens over ${days.toFixed(1)} days ` +
    `(${delta >= 0 ? '+' : ''}${delta}; ≈ ${perWeek >= 0 ? '+' : ''}${Math.round(perWeek)}/week). ` +
    `Injection: ${first.injectionRawTokens} → ${last.injectionRawTokens}.`
  );
}
