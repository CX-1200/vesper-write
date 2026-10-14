// POST /api/setup — first-time setup (§11.1). Exception to the normal auth
// rules: it is protected by the one-time SETUP_TOKEN instead of a session.
//
// step "begin"        setup token + new device public keys + password
//                     (+ proof of possession: the request is signed with the
//                     new device key). Creates the owner, the device (pending
//                     VM approval), a TOTP secret and a session.
// step "confirm_totp" proves the authenticator app was set up correctly.
// step "set_secrets"  after the VM approved this device: stores the hashes of
//                     the recovery key, break-glass key and kill token, and
//                     invalidates the setup token for good.

import { assertValidPublicJwk } from '@vesper/core/keys';
import { computeFingerprint } from '@vesper/core/fingerprint';
import { asObject, deviceName, uuid } from '@vesper/core/schemas';
import { first } from '../db/types.ts';
import { fail, json, parseJson } from '../http.ts';
import { authDevice, checkSignature, preflight, readBodyOr413, readSigHeaders, getVm } from '../guard.ts';
import { recordAuthFailure } from '../rate-limit.ts';
import { auditStatement } from '../audit.ts';
import { createSession } from '../sessions.ts';
import { encryptAtRest, hashSecret, ARGON2_PASSWORD, ARGON2_TOKEN } from '../server-crypto.ts';
import { base32Encode, generateTotpSecret, otpauthUri } from '../totp.ts';
import { checkTotp, getOwner, normalizeUserSecret, passwordAcceptable, setupTokenValid, upsertSecretStatement } from '../owner.ts';
import { insert } from '../sql.ts';
import { getDevice } from '../devices.ts';
import type { AppContext } from '../context.ts';

export async function handleSetup(req: Request, ctx: AppContext): Promise<Response> {
  // Peek at the step without consuming the body twice: steps 2 and 3 use the
  // normal device guard, which reads the body itself.
  const step = req.headers.get('x-vesper-setup-step');
  if (step === 'begin') return begin(req, ctx);
  if (step === 'confirm_totp') return confirmTotp(req, ctx);
  if (step === 'set_secrets') return setSecrets(req, ctx);
  return fail('bad_request');
}

function vmInfo(vm: { sign_public_key: string; enc_public_key: string; fingerprint: string }) {
  return { sign_public_key: JSON.parse(vm.sign_public_key), enc_public_key: JSON.parse(vm.enc_public_key), fingerprint: vm.fingerprint };
}

async function begin(req: Request, ctx: AppContext): Promise<Response> {
  const m = await preflight(req, ctx, 'authPerIp');
  if (m instanceof Response) return m;
  const raw = await readBodyOr413(req);
  if (raw instanceof Response) return raw;

  let body: Record<string, unknown>;
  let device: { id: string; name: string; sign: unknown; enc: unknown };
  try {
    body = asObject(parseJson(raw));
    if (body.step !== 'begin') return fail('bad_request');
    const d = asObject(body.device, 'device');
    device = { id: uuid(d.id, 'device.id'), name: deviceName(d.name), sign: d.sign_public_key, enc: d.enc_public_key };
  } catch {
    return fail('bad_request');
  }

  if (!(await setupTokenValid(ctx, body.setup_token))) {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.setup_token', actor: 'anon' });
    return fail('unauthorized');
  }
  const owner = await getOwner(ctx);
  if (owner?.setup_completed_at) return fail('setup_complete');
  const vm = await getVm(ctx);
  if (!vm) return fail('setup_not_ready', { hint: 'run vesper init on the VM first' });

  let signJwk, encJwk;
  try {
    signJwk = await assertValidPublicJwk(device.sign);
    encJwk = await assertValidPublicJwk(device.enc);
  } catch {
    return fail('bad_request');
  }
  // Proof of possession: the request must be signed by the key being registered.
  const h = readSigHeaders(req);
  if (!h || h.deviceId !== device.id || (await checkSignature(ctx, m, signJwk, h, raw, `dev:${device.id}`)) !== 'ok') {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.signature', actor: `device:${device.id}`, detail: { step: 'setup' } });
    return fail('unauthorized');
  }
  if (!passwordAcceptable(body.password)) return fail('weak_password');

  // Restarting an unfinished setup is allowed until a device has been approved by the VM.
  const approved = await first(ctx.db, 'SELECT id FROM devices WHERE vm_approved_at IS NOT NULL LIMIT 1');
  if (approved) return fail('conflict', { hint: 'a device is already approved; continue setup on that device' });

  const now = m.now;
  const totpSecret = generateTotpSecret();
  const fingerprint = await computeFingerprint(signJwk, encJwk);
  await ctx.db.batch([
    { sql: 'DELETE FROM sessions' },
    { sql: 'DELETE FROM devices WHERE vm_approved_at IS NULL' },
    { sql: 'DELETE FROM owner' },
    insert('owner', {
      id: 1,
      password_hash: await hashSecret(body.password as string, ARGON2_PASSWORD),
      totp_secret_enc: encryptAtRest(ctx.env.totpEncKey, totpSecret),
      totp_confirmed: 0,
      totp_last_step: 0,
      setup_completed_at: null,
      created_at: now,
    }),
    insert('devices', {
      id: device.id,
      name: device.name,
      sign_public_key: JSON.stringify(signJwk),
      enc_public_key: JSON.stringify(encJwk),
      fingerprint,
      enrolled_at: now,
      enrolled_via: 'setup',
      last_seen_at: now,
      last_ip: m.ip,
      last_country: m.country,
    }),
    auditStatement(ctx, { event: 'setup.begin', actor: `device:${device.id}`, result: 'ok', ip: m.ip, country: m.country }),
    auditStatement(ctx, { event: 'device.enroll', actor: `device:${device.id}`, result: 'ok', ip: m.ip, country: m.country, detail: { via: 'setup' } }),
  ]);
  const cookie = await createSession(ctx, device.id);
  return json(
    {
      device: { id: device.id, fingerprint },
      totp: { secret: base32Encode(totpSecret), uri: otpauthUri(totpSecret) },
      vm: vmInfo(vm),
    },
    200,
    { 'Set-Cookie': cookie },
  );
}

