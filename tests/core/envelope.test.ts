import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  __suiteForTests as suite,
  EnvelopeError,
  generateHpkeKeyPair,
  HPKE_INFO,
  hpkePublicKeyFromJwk,
  hpkePublicKeyToJwk,
  inputAad,
  open,
  openJson,
  outputAad,
  parseEnvelope,
  seal,
  sealJson,
  type Envelope,
} from '@vesper/core/envelope';
import { b64urlDecode, b64urlEncode, fromHex, toHex, utf8 } from '@vesper/core/encoding';

const rfc = JSON.parse(readFileSync(new URL('../fixtures/hpke-rfc9180-p256-sha256-aes256gcm.json', import.meta.url), 'utf8'));

test('RFC 9180 vector: our suite opens the official ciphertext (single-shot, seq 0)', async () => {
  const keyPair = {
    privateKey: (await suite.DeserializePrivateKey(fromHex(rfc.skRm), false)) as CryptoKey,
    publicKey: (await suite.DeserializePublicKey(fromHex(rfc.pkRm))) as CryptoKey,
  };
  const e0 = rfc.encryptions[0];
  const pt = await suite.Open(keyPair, fromHex(rfc.enc), fromHex(e0.ct), { aad: fromHex(e0.aad), info: fromHex(rfc.info) });
  assert.equal(toHex(pt), e0.pt);
});

test('RFC 9180 vector: context API reproduces the first four sequence numbers', async () => {
  const keyPair = {
    privateKey: (await suite.DeserializePrivateKey(fromHex(rfc.skRm), false)) as CryptoKey,
    publicKey: (await suite.DeserializePublicKey(fromHex(rfc.pkRm))) as CryptoKey,
  };
  const ctx = await suite.SetupRecipient(keyPair, fromHex(rfc.enc), { info: fromHex(rfc.info) });
  for (const e of rfc.encryptions) {
    assert.equal(toHex(await ctx.Open(fromHex(e.ct), fromHex(e.aad))), e.pt);
  }
});

test('RFC 9180 vector: DeriveKeyPair(ikmR) yields pkRm', async () => {
  const kp = await suite.DeriveKeyPair(fromHex(rfc.ikmR), false);
  assert.equal(toHex(await suite.SerializePublicKey(kp.publicKey)), rfc.pkRm);
});

const T = {
  ticketId: '6f1c2a4e-3b5d-4c7e-8f90-a1b2c3d4e5f6',
  type: 'general',
  target: 'claude_code' as const,
  deviceId: '0b7e1d2c-9a8f-4e6d-8c5b-4a3f2e1d0c9b',
  ts: 1760400000000,
};

test('device → VM round trip with the input AAD', async () => {
  const vm = await generateHpkeKeyPair();
  const env = await sealJson(vm.publicKey, { raw_input: '帮我写一封请假邮件' }, { info: HPKE_INFO.in, aad: inputAad(T) });
  assert.deepEqual(parseEnvelope(env), env);
  assert.deepEqual(await openJson(vm, env, { info: HPKE_INFO.in, aad: inputAad(T) }), { raw_input: '帮我写一封请假邮件' });
});

test('AAD binding: moving ciphertext to another ticket, type, target, device or ts fails', async () => {
  const vm = await generateHpkeKeyPair();
  const env = await sealJson(vm.publicKey, { raw_input: 'x' }, { info: HPKE_INFO.in, aad: inputAad(T) });
  const variants = [
    { ...T, ticketId: '7f1c2a4e-3b5d-4c7e-8f90-a1b2c3d4e5f6' },
    { ...T, type: 'coding' },
    { ...T, target: 'claude_ai' as const },
    { ...T, deviceId: '1b7e1d2c-9a8f-4e6d-8c5b-4a3f2e1d0c9b' },
    { ...T, ts: T.ts + 1 },
  ];
  for (const v of variants) {
    await assert.rejects(openJson(vm, env, { info: HPKE_INFO.in, aad: inputAad(v) }), EnvelopeError);
  }
});

