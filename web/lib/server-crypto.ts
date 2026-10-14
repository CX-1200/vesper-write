// Server-only crypto helpers: argon2id (Node ≥ 24.7 built-in), session-id
// hashing, AES-256-GCM for the TOTP secret, constant-time comparison.

import * as nodeCrypto from 'node:crypto';
import { b64urlDecode, b64urlEncode, utf8 } from '@vesper/core/encoding';

type Argon2Fn = (
  algorithm: 'argon2id',
  params: { message: Uint8Array; nonce: Uint8Array; parallelism: number; tagLength: number; memory: number; passes: number },
  cb: (err: Error | null, key: Buffer) => void,
) => void;

const argon2 = (nodeCrypto as unknown as { argon2?: Argon2Fn }).argon2;

export interface Argon2Params {
  memory: number; // KiB
  passes: number;
  parallelism: number;
}

/** OD2: passwords get the heavier parameters. */
export const ARGON2_PASSWORD: Argon2Params = { memory: 65536, passes: 3, parallelism: 1 };
/** High-entropy random tokens (≥ 256 bits): OWASP minimum parameters are plenty. */
export const ARGON2_TOKEN: Argon2Params = { memory: 19456, passes: 2, parallelism: 1 };

function argon2id(message: Uint8Array, salt: Uint8Array, p: Argon2Params, tagLength = 32): Promise<Uint8Array> {
  if (!argon2) throw new Error('crypto.argon2 is unavailable: Node.js 24.7 or later is required');
  return new Promise((resolve, reject) =>
    argon2('argon2id', { message, nonce: salt, parallelism: p.parallelism, tagLength, memory: p.memory, passes: p.passes }, (err, key) =>
      err ? reject(err) : resolve(new Uint8Array(key)),
    ),
  );
}

const PHC_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/** Returns a PHC-style string: $argon2id$v=19$m=…,t=…,p=…$salt$hash (base64url). */
export async function hashSecret(secret: string, p: Argon2Params): Promise<string> {
  const salt = new Uint8Array(nodeCrypto.randomBytes(16));
  const tag = await argon2id(utf8(secret), salt, p);
  return `$argon2id$v=19$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64urlEncode(salt)}$${b64urlEncode(tag)}`;
}

export async function verifySecret(secret: string, phc: string | null | undefined): Promise<boolean> {
  if (typeof secret !== 'string' || !phc) return false;
  const m = PHC_RE.exec(phc);
  if (!m) return false;
  const [, mem, t, par, saltB64, hashB64] = m;
  const expected = b64urlDecode(hashB64!);
  const actual = await argon2id(utf8(secret), b64urlDecode(saltB64!), { memory: Number(mem), passes: Number(t), parallelism: Number(par) }, expected.length);
  return timingSafeEqualBytes(actual, expected);
}

/** Lets the error path cost about as much as the success path (no user-enumeration timing). */
export async function burnArgon2(p: Argon2Params = ARGON2_TOKEN): Promise<void> {
  await argon2id(utf8('x'), new Uint8Array(16), p);
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return nodeCrypto.timingSafeEqual(a, b);
}

/** Constant-time string comparison via SHA-256 digests (length-independent). */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const da = nodeCrypto.createHash('sha256').update(a, 'utf8').digest();
  const db = nodeCrypto.createHash('sha256').update(b, 'utf8').digest();
  return nodeCrypto.timingSafeEqual(da, db) && a.length === b.length;
}

export function sha256Hex(text: string): string {
  return nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return b64urlEncode(new Uint8Array(nodeCrypto.randomBytes(bytes)));
}

// ---- AES-256-GCM for data that must be recoverable (TOTP secret) -----------

const TOTP_AAD = Buffer.from('vesper/totp/v1');

export function encryptAtRest(key: Uint8Array, plaintext: Uint8Array): string {
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(TOTP_AAD);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${b64urlEncode(new Uint8Array(iv))}.${b64urlEncode(new Uint8Array(Buffer.concat([ct, tag])))}`;
}

export function decryptAtRest(key: Uint8Array, blob: string): Uint8Array {
  const [v, ivB64, ctB64] = blob.split('.');
  if (v !== 'v1' || !ivB64 || !ctB64) throw new Error('bad encrypted blob');
  const iv = b64urlDecode(ivB64);
  const data = b64urlDecode(ctB64);
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(TOTP_AAD);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return new Uint8Array(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]));
}
