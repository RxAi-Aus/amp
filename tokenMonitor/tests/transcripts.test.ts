import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type TokmonConfig } from '../src/config.js';
import { analyzeSessions } from '../src/transcripts.js';

function line(model: string, id: string, input: number, output: number, text = 'hi'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-08T00:00:00Z',
    message: {
      id, model,
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: input, output_tokens: output,
        cache_read_input_tokens: 10, cache_creation_input_tokens: 5,
      },
    },
  });
}

function fixture(): TokmonConfig {
  const projects = mkdtempSync(join(tmpdir(), 'tokmon-proj-'));
  // memory project
  const mem = join(projects, '-Users-x-Documents-AgentMemory');
  mkdirSync(mem);
  writeFileSync(join(mem, 'sess1.jsonl'), [
    line('claude-fable-5', 'msg_1', 100, 50),
    line('claude-fable-5', 'msg_1', 100, 50),          // duplicate id — must dedup
    'this line is corrupted {{{',                       // must be skipped
    line('claude-fable-5', 'msg_2', 200, 80),
  ].join('\n'));
  // other project with one AMP-marked request
  const other = join(projects, '-Users-x-Documents-OtherApp');
  mkdirSync(other);
  writeFileSync(join(other, 'sess2.jsonl'), [
    line('claude-fable-5', 'msg_3', 10, 5, 'plain request'),
    line('claude-fable-5', 'msg_4', 30, 20, '[FROM:claudecowork→all][REGION:x] memory post'),
  ].join('\n'));

  const cfgDir = mkdtempSync(join(tmpdir(), 'tokmon-cfg-'));
  const cfg = loadConfig(join(cfgDir, 'tokmon.config.json'));
  cfg.claudeProjectsDir = projects;
  return cfg;
}

test('aggregates memory sessions, dedups by message id, skips corrupted lines', async () => {
  const summary = await analyzeSessions(fixture());
  assert.equal(summary.memorySessions.length, 1);
  const t = summary.totals.memory;
  assert.equal(t.input, 300);       // 100 + 200, duplicate not double-counted
  assert.equal(t.output, 130);
  assert.ok(t.costUSD > 0);
});

test('detects AMP-marked activity in non-memory projects separately', async () => {
  const summary = await analyzeSessions(fixture());
  assert.equal(summary.ampMarkedElsewhere.length, 1);
  const t = summary.totals.marked;
  assert.equal(t.input, 30);        // only the marked request, not the plain one
  assert.equal(t.output, 20);
});
