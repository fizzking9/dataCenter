import { readFileSync } from 'node:fs';

/** States how a command refuses an unreadable document, so the caller keeps its own error code. */
export type DocumentFailure = (code: string, message: string) => never;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads one JSON document a command was given by path, failing closed when it is unusable. */
export function readJsonDocument(
  path: string,
  fail: DocumentFailure,
  code: string,
  message: string,
): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail(code, message);
  }
}
