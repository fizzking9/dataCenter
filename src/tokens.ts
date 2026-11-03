import { createHash, timingSafeEqual } from 'node:crypto';

/** Only the hash of a bearer token is ever stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compares two secrets without leaking their common prefix. */
export function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}