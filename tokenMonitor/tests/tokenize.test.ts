import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawTokens, estimateForModel, measure } from '../src/tokenize.js';
import type { ModelConfig } from '../src/config.js';

const model = (ratio: number): ModelConfig => ({
  id: 'm', label: 'm', match: ['m'], calibrationRatio: ratio,
  pricePerMTokInput: 1, pricePerMTokOutput: 1, cacheReadRatio: 0.1, cacheWriteRatio: 1.25,
  pricing: 'official',
});

test('empty string is zero tokens', () => {
  assert.equal(rawTokens(''), 0);
});

test('counting is deterministic and positive', () => {
  const text = '# Agent Memory Index\n\n**Total Issues Indexed:** 4\n';
  const a = rawTokens(text);
  const b = rawTokens(text);
  assert.ok(a > 0);
  assert.equal(a, b);
});

test('calibration rounds up', () => {
  assert.equal(estimateForModel(100, model(1.18)), 118);
  assert.equal(estimateForModel(101, model(1.18)), Math.ceil(101 * 1.18));
  assert.equal(estimateForModel(50, model(1.0)), 50);
});

test('measure reports utf8 bytes, chars, and tokens consistently', () => {
  const m = measure('héllo → world');
  assert.ok(m.bytes > m.chars); // multibyte chars
  assert.ok(m.rawTokens > 0);
});
