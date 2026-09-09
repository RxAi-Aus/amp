import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { scanArtifacts } from './artifacts.js';
import { appendSnapshot, readSnapshots, snapshotFromScan, snapshotsPath } from './snapshots.js';
import { scanReport, trendReport } from './report.js';
import { analyzeSessions } from './transcripts.js';
import { backfill } from './backfill.js';
import { serve } from './server.js';

const USAGE = `amp-token-monitor — token usage monitor for the RxAi AMP memory system

Usage: node dist/src/cli.js <command> [options]

Commands
  scan       tokenize memory artifacts, check the recall budget, append a snapshot
  report     scan + growth trend from prior snapshots
  sessions   parse Claude Code transcripts for real memory-related token spend
  backfill   reconstruct historical snapshots from the memory repo's git history
  serve      start the local dashboard (default port 4173)

Options
  --json               machine-readable output
  --since <iso-date>   backfill: only commits after this date
  --port <n>           serve: port (default from config)
  --watch              serve: rescan on an interval
  --config <path>      alternate tokmon.config.json

Exit codes: 0 ok, 1 error, 2 recall budget OVER
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      since: { type: 'string' },
      port: { type: 'string' },
      watch: { type: 'boolean', default: false },
      config: { type: 'string' },
    },
  });
  const command = positionals[0];
  if (!command || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const cfg = loadConfig(values.config);

  switch (command) {
    case 'scan': {
      const scan = scanArtifacts(cfg);
      appendSnapshot(snapshotFromScan(cfg, scan));
      process.stdout.write(values.json ? JSON.stringify(scan, null, 2) + '\n' : scanReport(cfg, scan) + '\n');
      return scan.budget.status === 'OVER' ? 2 : 0;
    }
    case 'report': {
      const scan = scanArtifacts(cfg);
      appendSnapshot(snapshotFromScan(cfg, scan));
      const snapshots = readSnapshots();
      if (values.json) {
        process.stdout.write(JSON.stringify({ scan, snapshots }, null, 2) + '\n');
      } else {
        process.stdout.write(scanReport(cfg, scan) + '\n\n' + trendReport(snapshots) + '\n');
      }
      return scan.budget.status === 'OVER' ? 2 : 0;
    }
    case 'sessions': {
      const summary = await analyzeSessions(cfg);
      if (values.json) {
        process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
        return 0;
      }
      const t = summary.totals;
      const lines = [
        `Claude Code transcripts under ${summary.projectsDir}`,
        '',
        `Memory-project sessions: ${summary.memorySessions.length}`,
        `  input=${t.memory.input}  output=${t.memory.output}  cacheRead=${t.memory.cacheRead}  cacheCreate=${t.memory.cacheCreate}`,
        `  estimated cost: $${t.memory.costUSD.toFixed(4)}`,
        `  cache efficiency: ${cacheEfficiency(t.memory)}%`,
        '',
        `AMP-marked activity in other projects: ${summary.ampMarkedElsewhere.length} sessions`,
        `  input=${t.marked.input}  output=${t.marked.output}  cacheRead=${t.marked.cacheRead}  cacheCreate=${t.marked.cacheCreate}`,
        `  estimated cost: $${t.marked.costUSD.toFixed(4)}`,
        '',
        'Per-day (memory projects):',
        ...Object.entries(summary.byDay)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-14)
          .map(([day, u]) => `  ${day}  in=${u.input} out=${u.output} cacheRead=${u.cacheRead}`),
      ];
      process.stdout.write(lines.join('\n') + '\n');
      return 0;
    }
    case 'backfill': {
      const produced = backfill(cfg, values.since);
      process.stdout.write(
        values.json
          ? JSON.stringify(produced, null, 2) + '\n'
          : `backfill: ${produced.length} historical snapshot(s) appended to ${snapshotsPath()}\n`,
      );
      return 0;
    }
    case 'serve': {
      const port = values.port ? Number(values.port) : cfg.port;
      await serve(cfg, port, values.watch ?? false);
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

function cacheEfficiency(u: { input: number; cacheRead: number; cacheCreate: number }): string {
  const denom = u.input + u.cacheRead + u.cacheCreate;
  return denom === 0 ? '0' : ((u.cacheRead / denom) * 100).toFixed(1);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
