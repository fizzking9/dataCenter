import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

export function base32(value: Buffer): string {
  let bits = 0;
  let accumulator = 0;
  let output = '';
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

function unbase32(value: string): Buffer {
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of value.toUpperCase()) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) continue;
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function newTotpSecret(): string {
  return base32(randomBytes(20));
}

export function newRecoveryCode(): string {
  return `${base32(randomBytes(5))}-${base32(randomBytes(5))}`;
}

export function totpCode(secret: string, timestamp: number): string {
  const counter = Math.floor(timestamp / STEP_MS);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac('sha1', unbase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Accepts the current step and one step either side for ordinary clock skew. */
export function verifyTotp(secret: string, code: string, timestamp: number = Date.now()): boolean {
  const candidate = code.trim();
  if (!/^\d{6}$/.test(candidate)) return false;
  for (const offset of [-1, 0, 1]) {
    const expected = Buffer.from(totpCode(secret, timestamp + offset * STEP_MS), 'utf8');
    if (timingSafeEqual(expected, Buffer.from(candidate, 'utf8'))) return true;
  }
  return false;
}
