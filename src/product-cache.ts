import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDigest } from './crypto.js';
import { decrypt, encryptValue, type WrappedValue } from './keys.js';

/**
 * The complete context one page may be reused under. Every element a Reader's
 * answer could depend on is here, so a difference anywhere — a new Release, a
 * changed Grant, a different Reader — is a different key rather than a stale hit.
 */
export interface QueryCacheKey {
  release: number;
  major: number;
  contractHash: string;
  /** The reader the page is bound to: a User or an Agent Identity. */
  subject: string;
  scopeFingerprint: string;
  queryHash: string;
  offset: number;
  limit: number;
}

/** A cached page is a convenience, never a source of truth, so it lives briefly. */
const CACHE_LIFETIME_MS = 5 * 60 * 1000;

interface CacheEntry {
  key: string;
  created_at: string;
  expires_at: string;
  response: WrappedValue;
}

function cachePath(root: string, key: string): string {
  return join(root, 'cache', 'query-results', `${key}.json`);
}

export function queryCacheKey(key: QueryCacheKey): string {
  return canonicalDigest(key);
}

/**
 * Reads a page only when its whole security and Release context still matches.
 * A missing, expired, or unreadable entry is a miss: the answer is computed
 * again from the governed data rather than repaired.
 */
export function readCachedPage(root: string, dataKey: Buffer, key: string): Record<string, unknown> | null {
  const path = cachePath(root, key);
  let entry: CacheEntry;
  try {
    entry = JSON.parse(readFileSync(path, 'utf8')) as CacheEntry;
  } catch {
    return null;
  }
  if (entry.key !== key || Date.parse(entry.expires_at) <= Date.now()) {
    try {
      rmSync(path, { force: true });
    } catch {
      // An unreadable cache object is already unusable.
    }
    return null;
  }
  try {
    return JSON.parse(decrypt(dataKey, entry.response).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function writeCachedPage(
  root: string,
  dataKey: Buffer,
  key: string,
  response: Record<string, unknown>,
): void {
  const now = Date.now();
  const entry: CacheEntry = {
    key,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + CACHE_LIFETIME_MS).toISOString(),
    response: encryptValue(dataKey, Buffer.from(JSON.stringify(response), 'utf8')),
  };
  const path = cachePath(root, key);
  try {
    mkdirSync(join(root, 'cache', 'query-results'), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // A cache that cannot be written is a miss on the next read, never a failed query.
  }
}
