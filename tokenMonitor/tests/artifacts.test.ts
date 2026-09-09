import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type TokmonConfig } from '../src/config.js';
import { scanArtifacts } from '../src/artifacts.js';

function fixtureConfig(memRoot: string): TokmonConfig {
  const dir = mkdtempSync(join(tmpdir(), 'tokmon-cfg-'));
  const cfg = loadConfig(join(dir, 'tokmon.config.json'));
  cfg.memoryRepoPath = memRoot;
  cfg.devRepoPath = join(memRoot, 'no-dev-repo-here');
  return cfg;
}

function makeMemoryRepo(indexContent: string): string {
  const root = mkdtempSync(join(tmpdir(), 'tokmon-mem-'));
  writeFileSync(join(root, 'INDEX.md'), indexContent);
  writeFileSync(join(root, 'not_indexed.md'), '# Not Yet Indexed\n\ncount: 0\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Agents digest\n');
  writeFileSync(join(root, 'PROTOCOL.md'), '# Protocol\n');
  writeFileSync(join(root, 'REGION-test.md'), '# Region test\n| a | b |\n');
  mkdirSync(join(root, '.rxai-cache', 'issues'), { recursive: true });
  writeFileSync(join(root, '.rxai-cache', 'issues', '1.json'), JSON.stringify({ title: 'x' }));
  return root;
}

test('scan finds all categories and reports OK on a small repo', () => {
  const root = makeMemoryRepo('# Index\n\nSmall.\n');
  const scan = scanArtifacts(fixtureConfig(root));
  const cats = Object.keys(scan.totalsByCategory).sort();
  assert.deepEqual(cats, ['cache', 'digest', 'injection', 'protocol', 'region']);
  assert.equal(scan.totalsByCategory['injection'].files, 2);
  assert.equal(scan.budget.status, 'OK');
});

test('budget goes OVER when the injection artifacts exceed it', () => {
  // ~6000 words comfortably exceeds the 4000-token default budget
  const big = 'memory entry with several tokens each line\n'.repeat(1500);
  const root = makeMemoryRepo(big);
  const scan = scanArtifacts(fixtureConfig(root));
  assert.equal(scan.budget.status, 'OVER');
  assert.ok(scan.budget.injectionEstTokens > scan.budget.budgetTokens);
});

test('missing memory repo throws a clear error', () => {
  const cfg = fixtureConfig(join(tmpdir(), 'definitely-missing-repo-xyz'));
  assert.throws(() => scanArtifacts(cfg), /memory repo not found/);
});
