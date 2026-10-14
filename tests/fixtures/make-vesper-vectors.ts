// Generates tests/fixtures/vesper-vectors.json: fixed TEST-ONLY keys plus the
// expected outputs of every Vesper-specific encoding (SPKI, fingerprint, AAD,
// signing strings) and one sealed envelope / signature per direction.
// Run once: node tests/fixtures/make-vesper-vectors.ts > tests/fixtures/vesper-vectors.json
// The committed file is the reference; tests recompute everything and compare.

import { exportPrivateJwk, exportPublicJwk, generateSigningKeyPair, spkiFromJwk } from '@vesper/core/keys';
import { generateHpkeKeyPair, hpkePublicKeyToJwk, HPKE_INFO, inputAad, outputAad, sealJson } from '@vesper/core/envelope';
import { computeFingerprint } from '@vesper/core/fingerprint';
import { approvalSigningString, outputSigningString, requestSigningString, signString } from '@vesper/core/sign';
import { canonicalJson } from '@vesper/core/canonical';
import { toHex } from '@vesper/core/encoding';

async function keyset() {
  const sign = await generateSigningKeyPair(true);
  const enc = await generateHpkeKeyPair(true);
  return {
    sign,
    enc,
    json: {
      sign_private_jwk: await exportPrivateJwk(sign.privateKey),
      sign_public_jwk: await exportPublicJwk(sign.publicKey),
      enc_private_jwk: await exportPrivateJwk(enc.privateKey),
      enc_public_jwk: await hpkePublicKeyToJwk(enc.publicKey),
    },
  };
}

const device = await keyset();
const vm = await keyset();

const ticket = {
  id: '6f1c2a4e-3b5d-4c7e-8f90-a1b2c3d4e5f6',
  type: 'general',
  target: 'claude_code' as const,
  device_id: '0b7e1d2c-9a8f-4e6d-8c5b-4a3f2e1d0c9b',
  ts: 1760400000000,
};
const processedAt = 1760400123456;
const inAad = inputAad({ ticketId: ticket.id, type: ticket.type, target: ticket.target, deviceId: ticket.device_id, ts: ticket.ts });
const outAad = outputAad({ ticketId: ticket.id, type: ticket.type, target: ticket.target, recipientDeviceId: ticket.device_id, processedAt });

const inputPlain = { raw_input: '帮我整理今天会议的重点，输出成清单' };
const inputEnvelope = await sealJson(vm.enc.publicKey, inputPlain, { info: HPKE_INFO.in, aad: inAad });
const body = canonicalJson({ ...ticket, input_envelope: inputEnvelope });
const nonce = 'AAECAwQFBgcICQoLDA0ODw';
const reqString = await requestSigningString({ method: 'POST', path: '/api/tickets', ts: ticket.ts, nonce, body });
const reqSig = await signString(device.sign.privateKey, reqString);

const outputPlain = { prompt: '请把以下会议重点整理成清单……', lint: [], model: 'claude-haiku-5-5', raw_input: inputPlain.raw_input, truncated: false, limits: { max_chars: 6000, typical_chars: 2500 } };
const outputEnvelope = await sealJson(device.enc.publicKey, outputPlain, { info: HPKE_INFO.out, aad: outAad });
const outputEnvelopes = { [ticket.device_id]: outputEnvelope };
const outString = await outputSigningString(ticket.id, outputEnvelopes);
const outSig = await signString(vm.sign.privateKey, outString);

const deviceFp = await computeFingerprint(device.json.sign_public_jwk, device.json.enc_public_jwk);
const approval = { deviceId: ticket.device_id, fingerprint: deviceFp, approvedAt: 1760400200000 };
const approvalString = approvalSigningString(approval);
const approvalSig = await signString(vm.sign.privateKey, approvalString);

const vectors = {
  _warning: 'TEST-ONLY keys. Never use these keys for anything real.',
  device: device.json,
  vm: vm.json,
  expected: {
    device_sign_spki_hex: toHex(spkiFromJwk(device.json.sign_public_jwk)),
    device_enc_spki_hex: toHex(spkiFromJwk(device.json.enc_public_jwk)),
    device_fingerprint: deviceFp,
    vm_fingerprint: await computeFingerprint(vm.json.sign_public_jwk, vm.json.enc_public_jwk),
    input_aad: new TextDecoder().decode(inAad),
    output_aad: new TextDecoder().decode(outAad),
  },
  ticket,
  input: { plaintext: inputPlain, envelope: inputEnvelope, body, nonce, request_signing_string: reqString, request_signature: reqSig },
  output: { processed_at: processedAt, plaintext: outputPlain, envelopes: outputEnvelopes, signing_string: outString, signature: outSig },
  approval: { record: approval, signing_string: approvalString, signature: approvalSig },
};

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
