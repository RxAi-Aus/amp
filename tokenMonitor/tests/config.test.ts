import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, matchModel, primaryModel } from '../src/config.js';

test('auto-creates config with defaults when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokmon-'));
  const path = join(dir, 'tokmon.config.json');
  const cfg = loadConfig(path);
  assert.ok(existsSync(path));
  assert.equal(cfg.budgets.recallInjectionTokens, 4000);
  assert.ok(cfg.models.length >= 4);
  assert.equal(primaryModel(cfg).id, 'claude-fable-5');
});

test('rejects config with empty models array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokmon-'));
  const path = join(dir, 'tokmon.config.json');
  writeFileSync(path, JSON.stringify({ models: [] }));
  assert.throws(() => loadConfig(path), /models/);
});

test('rejects config with non-numeric budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokmon-'));
  const path = join(dir, 'tokmon.config.json');
  writeFileSync(path, JSON.stringify({ budgets: { recallInjectionTokens: 'lots' } }));
  assert.throws(() => loadConfig(path), /budgets/);
});

test('matches transcript model ids by prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokmon-'));
  const cfg = loadConfig(join(dir, 'tokmon.config.json'));
  assert.equal(matchModel(cfg, 'claude-fable-5')?.id, 'claude-fable-5');
  assert.equal(matchModel(cfg, 'claude-opus-5')?.id, 'claude-opus-5');
  assert.equal(matchModel(cfg, 'gemini-3.5-flash-high')?.id, 'gemini-flash');
  assert.equal(matchModel(cfg, 'mystery-model'), undefined);
});