test('direction binding: an input envelope cannot be opened as an output (different info and AAD prefix)', async () => {
  const kp = await generateHpkeKeyPair();
  const env = await seal(kp.publicKey, utf8('x'), { info: HPKE_INFO.in, aad: inputAad(T) });
  await assert.rejects(open(kp, env, { info: HPKE_INFO.out, aad: inputAad(T) }), EnvelopeError);
  const outAad = outputAad({ ticketId: T.ticketId, type: T.type, target: T.target, recipientDeviceId: T.deviceId, processedAt: T.ts });
  await assert.rejects(open(kp, env, { info: HPKE_INFO.in, aad: outAad }), EnvelopeError);
});

test('output AAD binding: recipient device and processed_at are bound', async () => {
  const dev = await generateHpkeKeyPair();
  const base = { ticketId: T.ticketId, type: T.type, target: T.target, recipientDeviceId: T.deviceId, processedAt: 1760400100000 };
  const env = await sealJson(dev.publicKey, { prompt: 'p' }, { info: HPKE_INFO.out, aad: outputAad(base) });
  assert.deepEqual(await openJson(dev, env, { info: HPKE_INFO.out, aad: outputAad(base) }), { prompt: 'p' });
  await assert.rejects(openJson(dev, env, { info: HPKE_INFO.out, aad: outputAad({ ...base, recipientDeviceId: 'other' }) }), EnvelopeError);
  await assert.rejects(openJson(dev, env, { info: HPKE_INFO.out, aad: outputAad({ ...base, processedAt: base.processedAt + 1 }) }), EnvelopeError);
});

test('wrong recipient key fails', async () => {
  const a = await generateHpkeKeyPair();
  const b = await generateHpkeKeyPair();
  const env = await seal(a.publicKey, utf8('x'), { info: HPKE_INFO.in, aad: inputAad(T) });
  await assert.rejects(open(b, env, { info: HPKE_INFO.in, aad: inputAad(T) }), EnvelopeError);
});

test('tampering with ct or enc fails', async () => {
  const kp = await generateHpkeKeyPair();
  const env = await seal(kp.publicKey, utf8('hello'), { info: HPKE_INFO.in, aad: inputAad(T) });
  const ct = b64urlDecode(env.ct);
  ct[0] = ct[0]! ^ 1;
  await assert.rejects(open(kp, { ...env, ct: b64urlEncode(ct) }, { info: HPKE_INFO.in, aad: inputAad(T) }), EnvelopeError);
  const other = await seal(kp.publicKey, utf8('hello'), { info: HPKE_INFO.in, aad: inputAad(T) });
  await assert.rejects(open(kp, { ...env, enc: other.enc }, { info: HPKE_INFO.in, aad: inputAad(T) }), EnvelopeError);
});

test('private keys are non-extractable by default and public keys round-trip through JWK', async () => {
  const kp = await generateHpkeKeyPair();
  assert.equal(kp.privateKey.extractable, false);
  const jwk = await hpkePublicKeyToJwk(kp.publicKey);
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'kty', 'x', 'y']);
  const pub = await hpkePublicKeyFromJwk(jwk);
  const env = await seal(pub, utf8('x'), { info: HPKE_INFO.out, aad: utf8('a') });
  assert.equal(new TextDecoder().decode(await open(kp, env, { info: HPKE_INFO.out, aad: utf8('a') })), 'x');
});

test('parseEnvelope is strict', async () => {
  const kp = await generateHpkeKeyPair();
  const env = await seal(kp.publicKey, utf8('x'), { info: HPKE_INFO.in, aad: utf8('a') });
  const bad: unknown[] = [
    null,
    [],
    { ...env, extra: 1 },
    { ...env, v: 2 },
    { ...env, alg: 'something-else' },
    { ...env, enc: 'not base64url!' },
    { ...env, enc: env.enc.slice(0, 10) },
    { ...env, ct: '' },
    (({ ct: _ct, ...rest }) => rest)(env as Envelope),
  ];
  for (const b of bad) assert.throws(() => parseEnvelope(b), EnvelopeError, JSON.stringify(b));
});
