// Recovery key, break-glass key and kill token: 160 random bits generated on
// this device, shown once in groups (ABCD-EFGH-…). Only their argon2id hashes
// are stored on the server.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
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

export function generateUserSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32(bytes).match(/.{4}/g)!.join('-');
}

export function urlBase64ToUint8Array(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Format what the user types into a secret field: upper case, only letters and
 * digits, at most 32 of them, and a '-' after every 4 (ABCD-EFGH-…), matching
 * how the secret was shown. Invalid characters (0, 1, 8, 9) are kept so the
 * server can reject a typo instead of the field silently swallowing it.
 */
export function formatSecretInput(typed: string): string {
  const chars = typed.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
  return chars.match(/.{1,4}/g)?.join('-') ?? '';
}

/** Length of the formatted secret: 32 characters plus 7 dashes. */
export const SECRET_INPUT_MAX = 39;
