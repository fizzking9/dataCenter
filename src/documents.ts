import { readFileSync } from 'node:fs';

/** States how a command refuses an unreadable document, so the caller keeps its own error code. */
export type DocumentFailure = (code: string, message: string) => never;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads the value a dotted path names inside a response body, so one acquisition
 * configuration and its integration agree on where the records live without
 * either restating the other's walk.
 */
export function valueAtPath(body: unknown, path: string | null): unknown {
  if (path === null) return body;
  let current: unknown = body;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
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
