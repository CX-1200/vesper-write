// Devices (§11.2, §11.3) and the VM status endpoint (§7 GET /api/vm).

import { isLocked } from '@vesper/core/system-state';
import { assertValidPublicJwk } from '@vesper/core/keys';
import { computeFingerprint } from '@vesper/core/fingerprint';
import { asObject, deviceName, uuid } from '@vesper/core/schemas';
import { CONFIG } from '@vesper/core/config';
import { first } from '../db/types.ts';
import { fail, json, parseJson } from '../http.ts';
import { authDevice, checkSignature, getVm, preflight, readBodyOr413, readSigHeaders } from '../guard.ts';
import { recordAuthFailure } from '../rate-limit.ts';
import { raiseAlert } from '../alerts.ts';
import { auditStatement } from '../audit.ts';
import { currentSystemState } from '../system.ts';
import { createSession } from '../sessions.ts';
import { getDevice, listDevices } from '../devices.ts';
import { isSetupComplete, normalizeUserSecret, verifyStoredSecret } from '../owner.ts';
import { failTicketsOfDevice } from '../tickets.ts';
import { insert } from '../sql.ts';
import type { AppContext } from '../context.ts';

// POST /api/devices/enroll/start — exception: needs the recovery key instead of a session.
// The new device stays unable to open tickets or receive ciphertext until the VM approves it.
export async function handleEnrollStart(req: Request, ctx: AppContext): Promise<Response> {
  const m = await preflight(req, ctx, 'authPerIp');
  if (m instanceof Response) return m;
  const raw = await readBodyOr413(req);
  if (raw instanceof Response) return raw;
  const state = await currentSystemState(ctx);
  if (isLocked(state.state)) return fail('locked', { state: state.state });
  if (!(await isSetupComplete(ctx))) return fail('setup_not_ready');

  let body: Record<string, unknown>;
  let device: { id: string; name: string; sign: unknown; enc: unknown };
  try {
    body = asObject(parseJson(raw));
    const d = asObject(body.device, 'device');
    device = { id: uuid(d.id, 'device.id'), name: deviceName(d.name), sign: d.sign_public_key, enc: d.enc_public_key };
  } catch {
    return fail('bad_request');
  }

  // R2: anyone calling enroll/start triggers an alert to every registered device.
  await raiseAlert(ctx, { rule: 'R2', severity: 'high', deviceId: null, ip: m.ip, country: m.country, reason: 'enroll_start' });

  const recovery = normalizeUserSecret(body.recovery_key);
  if (!recovery || !(await verifyStoredSecret(ctx, 'recovery', recovery))) {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.recovery_key', actor: `device:${device.id}` });
    return fail('unauthorized');
  }
  let signJwk, encJwk;
  try {
    signJwk = await assertValidPublicJwk(device.sign);
    encJwk = await assertValidPublicJwk(device.enc);
  } catch {
    return fail('bad_request');
  }
  const h = readSigHeaders(req);
  if (!h || h.deviceId !== device.id || (await checkSignature(ctx, m, signJwk, h, raw, `dev:${device.id}`)) !== 'ok') {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.signature', actor: `device:${device.id}`, detail: { step: 'enroll' } });
    return fail('unauthorized');
  }
  if (await getDevice(ctx, device.id)) return fail('conflict');
  const vm = await getVm(ctx);
  if (!vm) return fail('setup_not_ready');

  const fingerprint = await computeFingerprint(signJwk, encJwk);
  await ctx.db.batch([
    insert('devices', {
      id: device.id,
      name: device.name,
      sign_public_key: JSON.stringify(signJwk),
      enc_public_key: JSON.stringify(encJwk),
      fingerprint,
      enrolled_at: m.now,
      enrolled_via: 'recovery',
      last_seen_at: m.now,
      last_ip: m.ip,
      last_country: m.country,
    }),
    // The recovery key is single-use (§5.1); the PWA asks for a new one.
    { sql: "UPDATE secrets_meta SET used_at = CAST(? AS INTEGER) WHERE kind = 'recovery'", params: [m.now] },
    auditStatement(ctx, { event: 'device.enroll', actor: `device:${device.id}`, result: 'ok', ip: m.ip, country: m.country, detail: { via: 'recovery' } }),
  ]);
  const cookie = await createSession(ctx, device.id);
  return json(
    {
      device: { id: device.id, fingerprint },
      vm: { sign_public_key: JSON.parse(vm.sign_public_key), enc_public_key: JSON.parse(vm.enc_public_key), fingerprint: vm.fingerprint },
    },
    200,
    { 'Set-Cookie': cookie },
  );
}

