import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('Canonical JSON cannot encode undefined.');
  }
  return encoded;
}

/** The content address of a governed value: identical content, identical digest. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function publicKeyFromFile(path: string): KeyObject {
  return createPublicKey(readFileSync(path, 'utf8'));
}

export function keyFingerprint(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