async function confirmTotp(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx, { approved: false });
  if (a instanceof Response) return a;
  const body = parseJson(a.body) as Record<string, unknown> | undefined;
  if (!body || body.step !== 'confirm_totp') return fail('bad_request');
  if (!(await setupTokenValid(ctx, body.setup_token))) {
    await recordAuthFailure(ctx, { ip: a.ip, country: a.country, event: 'auth.fail.setup_token', actor: `device:${a.device.id}` });
    return fail('unauthorized');
  }
  const owner = await getOwner(ctx);
  if (!owner || owner.setup_completed_at) return fail('setup_complete');
  if (!(await checkTotp(ctx, owner, String(body.code ?? '')))) {
    await recordAuthFailure(ctx, { ip: a.ip, country: a.country, event: 'auth.fail.totp', actor: `device:${a.device.id}`, detail: { step: 'setup' } });
    return fail('unauthorized');
  }
  await ctx.db.batch([
    { sql: 'UPDATE owner SET totp_confirmed = 1 WHERE id = 1' },
    auditStatement(ctx, { event: 'setup.totp_confirmed', actor: `device:${a.device.id}`, result: 'ok', ip: a.ip }),
  ]);
  return json({ ok: true });
}

async function setSecrets(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx, { approved: false });
  if (a instanceof Response) return a;
  const body = parseJson(a.body) as Record<string, unknown> | undefined;
  if (!body || body.step !== 'set_secrets') return fail('bad_request');
  if (!(await setupTokenValid(ctx, body.setup_token))) {
    await recordAuthFailure(ctx, { ip: a.ip, country: a.country, event: 'auth.fail.setup_token', actor: `device:${a.device.id}` });
    return fail('unauthorized');
  }
  const owner = await getOwner(ctx);
  if (!owner || owner.setup_completed_at) return fail('setup_complete');
  if (!owner.totp_confirmed) return fail('not_ready', { need: 'totp' });
  const device = await getDevice(ctx, a.device.id);
  if (!device?.vm_approved_at) return fail('not_ready', { need: 'vm_approval' });

  const recovery = normalizeUserSecret(body.recovery_key);
  const breakGlass = normalizeUserSecret(body.break_glass_key);
  const kill = normalizeUserSecret(body.kill_token);
  if (!recovery || !breakGlass || !kill || new Set([recovery, breakGlass, kill]).size !== 3) return fail('bad_request');

  const now = a.now;
  await ctx.db.batch([
    await upsertSecretStatement(ctx, 'recovery', recovery),
    await upsertSecretStatement(ctx, 'break_glass', breakGlass),
    await upsertSecretStatement(ctx, 'kill_token', kill),
    // Record the setup token as used (only its hash is stored). §11.1 step 8.
    {
      sql: `INSERT INTO secrets_meta (kind, hash, created_at, used_at) VALUES ('setup', ?, CAST(? AS INTEGER), CAST(? AS INTEGER))
            ON CONFLICT (kind) DO UPDATE SET used_at = excluded.used_at`,
      params: [await hashSecret(String(body.setup_token), ARGON2_TOKEN), now, now],
    },
    { sql: 'UPDATE owner SET setup_completed_at = CAST(? AS INTEGER) WHERE id = 1', params: [now] },
    auditStatement(ctx, { event: 'setup.complete', actor: `device:${a.device.id}`, result: 'ok', ip: a.ip, country: a.country }),
  ]);
  return json({ ok: true });
}
