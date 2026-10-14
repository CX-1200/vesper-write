// §11 root of trust on the VM: trusted-devices.json. Only `vesper device
// approve` (a human at the VM terminal) adds entries. The worker never trusts
// device keys that arrive from Vercel (§8.4, §22).

import { parsePublicJwk, type EcPublicJwk } from '@vesper/core/keys';
import { computeFingerprint } from '@vesper/core/fingerprint';
import { UUID_RE } from '@vesper/core/encoding';
import { readJson, writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

export interface TrustedDevice {
  id: string;
  name: string;
  sign_public_key: EcPublicJwk;
  enc_public_key: EcPublicJwk;
  fingerprint: string;
  approved_at: number;
}

export interface RevokedDevice {
  id: string;
  name: string;
  fingerprint: string;
  revoked_at: number;
}

interface TrustFile {
  version: 1;
  devices: TrustedDevice[];
}

interface RevokedFile {
  version: 1;
  devices: RevokedDevice[];
}

/** Loads and re-validates the trust list (fingerprints are recomputed, not read). */
export async function loadTrusted(p: Paths): Promise<TrustedDevice[]> {
  const f = readJson<TrustFile>(p.trustedDevices);
  if (!f) return [];
  if (f.version !== 1 || !Array.isArray(f.devices)) throw new Error('trusted-devices.json is malformed');
  const out: TrustedDevice[] = [];
  for (const d of f.devices) {
    if (!UUID_RE.test(d.id)) throw new Error('trusted-devices.json has a bad device id');
    const sign = parsePublicJwk(d.sign_public_key);
    const enc = parsePublicJwk(d.enc_public_key);
    const fp = await computeFingerprint(sign, enc);
    if (fp !== d.fingerprint) throw new Error(`trusted-devices.json fingerprint mismatch for ${d.id}`);
    out.push({ id: d.id, name: String(d.name), sign_public_key: sign, enc_public_key: enc, fingerprint: fp, approved_at: Number(d.approved_at) });
  }
  return out;
}

export function saveTrusted(p: Paths, devices: TrustedDevice[]): void {
  writeJsonAtomic(p.trustedDevices, { version: 1, devices } satisfies TrustFile);
}

export function loadRevoked(p: Paths): RevokedDevice[] {
  const f = readJson<RevokedFile>(p.revokedDevices);
  return f?.devices ?? [];
}

export function saveRevoked(p: Paths, devices: RevokedDevice[]): void {
  writeJsonAtomic(p.revokedDevices, { version: 1, devices } satisfies RevokedFile);
}

export async function trustDevice(p: Paths, d: Omit<TrustedDevice, 'fingerprint'>): Promise<TrustedDevice> {
  const fingerprint = await computeFingerprint(d.sign_public_key, d.enc_public_key);
  const list = (await loadTrusted(p)).filter((x) => x.id !== d.id);
  const entry: TrustedDevice = { ...d, fingerprint };
  list.push(entry);
  saveTrusted(p, list);
  // Re-approving a device removes it from the revoked list.
  saveRevoked(
    p,
    loadRevoked(p).filter((x) => x.id !== d.id),
  );
  return entry;
}

export async function untrustDevice(p: Paths, id: string, now: number): Promise<TrustedDevice | null> {
  const list = await loadTrusted(p);
  const victim = list.find((x) => x.id === id) ?? null;
  saveTrusted(
    p,
    list.filter((x) => x.id !== id),
  );
  const revoked = loadRevoked(p).filter((x) => x.id !== id);
  revoked.push({ id, name: victim?.name ?? '(unknown)', fingerprint: victim?.fingerprint ?? '', revoked_at: now });
  saveRevoked(p, revoked);
  return victim;
}
