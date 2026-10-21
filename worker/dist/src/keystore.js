// VM identity keys (§8.1): an ECDSA P-256 signing key and a P-256 HPKE key,
// stored as JWK files with mode 0600 under keys/. At runtime they are
// imported as non-extractable CryptoKeys.
import { existsSync } from 'node:fs';
import { exportPrivateJwk, generateSigningKeyPair, importSigningKey, importEncPrivateKey, importVerifyKey, parsePrivateJwk } from '@vesper/core/keys';
import { signString, verifyString } from '@vesper/core/sign';
import { generateHpkeKeyPair, hpkePublicKeyFromJwk } from '@vesper/core/envelope';
import { computeFingerprint } from '@vesper/core/fingerprint';
import { readJson, writeJsonAtomic, ensureDir } from "./fsutil.js";
function publicPart(jwk) {
    return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}
export function keysExist(p) {
    return existsSync(p.signKey) || existsSync(p.encKey);
}
/** Generate and store a fresh VM identity. Refuses to overwrite existing keys. */
export async function generateVmKeys(p) {
    if (keysExist(p))
        throw new Error('VM keys already exist; refusing to overwrite them');
    ensureDir(p.keysDir);
    const sign = await generateSigningKeyPair(true);
    const enc = await generateHpkeKeyPair(true);
    writeJsonAtomic(p.signKey, await exportPrivateJwk(sign.privateKey));
    writeJsonAtomic(p.encKey, await exportPrivateJwk(enc.privateKey));
    return loadVmKeys(p);
}
export async function loadVmKeys(p) {
    const signJwk = readJson(p.signKey);
    const encJwk = readJson(p.encKey);
    if (!signJwk || !encJwk)
        throw new Error('VM keys not found — run `vesper init` first');
    const s = parsePrivateJwk(signJwk);
    const e = parsePrivateJwk(encJwk);
    const signPublicJwk = publicPart(s);
    const encPublicJwk = publicPart(e);
    const enc = { privateKey: await importEncPrivateKey(e), publicKey: await hpkePublicKeyFromJwk(encPublicJwk) };
    const signPrivate = await importSigningKey(s);
    // Sanity: the private key really belongs to the stored public key.
    const probe = await signString(signPrivate, 'vesper/keycheck');
    if (!(await verifyString(await importVerifyKey(signPublicJwk), 'vesper/keycheck', probe)))
        throw new Error('VM signing key is corrupt');
    return {
        signPrivate,
        signPublicJwk,
        enc,
        encPublicJwk,
        fingerprint: await computeFingerprint(signPublicJwk, encPublicJwk),
    };
}
