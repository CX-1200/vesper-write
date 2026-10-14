import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertValidPublicJwk,
  exportPublicJwk,
  generateSigningKeyPair,
  importEncPrivateKey,
  importSigningKey,
  importVerifyKey,
  KeyFormatError,
  parsePublicJwk,
  spkiFromJwk,
} from '@vesper/core/keys';
import { computeFingerprint, formatFingerprint, normalizeFingerprint, FINGERPRINT_RE } from '@vesper/core/fingerprint';
import {
  approvalSigningString,
  isFresh,
  outputSigningString,
  requestSigningString,
  signRequest,
  signString,
  verifyOutput,
  verifyRequestSignature,
  verifyString,
} from '@vesper/core/sign';
import { HPKE_INFO, hpkePublicKeyFromJwk, inputAad, openJson, outputAad } from '@vesper/core/envelope';
import { canonicalJson } from '@vesper/core/canonical';
import { getSubtle, toHex } from '@vesper/core/encoding';

const V = JSON.parse(readFileSync(new URL('../fixtures/vesper-vectors.json', import.meta.url), 'utf8'));

// ---- test vectors (§8): recompute everything from the fixed keys ----------------

test('vectors: SPKI rebuilt from JWK matches the reference bytes and WebCrypto export', async () => {
  assert.equal(toHex(spkiFromJwk(V.device.sign_public_jwk)), V.expected.device_sign_spki_hex);
  assert.equal(toHex(spkiFromJwk(V.device.enc_public_jwk)), V.expected.device_enc_spki_hex);
  const key = await importVerifyKey(V.device.sign_public_jwk);
  const exported = new Uint8Array(await getSubtle().exportKey('spki', key));
  assert.equal(toHex(exported), V.expected.device_sign_spki_hex);
});

test('vectors: fingerprints', async () => {
  assert.equal(await computeFingerprint(V.device.sign_public_jwk, V.device.enc_public_jwk), V.expected.device_fingerprint);
  assert.equal(await computeFingerprint(V.vm.sign_public_jwk, V.vm.enc_public_jwk), V.expected.vm_fingerprint);
  assert.match(V.expected.device_fingerprint, FINGERPRINT_RE);
});

test('vectors: AAD strings', () => {
  const t = V.ticket;
  assert.equal(new TextDecoder().decode(inputAad({ ticketId: t.id, type: t.type, target: t.target, deviceId: t.device_id, ts: t.ts })), V.expected.input_aad);
  assert.equal(
    new TextDecoder().decode(outputAad({ ticketId: t.id, type: t.type, target: t.target, recipientDeviceId: t.device_id, processedAt: V.output.processed_at })),
    V.expected.output_aad,
  );
});

test('vectors: VM opens the reference input envelope and verifies the device request signature', async () => {
  const t = V.ticket;
  const vmKeys = {
    privateKey: await importEncPrivateKey(V.vm.enc_private_jwk),
    publicKey: await hpkePublicKeyFromJwk(V.vm.enc_public_jwk),
  };
  const aad = inputAad({ ticketId: t.id, type: t.type, target: t.target, deviceId: t.device_id, ts: t.ts });
  assert.deepEqual(await openJson(vmKeys, V.input.envelope, { info: HPKE_INFO.in, aad }), V.input.plaintext);

  const body = canonicalJson({ ...t, input_envelope: V.input.envelope });
  assert.equal(body, V.input.body);
  const req = { method: 'POST', path: '/api/tickets', ts: t.ts, nonce: V.input.nonce, body };
  assert.equal(await requestSigningString(req), V.input.request_signing_string);
  const devicePub = await importVerifyKey(V.device.sign_public_jwk);
  assert.equal(await verifyRequestSignature(devicePub, req, V.input.request_signature), true);
});

test('vectors: device opens the reference output envelope and verifies the VM output signature', async () => {
  const t = V.ticket;
  const deviceKeys = {
    privateKey: await importEncPrivateKey(V.device.enc_private_jwk),
    publicKey: await hpkePublicKeyFromJwk(V.device.enc_public_jwk),
  };
  const aad = outputAad({ ticketId: t.id, type: t.type, target: t.target, recipientDeviceId: t.device_id, processedAt: V.output.processed_at });
  assert.deepEqual(await openJson(deviceKeys, V.output.envelopes[t.device_id], { info: HPKE_INFO.out, aad }), V.output.plaintext);
  assert.equal(await outputSigningString(t.id, V.output.envelopes), V.output.signing_string);
  const vmPub = await importVerifyKey(V.vm.sign_public_jwk);
  assert.equal(await verifyOutput(vmPub, t.id, V.output.envelopes, V.output.signature), true);
});

test('vectors: VM approval signature', async () => {
  assert.equal(approvalSigningString(V.approval.record), V.approval.signing_string);
  const vmPub = await importVerifyKey(V.vm.sign_public_jwk);
  assert.equal(await verifyString(vmPub, V.approval.signing_string, V.approval.signature), true);
});

// ---- signature negative tests ---------------------------------------------------

test('request signature fails when any signed component changes', async () => {
  const kp = await generateSigningKeyPair();
  const req = { method: 'POST', path: '/api/tickets', ts: 1760400000000, nonce: 'AAECAwQFBgcICQoLDA0ODw', body: '{"a":1}' };
  const sig = await signRequest(kp.privateKey, req);
  assert.equal(await verifyRequestSignature(kp.publicKey, req, sig), true);
  const mutations = [
    { ...req, method: 'PUT' },
    { ...req, path: '/api/tickets/x' },
    { ...req, path: '/api/tickets?x=1' },
    { ...req, ts: req.ts + 1 },
    { ...req, nonce: 'AAECAwQFBgcICQoLDA0OEA' },
    { ...req, body: '{"a":2}' },
  ];
  for (const m of mutations) assert.equal(await verifyRequestSignature(kp.publicKey, m, sig), false, JSON.stringify(m));
  const other = await generateSigningKeyPair();
  assert.equal(await verifyRequestSignature(other.publicKey, req, sig), false);
  assert.equal(await verifyRequestSignature(kp.publicKey, req, 'garbage'), false);
  assert.equal(await verifyRequestSignature(kp.publicKey, req, sig.slice(0, -2)), false);
});

