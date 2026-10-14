// This device's identity (§8.1, §11): an ECDSA P-256 signing key and a P-256
// HPKE key, both generated here as NON-EXTRACTABLE CryptoKeys and kept in
// IndexedDB. Also the VM public keys pinned during pairing — after pairing the
// device never takes the VM key from Vercel again (§8.4).

import { exportPublicJwk, generateSigningKeyPair, samePublicJwk, type EcPublicJwk } from '@vesper/core/keys';
import { generateHpkeKeyPair, hpkePublicKeyFromJwk, hpkePublicKeyToJwk, open, seal, type HpkeKeyPair } from '@vesper/core/envelope';
import { computeFingerprint } from '@vesper/core/fingerprint';
import { signString, verifyString } from '@vesper/core/sign';
import { randomUuid, utf8 } from '@vesper/core/encoding';
import { idbClear, idbGet, idbPutMany } from './idb.ts';

export interface Identity {
  id: string;
  name: string;
  sign: { privateKey: CryptoKey; publicKey: CryptoKey };
  enc: HpkeKeyPair;
  signJwk: EcPublicJwk;
  encJwk: EcPublicJwk;
  fingerprint: string;
}

export interface PinnedVm {
  signJwk: EcPublicJwk;
  encJwk: EcPublicJwk;
  fingerprint: string;
  pinnedAt: number;
}

export const STORAGE_ERROR =
  '这个浏览器无法可靠地保存密钥，所以没有继续。iPhone 请从主屏幕的 Vesper 图示打开再试；也请确认没有使用无痕浏览。';

export async function createIdentity(name: string): Promise<Identity> {
  const sign = await generateSigningKeyPair(false);
  const enc = await generateHpkeKeyPair(false);
  const signJwk = await exportPublicJwk(sign.publicKey);
  const encJwk = await hpkePublicKeyToJwk(enc.publicKey);
  return { id: randomUuid(), name, sign, enc, signJwk, encJwk, fingerprint: await computeFingerprint(signJwk, encJwk) };
}

/**
 * Store each CryptoKey separately (CryptoKeyPair objects cannot be cloned
 * into IndexedDB), then re-open the database and prove the stored keys work.
 * Throws if this browser cannot keep keys (docs/verification.md item 8).
 */
export async function persistIdentity(i: Identity): Promise<void> {
  await idbPutMany({
    'device:id': i.id,
    'device:name': i.name,
    'device:sign:private': i.sign.privateKey,
    'device:sign:public': i.sign.publicKey,
    'device:enc:private': i.enc.privateKey,
    'device:enc:public': i.enc.publicKey,
    'device:sign:jwk': i.signJwk,
    'device:enc:jwk': i.encJwk,
    'device:fingerprint': i.fingerprint,
  });
  await selfTest(i);
}

export async function selfTest(expected: Identity): Promise<void> {
  const loaded = await loadIdentity();
  if (!loaded || loaded.id !== expected.id) throw new Error('keys were not saved');
  if (loaded.sign.privateKey.extractable || loaded.enc.privateKey.extractable) throw new Error('private keys became extractable');
  const probe = 'vesper/selftest';
  const sig = await signString(loaded.sign.privateKey, probe);
  if (!(await verifyString(expected.sign.publicKey, probe, sig))) throw new Error('stored signing key does not work');
  const env = await seal(await hpkePublicKeyFromJwk(expected.encJwk), utf8(probe), { info: utf8('selftest'), aad: utf8('selftest') });
  const back = await open(loaded.enc, env, { info: utf8('selftest'), aad: utf8('selftest') });
  if (new TextDecoder().decode(back) !== probe) throw new Error('stored encryption key does not work');
}

export async function loadIdentity(): Promise<Identity | null> {
  const id = await idbGet<string>('device:id');
  if (!id) return null;
  const [name, sPriv, sPub, ePriv, ePub, signJwk, encJwk, fingerprint] = await Promise.all([
    idbGet<string>('device:name'),
    idbGet<CryptoKey>('device:sign:private'),
    idbGet<CryptoKey>('device:sign:public'),
    idbGet<CryptoKey>('device:enc:private'),
    idbGet<CryptoKey>('device:enc:public'),
    idbGet<EcPublicJwk>('device:sign:jwk'),
    idbGet<EcPublicJwk>('device:enc:jwk'),
    idbGet<string>('device:fingerprint'),
  ]);
  if (!sPriv || !sPub || !ePriv || !ePub || !signJwk || !encJwk || !fingerprint) return null;
  return { id, name: name ?? '', sign: { privateKey: sPriv, publicKey: sPub }, enc: { privateKey: ePriv, publicKey: ePub }, signJwk, encJwk, fingerprint };
}

export async function pinVm(vm: { sign_public_key: EcPublicJwk; enc_public_key: EcPublicJwk; fingerprint: string }): Promise<PinnedVm> {
  // Recompute: never store a fingerprint we did not derive ourselves.
  const fingerprint = await computeFingerprint(vm.sign_public_key, vm.enc_public_key);
  if (fingerprint !== vm.fingerprint) throw new Error('VM fingerprint does not match its keys');
  const pinned: PinnedVm = { signJwk: vm.sign_public_key, encJwk: vm.enc_public_key, fingerprint, pinnedAt: Date.now() };
  await idbPutMany({ 'vm:pinned': pinned });
  return pinned;
}

export function getPinnedVm(): Promise<PinnedVm | undefined> {
  return idbGet<PinnedVm>('vm:pinned');
}

/** True if Vercel now reports VM keys that differ from the ones pinned at pairing. */
export function vmKeysChanged(pinned: PinnedVm, reported: { sign_public_key: EcPublicJwk; enc_public_key: EcPublicJwk }): boolean {
  return !samePublicJwk(pinned.signJwk, reported.sign_public_key) || !samePublicJwk(pinned.encJwk, reported.enc_public_key);
}

export async function forgetDevice(): Promise<void> {
  await idbClear();
}

/** Ask the browser not to evict our storage (iOS 15.2+, docs/verification.md item 8). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
