// §11 root of trust on the VM: trusted-devices.json. Only `vesper device
// approve` (a human at the VM terminal) adds entries. The worker never trusts
// device keys that arrive from Vercel (§8.4, §22).
import { parsePublicJwk } from '@vesper/core/keys';
import { computeFingerprint } from '@vesper/core/fingerprint';
import { UUID_RE } from '@vesper/core/encoding';
import { readJson, writeJsonAtomic } from "./fsutil.js";
/** Loads and re-validates the trust list (fingerprints are recomputed, not read). */
export async function loadTrusted(p) {
    const f = readJson(p.trustedDevices);
    if (!f)
        return [];
    if (f.version !== 1 || !Array.isArray(f.devices))
        throw new Error('trusted-devices.json is malformed');
    const out = [];
    for (const d of f.devices) {
        if (!UUID_RE.test(d.id))
            throw new Error('trusted-devices.json has a bad device id');
        const sign = parsePublicJwk(d.sign_public_key);
        const enc = parsePublicJwk(d.enc_public_key);
        const fp = await computeFingerprint(sign, enc);
        if (fp !== d.fingerprint)
            throw new Error(`trusted-devices.json fingerprint mismatch for ${d.id}`);
        out.push({ id: d.id, name: String(d.name), sign_public_key: sign, enc_public_key: enc, fingerprint: fp, approved_at: Number(d.approved_at) });
    }
    return out;
}
export function saveTrusted(p, devices) {
    writeJsonAtomic(p.trustedDevices, { version: 1, devices });
}
export function loadRevoked(p) {
    const f = readJson(p.revokedDevices);
    return f?.devices ?? [];
}
export function saveRevoked(p, devices) {
    writeJsonAtomic(p.revokedDevices, { version: 1, devices });
}
export async function trustDevice(p, d) {
    const fingerprint = await computeFingerprint(d.sign_public_key, d.enc_public_key);
    const list = (await loadTrusted(p)).filter((x) => x.id !== d.id);
    const entry = { ...d, fingerprint };
    list.push(entry);
    saveTrusted(p, list);
    // Re-approving a device removes it from the revoked list.
    saveRevoked(p, loadRevoked(p).filter((x) => x.id !== d.id));
    return entry;
}
export async function untrustDevice(p, id, now) {
    const list = await loadTrusted(p);
    const victim = list.find((x) => x.id === id) ?? null;
    saveTrusted(p, list.filter((x) => x.id !== id));
    const revoked = loadRevoked(p).filter((x) => x.id !== id);
    revoked.push({ id, name: victim?.name ?? '(unknown)', fingerprint: victim?.fingerprint ?? '', revoked_at: now });
    saveRevoked(p, revoked);
    return victim;
}