test('output signature fails if an envelope is swapped, removed or added', async () => {
  const kp = await generateSigningKeyPair();
  const envs = V.output.envelopes as Record<string, unknown>;
  const sig = await signString(kp.privateKey, await outputSigningString(V.ticket.id, envs));
  assert.equal(await verifyOutput(kp.publicKey, V.ticket.id, envs, sig), true);
  assert.equal(await verifyOutput(kp.publicKey, 'another-ticket', envs, sig), false);
  assert.equal(await verifyOutput(kp.publicKey, V.ticket.id, {}, sig), false);
  assert.equal(await verifyOutput(kp.publicKey, V.ticket.id, { ...envs, extra: V.input.envelope }, sig), false);
  const tampered = structuredClone(envs) as Record<string, { ct: string }>;
  const first = Object.keys(tampered)[0]!;
  tampered[first]!.ct = tampered[first]!.ct.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal(await verifyOutput(kp.publicKey, V.ticket.id, tampered, sig), false);
});

test('signature purposes are domain-separated', async () => {
  const kp = await generateSigningKeyPair();
  const approvalText = approvalSigningString({ deviceId: 'd', fingerprint: '00000 00000 00000 00000 00000 00000', approvedAt: 1 });
  const sig = await signString(kp.privateKey, approvalText);
  // The same signature must not validate as an output signature or a request signature.
  assert.equal(await verifyOutput(kp.publicKey, 'd', {}, sig), false);
  assert.equal(await verifyRequestSignature(kp.publicKey, { method: 'POST', path: '/', ts: 1, nonce: 'AAECAwQFBgcICQoLDA0ODw', body: '' }, sig), false);
});

test('isFresh enforces the ±60 s window', () => {
  const now = 1_760_400_000_000;
  assert.equal(isFresh(now, now), true);
  assert.equal(isFresh(now - 60_000, now), true);
  assert.equal(isFresh(now + 60_000, now), true);
  assert.equal(isFresh(now - 60_001, now), false);
  assert.equal(isFresh(now + 60_001, now), false);
  assert.equal(isFresh(Number.NaN, now), false);
  assert.equal(isFresh(1.5, now), false);
});

// ---- keys and fingerprints ------------------------------------------------------

test('parsePublicJwk strips extra fields and rejects private or malformed keys', () => {
  const jwk = { ...V.device.sign_public_jwk, ext: true, key_ops: ['verify'], alg: 'ES256' };
  assert.deepEqual(Object.keys(parsePublicJwk(jwk)).sort(), ['crv', 'kty', 'x', 'y']);
  assert.throws(() => parsePublicJwk(V.device.sign_private_jwk), KeyFormatError);
  assert.throws(() => parsePublicJwk({ ...V.device.sign_public_jwk, crv: 'P-384' }), KeyFormatError);
  assert.throws(() => parsePublicJwk({ ...V.device.sign_public_jwk, x: 'AAAA' }), KeyFormatError);
  assert.throws(() => parsePublicJwk(null), KeyFormatError);
});

test('assertValidPublicJwk rejects points that are not on the curve', async () => {
  const offCurve = { ...V.device.sign_public_jwk, y: V.device.sign_public_jwk.x };
  await assert.rejects(assertValidPublicJwk(offCurve), KeyFormatError);
  await assertValidPublicJwk(V.device.sign_public_jwk);
});

test('exported public JWK of a fresh key pair has only the four fields', async () => {
  const kp = await generateSigningKeyPair();
  assert.equal(kp.privateKey.extractable, false);
  const jwk = await exportPublicJwk(kp.publicKey);
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'kty', 'x', 'y']);
});

test('importSigningKey produces signatures that verify with the public JWK', async () => {
  const priv = await importSigningKey(V.vm.sign_private_jwk);
  assert.equal(priv.extractable, false);
  const sig = await signString(priv, 'hello');
  assert.equal(await verifyString(await importVerifyKey(V.vm.sign_public_jwk), 'hello', sig), true);
});

test('fingerprint formatting and normalization', () => {
  assert.equal(formatFingerprint(new Uint8Array(15)), '00000 00000 00000 00000 00000 00000');
  // 2^120 - 1 = 1329227995784915872903807060280344575 → lowest 30 decimal digits
  assert.equal(formatFingerprint(new Uint8Array(15).fill(0xff)), '99578 49158 72903 80706 02803 44575');
  assert.equal(normalizeFingerprint('58196-32499-71945-16415-29964-28485'), '58196 32499 71945 16415 29964 28485');
  assert.equal(normalizeFingerprint('5819632499719451641529964284850'), null);
  assert.throws(() => formatFingerprint(new Uint8Array(16)));
});

test('fingerprint changes when either key changes, and depends on key order', async () => {
  const a = await computeFingerprint(V.device.sign_public_jwk, V.device.enc_public_jwk);
  const b = await computeFingerprint(V.vm.sign_public_jwk, V.device.enc_public_jwk);
  const c = await computeFingerprint(V.device.sign_public_jwk, V.vm.enc_public_jwk);
  const d = await computeFingerprint(V.device.enc_public_jwk, V.device.sign_public_jwk);
  assert.equal(new Set([a, b, c, d]).size, 4);
});
