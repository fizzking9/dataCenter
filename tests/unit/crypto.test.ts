import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { canonicalJson } from '../../src/crypto.js';
import { decrypt, unwrapDataKey, wrapNewDataKey } from '../../src/keys.js';

test('canonical JSON sorts object keys without changing array order', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { b: [2, true, null] } }),
    '{"a":{"b":[2,true,null]},"z":1}',
  );
});

test('envelope encryption round-trips only with the mounted master key', () => {
  const masterKey = randomBytes(32);
  const { dataKey, wrapped } = wrapNewDataKey(masterKey);
  assert.deepEqual(unwrapDataKey(masterKey, wrapped), dataKey);
  assert.throws(() => unwrapDataKey(randomBytes(32), wrapped), { code: 'MASTER_KEY_MISMATCH' });
  const tampered = { ...wrapped, ciphertext: Buffer.from('tampered ciphertext').toString('base64') };
  assert.throws(() => decrypt(masterKey, tampered));
});
