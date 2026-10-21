// §8.4 signatures. All signatures are ECDSA P-256 with SHA-256 in IEEE P1363
// form (64 bytes r||s), which is what WebCrypto produces in browsers and Node.
// Every signed string starts with a purpose prefix (domain separation), so a
// signature made for one purpose can never be replayed as another.
import { canonicalJson, joinFields } from "./canonical.js";
import { b64urlDecode, b64urlEncode, getSubtle, sha256Hex, utf8 } from "./encoding.js";
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' };
export const SIG_PREFIX = {
    request: 'vesper/req/v1',
    output: 'vesper/outsig/v1',
    approve: 'vesper/approve/v1',
    revoke: 'vesper/revoke/v1',
};
/** Signature timestamps must be within ±60 s of the verifier's clock. */
export const SIGNATURE_WINDOW_MS = 60_000;
export async function signString(privateKey, text) {
    const sig = await getSubtle().sign(ECDSA_SHA256, privateKey, utf8(text));
    return b64urlEncode(new Uint8Array(sig));
}
export async function verifyString(publicKey, text, signature) {
    let sig;
    try {
        sig = b64urlDecode(signature);
    }
    catch {
        return false;
    }
    if (sig.length !== 64)
        return false;
    try {
        return await getSubtle().verify(ECDSA_SHA256, publicKey, sig, utf8(text));
    }
    catch {
        return false;
    }
}
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export function isValidNonce(nonce) {
    return typeof nonce === 'string' && NONCE_RE.test(nonce);
}
export async function requestSigningString(req) {
    const method = req.method.toUpperCase();
    if (!/^[A-Z]+$/.test(method))
        throw new TypeError('invalid method');
    if (!req.path.startsWith('/'))
        throw new TypeError('path must start with /');
    if (!isValidNonce(req.nonce))
        throw new TypeError('invalid nonce');
    return joinFields([SIG_PREFIX.request, method, req.path, req.ts, req.nonce, await sha256Hex(req.body)]);
}
export async function signRequest(privateKey, req) {
    return signString(privateKey, await requestSigningString(req));
}
export async function verifyRequestSignature(publicKey, req, signature) {
    let text;
    try {
        text = await requestSigningString(req);
    }
    catch {
        return false;
    }
    return verifyString(publicKey, text, signature);
}
export function isFresh(ts, now, windowMs = SIGNATURE_WINDOW_MS) {
    return Number.isSafeInteger(ts) && Math.abs(now - ts) <= windowMs;
}
// ---- VM output signature ------------------------------------------------------
/**
 * Covers the ticket id and every recipient's envelope. canonicalJson sorts the
 * object keys, i.e. the envelopes are hashed in device_id order (§8.4).
 */
export async function outputSigningString(ticketId, outputEnvelopes) {
    return joinFields([SIG_PREFIX.output, ticketId, await sha256Hex(canonicalJson(outputEnvelopes))]);
}
export async function signOutput(vmKey, ticketId, outputEnvelopes) {
    return signString(vmKey, await outputSigningString(ticketId, outputEnvelopes));
}
export async function verifyOutput(vmPublicKey, ticketId, outputEnvelopes, signature) {
    let text;
    try {
        text = await outputSigningString(ticketId, outputEnvelopes);
    }
    catch {
        return false;
    }
    return verifyString(vmPublicKey, text, signature);
}
export function approvalSigningString(r) {
    return joinFields([SIG_PREFIX.approve, r.deviceId, r.fingerprint, r.approvedAt]);
}
export function revocationSigningString(r) {
    return joinFields([SIG_PREFIX.revoke, r.deviceId, r.revokedAt]);
}
