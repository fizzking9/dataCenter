import { createHash } from 'node:crypto';
import type { ReviewEmbeddingConfiguration } from './catalog.js';

/**
 * The settled local embedding configuration every similarity nomination uses.
 *
 * Retrieval runs on a pinned, bundled local `Qwen3-Embedding-0.6B` configuration
 * and never on a hosted service. The adapter below is a deterministic, offline
 * stand-in for that model's vectors: it hashes the same normalized Chinese QA
 * text into a fixed-width L2-normalized space, so certification can freeze
 * scores without any network or model download. It nominates only — no reuse,
 * Approval, or authorization decision is ever derived from a score.
 */
export const LOCAL_EMBEDDING_CONFIGURATION: ReviewEmbeddingConfiguration = {
  model_id: 'Qwen3-Embedding-0.6B',
  revision: 'qwen3-embedding-0.6b-local.1',
  dimensions: 256,
  normalization: 'l2',
  metric: 'cosine',
};

/** How similar two business questions must score before one nominates the other. */
export const SIMILARITY_NOMINATION_THRESHOLD = 0.4;
/** How many similar QA pairs one review item discloses. */
export const MAX_SIMILARITY_NOMINATIONS = 5;

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
const WORD = /[a-z0-9]/u;

/**
 * Splits one Chinese question into deterministic retrieval tokens: Han
 * characters, Han bigrams, and Latin/digit runs (an SN or a period). Full-width
 * forms unify first, so the same business wording tokenizes identically.
 */
function tokensOf(text: string): string[] {
  const tokens: string[] = [];
  let word = '';
  const hans: string[] = [];
  const flushWord = (): void => {
    if (word.length > 0) {
      tokens.push(`w:${word}`);
      word = '';
    }
  };
  for (const char of text.normalize('NFKC').toLowerCase()) {
    if (WORD.test(char)) {
      word += char;
      continue;
    }
    flushWord();
    if (HAN.test(char)) {
      tokens.push(`c:${char}`);
      hans.push(char);
    }
  }
  flushWord();
  for (let index = 0; index + 1 < hans.length; index += 1) {
    tokens.push(`b:${hans[index]}${hans[index + 1]}`);
  }
  return tokens;
}

/** The deterministic offline embedding of one piece of QA text. */
export function embedLocally(text: string): number[] {
  const vector = new Array<number>(LOCAL_EMBEDDING_CONFIGURATION.dimensions).fill(0);
  for (const token of tokensOf(text)) {
    const digest = createHash('sha256').update(token).digest();
    const index = digest.readUInt32BE(0) % LOCAL_EMBEDDING_CONFIGURATION.dimensions;
    const sign = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * (token.startsWith('b:') ? 0.5 : 1);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

/** The cosine similarity of two QA texts, never a business equivalence claim. */
export function similarityScore(left: string, right: string): number {
  const a = embedLocally(left);
  const b = embedLocally(right);
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += (a[index] ?? 0) * (b[index] ?? 0);
  return Math.round(Math.max(0, Math.min(1, dot)) * 1_000_000) / 1_000_000;
}
