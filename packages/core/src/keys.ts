// P-256 key handling. Public keys travel and are stored as minimal JWKs
// ({kty, crv, x, y}); their SPKI DER form is rebuilt from x and y so every
// platform computes byte-identical fingerprints.

import { b64urlDecode, b64urlEncode, concatBytes, fromHex, getSubtle } from './encoding.ts';

export interface EcPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface EcPrivateJwk extends EcPublicJwk {
  d: string;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** DER prefix of SubjectPublicKeyInfo for id-ecPublicKey + prime256v1 with an uncompressed point. */
const P256_SPKI_PREFIX = fromHex('3059301306072a8648ce3d020106082a8648ce3d030107034200');

export class KeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyFormatError';
  }
}

function coord(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new KeyFormatError(`jwk.${name} missing`);
  let bytes: Uint8Array;
  try {
    bytes = b64urlDecode(value);
  } catch {
    throw new KeyFormatError(`jwk.${name} is not base64url`);
  }
  if (bytes.length !== 32) throw new KeyFormatError(`jwk.${name} must be 32 bytes`);
  return value;
}

/** Validate shape and strip every field except kty/crv/x/y. Does not check the point is on the curve. */
export function parsePublicJwk(input: unknown): EcPublicJwk {
  if (!input || typeof input !== 'object') throw new KeyFormatError('jwk must be an object');
  const j = input as Record<string, unknown>;
  if (j.kty !== 'EC' || j.crv !== 'P-256') throw new KeyFormatError('jwk must be EC P-256');
  if ('d' in j) throw new KeyFormatError('public jwk must not contain a private component');
  return { kty: 'EC', crv: 'P-256', x: coord(j.x, 'x'), y: coord(j.y, 'y') };
}

export function parsePrivateJwk(input: unknown): EcPrivateJwk {
  if (!input || typeof input !== 'object') throw new KeyFormatError('jwk must be an object');
  const j = input as Record<string, unknown>;
  if (j.kty !== 'EC' || j.crv !== 'P-256') throw new KeyFormatError('jwk must be EC P-256');
  return { kty: 'EC', crv: 'P-256', x: coord(j.x, 'x'), y: coord(j.y, 'y'), d: coord(j.d, 'd') };
}

/** 0x04 || x || y */
export function rawPointFromJwk(jwk: EcPublicJwk): Uint8Array {
  return concatBytes(new Uint8Array([0x04]), b64urlDecode(jwk.x), b64urlDecode(jwk.y));
}

export function jwkFromRawPoint(point: Uint8Array): EcPublicJwk {
  if (point.length !== 65 || point[0] !== 0x04) throw new KeyFormatError('expected an uncompressed P-256 point');
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(point.subarray(1, 33)), y: b64urlEncode(point.subarray(33, 65)) };
}

/** SubjectPublicKeyInfo DER (91 bytes) rebuilt from the JWK coordinates. */
export function spkiFromJwk(jwk: EcPublicJwk): Uint8Array {
  return concatBytes(P256_SPKI_PREFIX, rawPointFromJwk(jwk));
}

export function samePublicJwk(a: EcPublicJwk, b: EcPublicJwk): boolean {
  return a.x === b.x && a.y === b.y && a.kty === b.kty && a.crv === b.crv;
}

// ---- ECDSA signing keys ----------------------------------------------------

export async function generateSigningKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return (await getSubtle().generateKey(ECDSA, extractable, ['sign', 'verify'])) as CryptoKeyPair;
}

/** Import a public key for signature verification. Rejects points that are not on the curve. */
export async function importVerifyKey(jwk: EcPublicJwk): Promise<CryptoKey> {
  return getSubtle().importKey('jwk', { ...parsePublicJwk(jwk), ext: true }, ECDSA, true, ['verify']);
}

export async function importSigningKey(jwk: EcPrivateJwk, extractable = false): Promise<CryptoKey> {
  return getSubtle().importKey('jwk', { ...parsePrivateJwk(jwk), ext: extractable }, ECDSA, extractable, ['sign']);
}

// ---- ECDH (HPKE KEM) keys ---------------------------------------------------

export async function importEncPrivateKey(jwk: EcPrivateJwk, extractable = false): Promise<CryptoKey> {
  return getSubtle().importKey('jwk', { ...parsePrivateJwk(jwk), ext: extractable }, ECDH, extractable, ['deriveBits']);
}

export async function importEncPublicKey(jwk: EcPublicJwk): Promise<CryptoKey> {
  return getSubtle().importKey('jwk', { ...parsePublicJwk(jwk), ext: true }, ECDH, true, []);
}

// ---- export ----------------------------------------------------------------

export async function exportPublicJwk(key: CryptoKey): Promise<EcPublicJwk> {
  if (key.type !== 'public') throw new KeyFormatError('expected a public key');
  return parsePublicJwk(stripJwk(await getSubtle().exportKey('jwk', key)));
}

export async function exportPrivateJwk(key: CryptoKey): Promise<EcPrivateJwk> {
  if (key.type !== 'private') throw new KeyFormatError('expected a private key');
  return parsePrivateJwk(await getSubtle().exportKey('jwk', key));
}

function stripJwk(jwk: JsonWebKey): Record<string, unknown> {
  const { kty, crv, x, y } = jwk;
  return { kty, crv, x, y };
}

/** Verifies the JWK describes a real point on P-256 (WebCrypto validates on import). */
export async function assertValidPublicJwk(jwk: unknown): Promise<EcPublicJwk> {
  const parsed = parsePublicJwk(jwk);
  try {
    await importVerifyKey(parsed);
  } catch {
    throw new KeyFormatError('jwk is not a valid P-256 public key');
  }
  return parsed;
}
