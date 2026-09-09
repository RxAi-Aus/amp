import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import type { ModelConfig } from './config.js';

/** Exact o200k_base BPE count — the tokenizer-independent base measure. */
export function rawTokens(text: string): number {
  if (text.length === 0) return 0;
  return countTokens(text);
}

/** Calibrated per-model estimate from a raw o200k count. */
export function estimateForModel(raw: number, model: ModelConfig): number {
  return Math.ceil(raw * model.calibrationRatio);
}

export interface TextMeasure {
  bytes: number;
  chars: number;
  rawTokens: number;
}

export function measure(text: string): TextMeasure {
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    chars: text.length,
    rawTokens: rawTokens(text),
  };
}
