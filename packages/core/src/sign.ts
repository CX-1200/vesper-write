// §8.4 signatures. All signatures are ECDSA P-256 with SHA-256 in IEEE P1363
// form (64 bytes r||s), which is what WebCrypto produces in browsers and Node.
// Every signed string starts with a purpose prefix (domain separation), so a
// signature made for one purpose can never be replayed as another.

import { canonicalJson, joinFields } from './canonical.ts';
import { b64urlDecode, b64urlEncode, getSubtle, sha256Hex, utf8 } from './encoding.ts';

const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

export const SIG_PREFIX = {
  request: 'vesper/req/v1',
  output: 'vesper/outsig/v1',
  approve: 'vesper/approve/v1',
  revoke: 'vesper/revoke/v1',
} as const;

/** Signature timestamps must be within ±60 s of the verifier's clock. */
export const SIGNATURE_WINDOW_MS = 60_000;

export async function signString(privateKey: CryptoKey, text: string): Promise<string> {
  const sig = await getSubtle().sign(ECDSA_SHA256, privateKey, utf8(text) as BufferSource);
  return b64urlEncode(new Uint8Array(sig));
}

export async function verifyString(publicKey: CryptoKey, text: string, signature: string): Promise<boolean> {
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(signature);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  try {
    return await getSubtle().verify(ECDSA_SHA256, publicKey, sig as BufferSource, utf8(text) as BufferSource);
  } catch {
    return false;
  }
}

// ---- request signatures (device → Vercel/VM, VM → Vercel) -------------------

export interface RequestToSign {
  method: string;
  /** pathname plus query string, e.g. "/api/audit?view=full" */
  path: string;
  ts: number;
  nonce: string;
  /** raw request body ('' for GET) */
  body: string;
}

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function isValidNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && NONCE_RE.test(nonce);
}

export async function requestSigningString(req: RequestToSign): Promise<string> {
  const method = req.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new TypeError('invalid method');
  if (!req.path.startsWith('/')) throw new TypeError('path must start with /');
  if (!isValidNonce(req.nonce)) throw new TypeError('invalid nonce');
  return joinFields([SIG_PREFIX.request, method, req.path, req.ts, req.nonce, await sha256Hex(req.body)]);
}

export async function signRequest(privateKey: CryptoKey, req: RequestToSign): Promise<string> {
  return signString(privateKey, await requestSigningString(req));
}

export async function verifyRequestSignature(publicKey: CryptoKey, req: RequestToSign, signature: string): Promise<boolean> {
  let text: string;
  try {
    text = await requestSigningString(req);
  } catch {
    return false;
  }
  return verifyString(publicKey, text, signature);
}

export function isFresh(ts: number, now: number, windowMs = SIGNATURE_WINDOW_MS): boolean {
  return Number.isSafeInteger(ts) && Math.abs(now - ts) <= windowMs;
}

// ---- VM output signature ------------------------------------------------------

/**
 * Covers the ticket id and every recipient's envelope. canonicalJson sorts the
 * object keys, i.e. the envelopes are hashed in device_id order (§8.4).
 */
export async function outputSigningString(ticketId: string, outputEnvelopes: Record<string, unknown>): Promise<string> {
  return joinFields([SIG_PREFIX.output, ticketId, await sha256Hex(canonicalJson(outputEnvelopes))]);
}

export async function signOutput(vmKey: CryptoKey, ticketId: string, outputEnvelopes: Record<string, unknown>): Promise<string> {
  return signString(vmKey, await outputSigningString(ticketId, outputEnvelopes));
}

export async function verifyOutput(
  vmPublicKey: CryptoKey,
  ticketId: string,
  outputEnvelopes: Record<string, unknown>,
  signature: string,
): Promise<boolean> {
  let text: string;
  try {
    text = await outputSigningString(ticketId, outputEnvelopes);
  } catch {
    return false;
  }
  return verifyString(vmPublicKey, text, signature);
}

// ---- VM device approval / revocation ------------------------------------------

export interface ApprovalRecord {
  deviceId: string;
  fingerprint: string;
  approvedAt: number;
}

export function approvalSigningString(r: ApprovalRecord): string {
  return joinFields([SIG_PREFIX.approve, r.deviceId, r.fingerprint, r.approvedAt]);
}

export interface RevocationRecord {
  deviceId: string;
  revokedAt: number;
}

export function revocationSigningString(r: RevocationRecord): string {
  return joinFields([SIG_PREFIX.revoke, r.deviceId, r.revokedAt]);
}
