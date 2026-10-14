import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { ARGON2_PASSWORD, ARGON2_TOKEN, decryptAtRest, encryptAtRest, hashSecret, timingSafeEqualStrings, verifySecret } from '../../web/lib/server-crypto.ts';
import { generateTotpSecret, hotp, totpAt, verifyTotp } from '../../web/lib/totp.ts';

const argon2 = (nodeCrypto as unknown as { argon2: (a: string, p: Record<string, unknown>, cb: (e: Error | null, k: Buffer) => void) => void }).argon2;

test('argon2id: the platform implementation reproduces the RFC 9106 §5.3 test vector', async () => {
  const tag = await new Promise<Buffer>((resolve, reject) =>
    argon2(
      'argon2id',
      {
        message: Buffer.alloc(32, 0x01),
        nonce: Buffer.alloc(16, 0x02),
        secret: Buffer.alloc(8, 0x03),
        associatedData: Buffer.alloc(12, 0x04),
        parallelism: 4,
        tagLength: 32,
        memory: 32,
        passes: 3,
      },
      (e, k) => (e ? reject(e) : resolve(k)),
    ),
  );
  assert.equal(tag.toString('hex'), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
});

test('argon2id PHC strings: standard format, verify only the right secret, reject malformed input', async () => {
  const phc = await hashSecret('correct horse battery staple', ARGON2_PASSWORD);
  assert.match(phc, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.equal(await verifySecret('correct horse battery staple', phc), true);
  assert.equal(await verifySecret('correct horse battery stapl', phc), false);
  // a fresh salt every time
  assert.notEqual(await hashSecret('x', ARGON2_TOKEN), await hashSecret('x', ARGON2_TOKEN));
  for (const bad of [null, undefined, '', '$argon2i$v=19$m=8,t=1,p=1$AAAA$AAAA', phc.replace('v=19', 'v=16'), phc + '$extra']) {
    assert.equal(await verifySecret('correct horse battery staple', bad), false, String(bad));
  }
});

test('TOTP secret at rest: AES-256-GCM round trip; tampering or a wrong key fails', () => {
  const key = new Uint8Array(nodeCrypto.randomBytes(32));
  const secret = generateTotpSecret();
  const blob = encryptAtRest(key, secret);
  assert.match(blob, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decryptAtRest(key, blob), secret);
  assert.notEqual(encryptAtRest(key, secret), blob, 'fresh IV each time');
  const flipped = blob.slice(0, -2) + (blob.at(-2) === 'A' ? 'B' : 'A') + blob.at(-1);
  assert.throws(() => decryptAtRest(key, flipped));
  assert.throws(() => decryptAtRest(new Uint8Array(nodeCrypto.randomBytes(32)), blob));
  assert.throws(() => decryptAtRest(key, 'v2.' + blob.slice(3)));
});

test('TOTP: RFC 6238 SHA-1 vectors, ±1 step window, and single use', () => {
  // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890" (8 digits there; the last 6 digits here)
  const seed = new TextEncoder().encode('12345678901234567890');
  assert.equal(totpAt(seed, 59_000, 8), '94287082');
  assert.equal(totpAt(seed, 1_111_111_109_000, 8), '07081804');
  assert.equal(totpAt(seed, 2_000_000_000_000, 8), '69279037');
  assert.equal(hotp(seed, 1, 8), '94287082');
  const now = 1_760_400_000_000;
  const code = totpAt(seed, now);
  const step = verifyTotp(seed, code, now + 30_000, 0);
  assert.ok(step !== null, 'accepted within ±1 step');
  assert.equal(verifyTotp(seed, code, now + 30_000, step!), null, 'the same step cannot be used twice');
  assert.equal(verifyTotp(seed, code, now + 90_000, 0), null, 'too old');
  assert.equal(verifyTotp(seed, '12345', now, 0), null);
});

test('timingSafeEqualStrings', () => {
  assert.equal(timingSafeEqualStrings('abc', 'abc'), true);
  assert.equal(timingSafeEqualStrings('abc', 'abd'), false);
  assert.equal(timingSafeEqualStrings('abc', 'abcd'), false);
});
