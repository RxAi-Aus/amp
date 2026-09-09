import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { expandHome, matchModel, type TokmonConfig } from './config.js';

/** Usage of one API request, as recorded in a Claude Code transcript line. */
interface UsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface SessionUsage {
  sessionId: string;
  project: string;
  isMemoryProject: boolean;
  firstTs: string;
  lastTs: string;
  requests: number;
  markedRequests: number;      // requests whose content carries AMP markers
  byModel: Record<string, UsageRecord>;
  markedByModel: Record<string, UsageRecord>;
}

export interface SessionsSummary {
  scannedAt: string;
  projectsDir: string;
  memorySessions: SessionUsage[];
  ampMarkedElsewhere: SessionUsage[];   // non-memory projects with AMP-marked activity
  totals: {
    memory: UsageRecord & { costUSD: number };
    marked: UsageRecord & { costUSD: number };
  };
  byDay: Record<string, UsageRecord>;   // memory-project sessions, per UTC day
}

const AMP_MARKERS = [
  '[FROM:',
  'rxai-amp',
  'RxAi AMP shared memory',
  'AMP §15 lifecycle checkpoint',
];

function emptyUsage(): UsageRecord {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

function addUsage(into: UsageRecord, u: UsageRecord): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheCreate += u.cacheCreate;
}

async function parseTranscript(
  path: string,
  sessionId: string,
  project: string,
  isMemoryProject: boolean,
): Promise<SessionUsage | null> {
  const session: SessionUsage = {
    sessionId, project, isMemoryProject,
    firstTs: '', lastTs: '',
    requests: 0, markedRequests: 0,
    byModel: {}, markedByModel: {},
  };
  // one usage entry per API message id — streaming rewrites repeat the id
  const seen = new Map<string, { model: string; usage: UsageRecord; marked: boolean; ts: string }>();

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // corrupted line — skip gracefully
    }
    const msg = entry?.message;
    const usage = msg?.usage;
    if (!usage || typeof usage.output_tokens !== 'number') continue;
    const id: string = msg.id ?? entry.uuid ?? String(seen.size);
    const marked = AMP_MARKERS.some((m) => line.includes(m));
    const prior = seen.get(id);
    seen.set(id, {
      model: msg.model ?? 'unknown',
      ts: entry.timestamp ?? '',
      marked: marked || (prior?.marked ?? false),
      usage: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreate: usage.cache_creation_input_tokens ?? 0,
      },
    });
  }

  if (seen.size === 0) return null;
  for (const rec of seen.values()) {
    session.requests += 1;
    if (rec.ts) {
      if (!session.firstTs || rec.ts < session.firstTs) session.firstTs = rec.ts;
      if (!session.lastTs || rec.ts > session.lastTs) session.lastTs = rec.ts;
    }
    addUsage((session.byModel[rec.model] ??= emptyUsage()), rec.usage);
    if (rec.marked) {
      session.markedRequests += 1;
      addUsage((session.markedByModel[rec.model] ??= emptyUsage()), rec.usage);
    }
  }
  return session;
}

export function costUSD(cfg: TokmonConfig, byModel: Record<string, UsageRecord>): number {
  let total = 0;
  for (const [modelId, u] of Object.entries(byModel)) {
    const m = matchModel(cfg, modelId);
    if (!m) continue;
    total +=
      (u.input * m.pricePerMTokInput +
        u.output * m.pricePerMTokOutput +
        u.cacheRead * m.pricePerMTokInput * m.cacheReadRatio +
        u.cacheCreate * m.pricePerMTokInput * m.cacheWriteRatio) / 1_000_000;
  }
  return total;
}

export async function analyzeSessions(cfg: TokmonConfig): Promise<SessionsSummary> {
  const root = expandHome(cfg.claudeProjectsDir);
  const memorySessions: SessionUsage[] = [];
  const ampMarkedElsewhere: SessionUsage[] = [];
  const byDay: Record<string, UsageRecord> = {};

  if (existsSync(root)) {
    for (const projectDir of readdirSync(root, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const isMemory = cfg.memoryProjectMarkers.some((m) => projectDir.name.includes(m));
      const dir = join(root, projectDir.name);
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      // non-memory projects are only interesting if AMP markers show up, and
      // scanning every transcript on the machine would be slow — memory
      // projects are parsed fully; others only when small enough to be cheap
      if (!isMemory && files.length > 200) continue;
      for (const f of files) {
        const session = await parseTranscript(join(dir, f), f.replace('.jsonl', ''), projectDir.name, isMemory);
        if (!session) continue;
        if (isMemory) {
          memorySessions.push(session);
          const day = (session.firstTs || 'unknown').slice(0, 10);
          for (const u of Object.values(session.byModel)) addUsage((byDay[day] ??= emptyUsage()), u);
        } else if (session.markedRequests > 0) {
          ampMarkedElsewhere.push(session);
        }
      }
    }
  }

  const memTotal = emptyUsage();
  const memByModel: Record<string, UsageRecord> = {};
  for (const s of memorySessions) {
    for (const [m, u] of Object.entries(s.byModel)) {
      addUsage(memTotal, u);
      addUsage((memByModel[m] ??= emptyUsage()), u);
    }
  }
  const markedTotal = emptyUsage();
  const markedByModel: Record<string, UsageRecord> = {};
  for (const s of ampMarkedElsewhere) {
    for (const [m, u] of Object.entries(s.markedByModel)) {
      addUsage(markedTotal, u);
      addUsage((markedByModel[m] ??= emptyUsage()), u);
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    projectsDir: root,
    memorySessions: memorySessions.sort((a, b) => b.firstTs.localeCompare(a.firstTs)),
    ampMarkedElsewhere: ampMarkedElsewhere.sort((a, b) => b.firstTs.localeCompare(a.firstTs)),
    totals: {
      memory: { ...memTotal, costUSD: costUSD(cfg, memByModel) },
      marked: { ...markedTotal, costUSD: costUSD(cfg, markedByModel) },
    },
    byDay,
  };
}
