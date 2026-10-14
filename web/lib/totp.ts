// RFC 6238 TOTP (HMAC-SHA-1, 6 digits, 30-second steps), compatible with
// common authenticator apps. Verification accepts ±1 step for clock drift and
// refuses any step not newer than the last accepted one (no code reuse).

import { createHmac, randomBytes } from 'node:crypto';
import { timingSafeEqualStrings } from './server-crypto.ts';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function generateTotpSecret(): Uint8Array {
  return new Uint8Array(randomBytes(20));
}

/** RFC 4226 HOTP. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpAt(secret: Uint8Array, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(nowMs), digits);
}

/** Returns the accepted step, or null. Caller must persist the step to block reuse. */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number, lastAcceptedStep: number): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  let accepted: number | null = null;
  // Check every candidate (no early exit) to keep timing uniform.
  for (const step of [current - 1, current, current + 1]) {
    const ok = timingSafeEqualStrings(hotp(secret, step), code);
    if (ok && step > lastAcceptedStep && accepted === null) accepted = step;
  }
  return accepted;
}

export function otpauthUri(secret: Uint8Array, account = 'owner', issuer = 'Vesper'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