// GET /api/devices/me — the calling device's own record, including the VM's
// signed approval (the device verifies it with its pinned VM key).
export async function handleDeviceMe(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx, { approved: false });
  if (a instanceof Response) return a;
  const setup = await first<{ c: unknown; t: unknown }>(ctx.db, 'SELECT setup_completed_at AS c, totp_confirmed AS t FROM owner WHERE id = 1');
  const recovery = await first<{ used_at: unknown }>(ctx.db, "SELECT used_at FROM secrets_meta WHERE kind = 'recovery'");
  return json({
    id: a.device.id,
    name: a.device.name,
    fingerprint: a.device.fingerprint,
    vm_approved_at: a.device.vm_approved_at,
    vm_approval_sig: a.device.vm_approval_sig,
    setup_complete: !!setup?.c,
    totp_confirmed: !!setup && Number(setup.t) === 1,
    recovery_key_used: !!recovery && recovery.used_at !== null,
    system_state: a.state.state,
  });
}

// GET /api/devices
export async function handleDeviceList(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  const devices = await listDevices(ctx);
  return json({
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      fingerprint: d.fingerprint,
      enrolled_at: d.enrolled_at,
      enrolled_via: d.enrolled_via,
      vm_approved_at: d.vm_approved_at,
      revoked_at: d.revoked_at,
      last_seen_at: d.last_seen_at,
      has_passkey: !!d.webauthn_credential_id,
      is_me: d.id === a.device.id,
    })),
  });
}

// POST /api/devices/:id/revoke — Vercel side (the VM side is `vesper device revoke`).
export async function handleDeviceRevoke(req: Request, ctx: AppContext, params: { id: string }): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  let id: string;
  try {
    id = uuid(params.id, 'id');
  } catch {
    return fail('bad_request');
  }
  const d = await getDevice(ctx, id);
  if (!d) return fail('not_found');
  if (d.revoked_at !== null) return json({ ok: true, already: true });
  await ctx.db.batch([
    { sql: 'UPDATE devices SET revoked_at = CAST(? AS INTEGER) WHERE id = ? AND revoked_at IS NULL', params: [a.now, id] },
    { sql: 'DELETE FROM sessions WHERE device_id = ?', params: [id] },
    { sql: 'DELETE FROM push_subscriptions WHERE device_id = ?', params: [id] },
    failTicketsOfDevice(id, a.now),
    auditStatement(ctx, { event: 'device.revoke', actor: `device:${a.device.id}`, result: 'ok', ip: a.ip, detail: { device: id, side: 'vercel' } }),
  ]);
  return json({ ok: true });
}

// POST /api/devices/:id/rename — change a device's display name. The name is
// only a label: it is not part of the VM's approval signature, and the VM keeps
// its own copy from approval time (`vesper device list`), so nothing trusts it.
export async function handleDeviceRename(req: Request, ctx: AppContext, params: { id: string }): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  let id: string;
  let name: string;
  try {
    id = uuid(params.id, 'id');
    name = deviceName(asObject(parseJson(a.body)).name);
  } catch {
    return fail('bad_request');
  }
  const d = await getDevice(ctx, id);
  if (!d) return fail('not_found');
  if (d.revoked_at !== null) return fail('conflict');
  await ctx.db.batch([
    { sql: 'UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL', params: [name, id] },
    // The name itself stays out of the audit log: it is user-typed text.
    auditStatement(ctx, { event: 'device.rename', actor: `device:${a.device.id}`, result: 'ok', ip: a.ip, detail: { device: id } }),
  ]);
  return json({ ok: true, name });
}

// POST /api/devices/:id/remove — drop a revoked device from the list once
// CONFIG.revokedDeviceRetentionMs has passed. Its sessions and push
// subscriptions go with it; its tickets and audit entries stay.
export async function handleDeviceRemove(req: Request, ctx: AppContext, params: { id: string }): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  let id: string;
  try {
    id = uuid(params.id, 'id');
  } catch {
    return fail('bad_request');
  }
  const d = await getDevice(ctx, id);
  if (!d) return fail('not_found');
  if (d.revoked_at === null || a.now - d.revoked_at < CONFIG.revokedDeviceRetentionMs) return fail('conflict');
  await ctx.db.batch([
    // explicit, so it does not depend on the database enforcing ON DELETE CASCADE
    { sql: 'DELETE FROM sessions WHERE device_id = ?', params: [id] },
    { sql: 'DELETE FROM push_subscriptions WHERE device_id = ?', params: [id] },
    { sql: 'DELETE FROM devices WHERE id = ? AND revoked_at IS NOT NULL', params: [id] },
    auditStatement(ctx, { event: 'device.remove', actor: `device:${a.device.id}`, result: 'ok', ip: a.ip, detail: { device: id } }),
  ]);
  return json({ ok: true });
}

// GET /api/vm — VM public keys, fingerprint and online status. Devices use the
// keys only during pairing; afterwards they compare with their pinned copy.
export async function handleVm(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx, { approved: false });
  if (a instanceof Response) return a;
  const vm = await getVm(ctx);
  if (!vm) return json({ registered: false });
  return json({
    registered: true,
    sign_public_key: JSON.parse(vm.sign_public_key),
    enc_public_key: JSON.parse(vm.enc_public_key),
    fingerprint: vm.fingerprint,
    last_seen_at: vm.last_seen_at,
    online: vm.last_seen_at !== null && a.now - vm.last_seen_at <= CONFIG.vmOnlineThresholdMs,
    latched: vm.latched === 1,
    system_state: a.state.state,
  });
}
