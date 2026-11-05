import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * The browser catalog is the only source of user-facing copy, so a status this
 * ticket introduces that the catalog cannot name falls back to a raw English
 * identifier on screen. Every such status must therefore have Simplified
 * Chinese copy, while the governed identifiers themselves stay ASCII.
 */
const REQUIRED = [
  'value.state.queued',
  'value.state.running',
  'value.state.complete',
  'value.state.failed',
  'value.state.cancelled',
  'value.state.intervention_required',
  'value.state.valid',
  'value.state.invalid',
  'value.pacing.fifo',
  'value.pacing.serialization',
  'value.pacing.concurrency',
  'value.pacing.interval',
  'value.pacing.rate',
  'value.window.fixed',
  'value.window.incremental',
  'value.window.backfill',
];

const SOURCE = new URL('../../../web/src/i18n/zh-CN.ts', import.meta.url);

function catalog(): Map<string, string> {
  const text = readFileSync(SOURCE, 'utf8');
  const start = text.indexOf('export const catalog = {');
  const end = text.indexOf('} as const;', start);
  assert.ok(start >= 0 && end > start, 'the Simplified Chinese catalog is where the console reads its copy');
  const entries = new Map<string, string>();
  for (const match of text.slice(start, end).matchAll(/'([^']+)':\s*'([^']*)'/gu)) {
    entries.set(match[1]!, match[2]!);
  }
  return entries;
}

const CJK = /[\u4e00-\u9fff]/u;

test('every status this ticket introduces reads in Simplified Chinese while governed values stay ASCII', () => {
  const entries = catalog();
  assert.ok(entries.size > 90, 'the catalog is the console copy, not an empty shell');

  const missing = REQUIRED.filter((key) => !entries.has(key));
  assert.deepEqual(missing, [], 'a governed status with no catalog entry would render as raw English');

  const englishOnly = REQUIRED.filter((key) => !CJK.test(entries.get(key) ?? ''));
  assert.deepEqual(englishOnly, [], 'Simplified Chinese, not an untranslated English label');

  // No English-only copy anywhere in the catalog, and no translated identifier:
  // the keys are the governed values the API and the CLI speak, so they stay
  // ASCII. A governed value may itself carry a colon (`mcp:read`,
  // `contract:valid`), which is part of the identifier rather than a translation.
  const untranslated = [...entries].filter(([, value]) => !CJK.test(value)).map(([key]) => key);
  assert.deepEqual(untranslated, [], 'no English-only user-facing copy remains');
  const translated = [...entries.keys()].filter((key) => !/^[A-Za-z0-9_.:]+$/u.test(key));
  assert.deepEqual(translated, [], 'identifiers and governed values are never translated');
});
