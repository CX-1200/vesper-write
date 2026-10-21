// §8.5 fingerprint: SHA-256(sign_spki || enc_spki), first 120 bits,
// rendered as six groups of five decimal digits. Both the device screen and
// the VM terminal call this same function, so the strings match exactly.
import { concatBytes, sha256, toHex } from "./encoding.js";
import { spkiFromJwk } from "./keys.js";
const DIGITS = 30n;
const MODULUS = 10n ** DIGITS;
export async function fingerprintBytes(signJwk, encJwk) {
    const digest = await sha256(concatBytes(spkiFromJwk(signJwk), spkiFromJwk(encJwk)));
    return digest.subarray(0, 15); // 120 bits
}
/** "12345 67890 12345 67890 12345 67890" */
export async function computeFingerprint(signJwk, encJwk) {
    return formatFingerprint(await fingerprintBytes(signJwk, encJwk));
}
/**
 * Interpret the 120 bits as a big-endian integer and keep its 30 lowest
 * decimal digits (about 99.7 bits). 2^120 / 10^30 ≈ 1.3e6, so the bias of the
 * modulo reduction is negligible.
 */
export function formatFingerprint(bits120) {
    if (bits120.length !== 15)
        throw new TypeError('expected 15 bytes');
    const n = BigInt('0x' + toHex(bits120)) % MODULUS;
    const digits = n.toString().padStart(Number(DIGITS), '0');
    return digits.match(/\d{5}/g).join(' ');
}
export const FINGERPRINT_RE = /^\d{5}( \d{5}){5}$/;
/** Accepts user input with any spacing ("12345-67890…", "1234567890…"). */
export function normalizeFingerprint(input) {
    const digits = input.replace(/[^0-9]/g, '');
    if (digits.length !== 30)
        return null;
    return digits.match(/\d{5}/g).join(' ');
}
export function lastGroup(fp) {
    return fp.slice(-5);
}
