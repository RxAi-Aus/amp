import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot, type TokmonConfig } from './config.js';
import { scanArtifacts, type ScanResult } from './artifacts.js';
import { appendSnapshot, readSnapshots, snapshotFromScan } from './snapshots.js';
import { analyzeSessions, type SessionsSummary } from './transcripts.js';

const SESSIONS_TTL_MS = 5 * 60 * 1000;

export async function serve(cfg: TokmonConfig, port: number, watch: boolean): Promise<void> {
  const htmlPath = join(packageRoot(), 'public', 'index.html');
  let sessionsCache: { at: number; data: SessionsSummary } | null = null;
  let lastScan: ScanResult | null = null;

  const doScan = (): ScanResult => {
    const scan = scanArtifacts(cfg);
    appendSnapshot(snapshotFromScan(cfg, scan));
    lastScan = scan;
    return scan;
  };

  if (watch) {
    doScan();
    const interval = setInterval(doScan, cfg.watchIntervalMinutes * 60 * 1000);
    interval.unref();
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      switch (url.pathname) {
        case '/': {
          if (!existsSync(htmlPath)) return json({ error: 'public/index.html missing' }, 500);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(readFileSync(htmlPath));
          return;
        }
        case '/api/summary': {
          // recompute fresh (cheap) so the dashboard always shows current artifacts
          const scan = doScan();
          return json({ scan, models: cfg.models, budgets: cfg.budgets, watch });
        }
        case '/api/snapshots':
          return json(readSnapshots());
        case '/api/sessions': {
          if (!sessionsCache || Date.now() - sessionsCache.at > SESSIONS_TTL_MS) {
            sessionsCache = { at: Date.now(), data: await analyzeSessions(cfg) };
          }
          return json(sessionsCache.data);
        }
        default:
          return json({ error: 'not found', lastScanAt: lastScan?.scannedAt ?? null }, 404);
      }
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  await new Promise<void>((resolveStarted) => server.listen(port, resolveStarted));
  process.stdout.write(
    `AMP Token Monitor dashboard: http://localhost:${port}  (watch=${watch ? `every ${cfg.watchIntervalMinutes}m` : 'off'})\n`,
  );
  // keep the process alive until interrupted
  await new Promise<void>((resolveClosed) => {
    process.on('SIGINT', () => server.close(() => resolveClosed()));
    process.on('SIGTERM', () => server.close(() => resolveClosed()));
  });
}
