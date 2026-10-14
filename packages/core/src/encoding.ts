// Byte/text encoding helpers shared by the browser, Vercel and the VM.
// Everything here runs on WebCrypto + standard globals so the exact same
// code produces the exact same bytes on every platform.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64url decoder: rejects padding, whitespace and the standard alphabet. */
export function b64urlDecode(text: string): Uint8Array {
  if (typeof text !== 'string' || !B64URL_RE.test(text) || text.length % 4 === 1) {
    throw new TypeError('invalid base64url');
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  // Reject non-canonical encodings (e.g. trailing bits set) so one value has one encoding.
  if (b64urlEncode(out) !== text) throw new TypeError('non-canonical base64url');
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(text: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(text)) throw new TypeError('invalid hex');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Length-independent comparison loop (no early exit on the first differing byte). */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function getSubtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available in this runtime');
  return c.subtle;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await getSubtle().digest('SHA-256', bytes as BufferSource));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return toHex(await sha256(typeof data === 'string' ? utf8(data) : data));
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** 128-bit random value, base64url. Used for request nonces. */
export function randomNonce(): string {
  return b64urlEncode(randomBytes(16));
}

export function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
