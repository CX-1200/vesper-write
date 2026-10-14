// Full first-time setup (§11.1) driven exactly as a user would, used by most
// integration tests as their starting point.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lastGroup } from '@vesper/core/fingerprint';
import { base32Encode } from '../../web/lib/totp.ts';
import { SETUP_TOKEN, type Harness } from './harness.ts';
import { SimDevice } from './sim-device.ts';
import { SimVm } from './sim-vm.ts';

export const PASSWORD = 'correct horse battery staple';

/** A user secret as the PWA generates it: 160 random bits, base32, grouped. */
export function genUserSecret(): string {
  return base32Encode(new Uint8Array(randomBytes(20))).match(/.{4}/g)!.join('-');
}

export function setupHeaders(step: string) {
  return { extraHeaders: { 'x-vesper-setup-step': step } };
}

export interface Setup {
  vm: SimVm;
  phone: SimDevice;
  totpSecret: string;
  secrets: { recovery_key: string; break_glass_key: string; kill_token: string };
}

/** Advance past the current TOTP step so a fresh code is accepted (codes are single-use). */
export function nextTotpStep(h: Harness): void {
  h.clock.advance(30_000);
}

export async function beginSetup(h: Harness, phone: SimDevice) {
  const r = await phone.req('POST', '/api/setup', { step: 'begin', setup_token: SETUP_TOKEN, device: phone.publicKeys, password: PASSWORD }, setupHeaders('begin'));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r;
}

export async function fullSetup(h: Harness): Promise<Setup> {
  const vm = await SimVm.create(h);
  const phone = await SimDevice.create(h, 'iPhone');

  // 3. device: setup token + password → TOTP secret, device fingerprint, VM fingerprint
  const begin = await beginSetup(h, phone);
  assert.equal(begin.json.device.fingerprint, phone.fingerprint);
  // 4. the user compares the VM fingerprint on the device with the VM terminal
  assert.equal(begin.json.vm.fingerprint, vm.keys.fingerprint);
  phone.pinVm(begin.json.vm);
  const totpSecret: string = begin.json.totp.secret;

  nextTotpStep(h);
  const c = await phone.req('POST', '/api/setup', { step: 'confirm_totp', setup_token: SETUP_TOKEN, code: phone.totp(totpSecret) }, setupHeaders('confirm_totp'));
  assert.equal(c.status, 200, JSON.stringify(c.json));

  // 4–5. VM: worker caches the pending device; human approves after comparing fingerprints
  await vm.poll();
  assert.equal(await vm.approve(phone.id, lastGroup(phone.fingerprint)), true);
  await vm.poll(); // delivers the signed approval

  // 6. device sees and verifies the VM-signed approval with its pinned VM key
  const me = await phone.req('GET', '/api/devices/me');
  assert.equal(me.status, 200);
  assert.ok(me.json.vm_approved_at);
  assert.equal(await phone.verifyApproval(me.json), true);

  // 7. secrets (generated on the device; only hashes reach the server)
  const secrets = { recovery_key: genUserSecret(), break_glass_key: genUserSecret(), kill_token: genUserSecret() };
  const s = await phone.req('POST', '/api/setup', { step: 'set_secrets', setup_token: SETUP_TOKEN, ...secrets }, setupHeaders('set_secrets'));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  await h.flush();
  return { vm, phone, totpSecret, secrets };
}

export async function login(h: Harness, d: SimDevice, totpSecret: string, password = PASSWORD) {
  nextTotpStep(h);
  return d.req('POST', '/api/auth/login', { device_id: d.id, password, totp: d.totp(totpSecret) });
}

export { SimDevice, SimVm };
