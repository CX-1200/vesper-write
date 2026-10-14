// §8.2/§8.3 envelopes: HPKE (RFC 9180) base mode with
// DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM, via the zero-dependency
// `hpke` package. HPKE derives the AEAD nonce from its key schedule, so the
// envelope carries no separate IV.

import * as HPKE from 'hpke';
import { joinFields } from './canonical.ts';
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from './encoding.ts';
import { jwkFromRawPoint, rawPointFromJwk, type EcPublicJwk } from './keys.ts';

export const ENVELOPE_ALG = 'HPKE-Base-P256-SHA256-A256GCM';
export const ENVELOPE_VERSION = 1;

/** Upper bound for a single envelope's ciphertext (raw input or prompt). */
export const MAX_ENVELOPE_CT_BYTES = 256 * 1024;

const suite = new HPKE.CipherSuite(HPKE.KEM_DHKEM_P256_HKDF_SHA256, HPKE.KDF_HKDF_SHA256, HPKE.AEAD_AES_256_GCM);

export interface Envelope {
  v: 1;
  alg: typeof ENVELOPE_ALG;
  /** encapsulated ephemeral public key (65 bytes), base64url */
  enc: string;
  /** ciphertext + 16-byte GCM tag, base64url */
  ct: string;
}

export interface HpkeKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

export const HPKE_INFO = {
  in: utf8('vesper/in/v1'),
  out: utf8('vesper/out/v1'),
} as const;

export type Target = 'claude_ai' | 'claude_code';

/** Device → VM AAD: "vesper/in/v1" | ticket_id | type | target | device_id | ts */
export function inputAad(a: { ticketId: string; type: string; target: Target; deviceId: string; ts: number }): Uint8Array {
  return utf8(joinFields(['vesper/in/v1', a.ticketId, a.type, a.target, a.deviceId, a.ts]));
}

/** VM → device AAD: "vesper/out/v1" | ticket_id | type | target | recipient_device_id | processed_at */
export function outputAad(a: {
  ticketId: string;
  type: string;
  target: Target;
  recipientDeviceId: string;
  processedAt: number;
}): Uint8Array {
  return utf8(joinFields(['vesper/out/v1', a.ticketId, a.type, a.target, a.recipientDeviceId, a.processedAt]));
}

export async function generateHpkeKeyPair(extractable = false): Promise<HpkeKeyPair> {
  const kp = await suite.GenerateKeyPair(extractable);
  return { publicKey: kp.publicKey as CryptoKey, privateKey: kp.privateKey as CryptoKey };
}

export async function hpkePublicKeyFromJwk(jwk: EcPublicJwk): Promise<CryptoKey> {
  return (await suite.DeserializePublicKey(rawPointFromJwk(jwk))) as CryptoKey;
}

export async function hpkePublicKeyToJwk(key: CryptoKey): Promise<EcPublicJwk> {
  return jwkFromRawPoint(await suite.SerializePublicKey(key));
}

export async function seal(
  recipientPublicKey: CryptoKey,
  plaintext: Uint8Array,
  opts: { info: Uint8Array; aad: Uint8Array },
): Promise<Envelope> {
  const { encapsulatedSecret, ciphertext } = await suite.Seal(recipientPublicKey, plaintext, opts);
  return { v: 1, alg: ENVELOPE_ALG, enc: b64urlEncode(encapsulatedSecret), ct: b64urlEncode(ciphertext) };
}

/** Throws EnvelopeError if the envelope is malformed or authentication fails (wrong key, AAD or info). */
export async function open(
  recipient: HpkeKeyPair,
  envelope: Envelope,
  opts: { info: Uint8Array; aad: Uint8Array },
): Promise<Uint8Array> {
  const env = parseEnvelope(envelope);
  try {
    return await suite.Open(recipient, b64urlDecode(env.enc), b64urlDecode(env.ct), opts);
  } catch {
    throw new EnvelopeError('decryption failed');
  }
}

export async function sealJson(
  recipientPublicKey: CryptoKey,
  value: unknown,
  opts: { info: Uint8Array; aad: Uint8Array },
): Promise<Envelope> {
  return seal(recipientPublicKey, utf8(JSON.stringify(value)), opts);
}

export async function openJson<T = unknown>(
  recipient: HpkeKeyPair,
  envelope: Envelope,
  opts: { info: Uint8Array; aad: Uint8Array },
): Promise<T> {
  const bytes = await open(recipient, envelope, opts);
  try {
    return JSON.parse(fromUtf8(bytes)) as T;
  } catch {
    throw new EnvelopeError('plaintext is not JSON');
  }
}

/** Validates the envelope shape strictly and returns a clean copy (no extra fields). */
export function parseEnvelope(input: unknown): Envelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EnvelopeError('envelope must be an object');
  const e = input as Record<string, unknown>;
  const keys = Object.keys(e).sort().join(',');
  if (keys !== 'alg,ct,enc,v') throw new EnvelopeError('unexpected envelope fields');
  if (e.v !== ENVELOPE_VERSION) throw new EnvelopeError('unsupported envelope version');
  if (e.alg !== ENVELOPE_ALG) throw new EnvelopeError('unsupported envelope alg');
  let enc: Uint8Array;
  let ct: Uint8Array;
  try {
    enc = b64urlDecode(e.enc as string);
    ct = b64urlDecode(e.ct as string);
  } catch {
    throw new EnvelopeError('envelope fields must be base64url');
  }
  if (enc.length !== 65 || enc[0] !== 0x04) throw new EnvelopeError('bad encapsulated key');
  if (ct.length < 16 || ct.length > MAX_ENVELOPE_CT_BYTES + 16) throw new EnvelopeError('bad ciphertext length');
  return { v: 1, alg: ENVELOPE_ALG, enc: e.enc as string, ct: e.ct as string };
}

/** Exposed for the RFC 9180 test-vector tests only. */
export const __suiteForTests = suite;
