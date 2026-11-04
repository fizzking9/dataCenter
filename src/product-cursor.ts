import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Fail } from './errors.js';

/**
 * What a cursor pins: the Release it walks, the major Contract line it was
 * composed against, the normalized query, and how far that query has been read.
 */
export interface CursorPayload {
  release: number;
  major: number;
  queryHash: string;
  offset: number;
}

const CURSOR_VERSION = 1;
/** A cursor beyond this many rows is not a page, and is refused rather than read. */
const MAX_OFFSET = 1_000_000;
const INVALID = 'DATA_PRODUCT_QUERY_CURSOR_INVALID';

function sign(dataKey: Buffer, body: string): string {
  return createHmac('sha256', dataKey).update(body).digest('base64url');
}

/**
 * Encodes the page position so a Consumer never edits it: the payload is
 * signed with the Deployment's own data key, so a forged or transplanted cursor
 * fails closed instead of paging a different query.
 */
export function encodeCursor(dataKey: Buffer, payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    r: payload.release,
    m: payload.major,
    q: payload.queryHash,
    o: payload.offset,
  })).toString('base64url');
  return `${body}.${sign(dataKey, body)}`;
}

export function decodeCursor(dataKey: Buffer, raw: string, fail: Fail): CursorPayload {
  const [body, signature, ...rest] = raw.split('.');
  if (body === undefined || signature === undefined || rest.length > 0) {
    fail(INVALID, 'A page cursor must be one opaque value this Deployment issued.');
  }
  const expected = Buffer.from(sign(dataKey, body));
  const presented = Buffer.from(signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    fail(INVALID, 'This page cursor was not issued by this Deployment.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    fail(INVALID, 'This page cursor is not readable.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(INVALID, 'This page cursor is not readable.');
  }
  const record = parsed as Record<string, unknown>;
  const release = record['r'];
  const major = record['m'];
  const queryHash = record['q'];
  const offset = record['o'];
  if (record['v'] !== CURSOR_VERSION
    || !Number.isInteger(release) || !Number.isInteger(major)
    || typeof queryHash !== 'string' || !Number.isInteger(offset)
    || (offset as number) < 0 || (offset as number) > MAX_OFFSET) {
    fail(INVALID, 'This page cursor does not state where a page may continue.');
  }
  return {
    release: release as number,
    major: major as number,
    queryHash,
    offset: offset as number,
  };
}
