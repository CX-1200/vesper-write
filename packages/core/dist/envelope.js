// §8.2/§8.3 envelopes: HPKE (RFC 9180) base mode with
// DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM, via the zero-dependency
// `hpke` package. HPKE derives the AEAD nonce from its key schedule, so the
// envelope carries no separate IV.
import * as HPKE from 'hpke';
import { joinFields } from "./canonical.js";
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from "./encoding.js";
import { jwkFromRawPoint, rawPointFromJwk } from "./keys.js";
export const ENVELOPE_ALG = 'HPKE-Base-P256-SHA256-A256GCM';
export const ENVELOPE_VERSION = 1;
/** Upper bound for a single envelope's ciphertext (raw input or prompt). */
export const MAX_ENVELOPE_CT_BYTES = 256 * 1024;
const suite = new HPKE.CipherSuite(HPKE.KEM_DHKEM_P256_HKDF_SHA256, HPKE.KDF_HKDF_SHA256, HPKE.AEAD_AES_256_GCM);
export class EnvelopeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'EnvelopeError';
    }
}
export const HPKE_INFO = {
    in: utf8('vesper/in/v1'),
    out: utf8('vesper/out/v1'),
};
/** Device → VM AAD: "vesper/in/v1" | ticket_id | type | target | device_id | ts */
export function inputAad(a) {
    return utf8(joinFields(['vesper/in/v1', a.ticketId, a.type, a.target, a.deviceId, a.ts]));
}
/** VM → device AAD: "vesper/out/v1" | ticket_id | type | target | recipient_device_id | processed_at */
export function outputAad(a) {
    return utf8(joinFields(['vesper/out/v1', a.ticketId, a.type, a.target, a.recipientDeviceId, a.processedAt]));
}
export async function generateHpkeKeyPair(extractable = false) {
    const kp = await suite.GenerateKeyPair(extractable);
    return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}
export async function hpkePublicKeyFromJwk(jwk) {
    return (await suite.DeserializePublicKey(rawPointFromJwk(jwk)));
}
export async function hpkePublicKeyToJwk(key) {
    return jwkFromRawPoint(await suite.SerializePublicKey(key));
}
export async function seal(recipientPublicKey, plaintext, opts) {
    const { encapsulatedSecret, ciphertext } = await suite.Seal(recipientPublicKey, plaintext, opts);
    return { v: 1, alg: ENVELOPE_ALG, enc: b64urlEncode(encapsulatedSecret), ct: b64urlEncode(ciphertext) };
}
/** Throws EnvelopeError if the envelope is malformed or authentication fails (wrong key, AAD or info). */
export async function open(recipient, envelope, opts) {
    const env = parseEnvelope(envelope);
    try {
        return await suite.Open(recipient, b64urlDecode(env.enc), b64urlDecode(env.ct), opts);
    }
    catch {
        throw new EnvelopeError('decryption failed');
    }
}
export async function sealJson(recipientPublicKey, value, opts) {
    return seal(recipientPublicKey, utf8(JSON.stringify(value)), opts);
}
export async function openJson(recipient, envelope, opts) {
    const bytes = await open(recipient, envelope, opts);
    try {
        return JSON.parse(fromUtf8(bytes));
    }
    catch {
        throw new EnvelopeError('plaintext is not JSON');
    }
}
/** Validates the envelope shape strictly and returns a clean copy (no extra fields). */
export function parseEnvelope(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new EnvelopeError('envelope must be an object');
    const e = input;
    const keys = Object.keys(e).sort().join(',');
    if (keys !== 'alg,ct,enc,v')
        throw new EnvelopeError('unexpected envelope fields');
    if (e.v !== ENVELOPE_VERSION)
        throw new EnvelopeError('unsupported envelope version');
    if (e.alg !== ENVELOPE_ALG)
        throw new EnvelopeError('unsupported envelope alg');
    let enc;
    let ct;
    try {
        enc = b64urlDecode(e.enc);
        ct = b64urlDecode(e.ct);
    }
    catch {
        throw new EnvelopeError('envelope fields must be base64url');
    }
    if (enc.length !== 65 || enc[0] !== 0x04)
        throw new EnvelopeError('bad encapsulated key');
    if (ct.length < 16 || ct.length > MAX_ENVELOPE_CT_BYTES + 16)
        throw new EnvelopeError('bad ciphertext length');
    return { v: 1, alg: ENVELOPE_ALG, enc: e.enc, ct: e.ct };
}
/** Exposed for the RFC 9180 test-vector tests only. */
export const __suiteForTests = suite;
