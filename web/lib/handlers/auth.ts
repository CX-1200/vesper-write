// Login / logout / passkey (OD2: password + TOTP is primary, passkey optional;
// both ALWAYS also require the device signature, §11).
//
// R1: a login attempt from an unknown device, a revoked device, or with a
// device signature that does not verify → reject + alert to all devices.

import { isLocked } from '@vesper/core/system-state';
import { asObject, uuid } from '@vesper/core/schemas';
import { b64urlDecode, b64urlEncode, randomUuid } from '@vesper/core/encoding';
import { run } from '../db/types.ts';
import { fail, json, parseJson } from '../http.ts';
import { authDevice, checkSignature, preflight, readBodyOr413, readSigHeaders, type RequestMeta } from '../guard.ts';
import { recordAuthFailure } from '../rate-limit.ts';
import { raiseAlert } from '../alerts.ts';
import { audit, auditStatement } from '../audit.ts';
import { currentSystemState } from '../system.ts';
import { clearSessionCookie, createSession, deleteSession } from '../sessions.ts';
import { deviceSignJwk, getDevice, type DeviceRow } from '../devices.ts';
import { burnArgon2, verifySecret, ARGON2_PASSWORD } from '../server-crypto.ts';
import { checkTotp, getOwner } from '../owner.ts';
import { insert } from '../sql.ts';
import type { AppContext } from '../context.ts';

/** Shared front half of the session-less login endpoints. */
async function loginPreamble(
  req: Request,
  ctx: AppContext,
): Promise<{ m: RequestMeta; raw: string; body: Record<string, unknown>; device: DeviceRow } | Response> {
  const m = await preflight(req, ctx, 'authPerIp');
  if (m instanceof Response) return m;
  const raw = await readBodyOr413(req);
  if (raw instanceof Response) return raw;
  const state = await currentSystemState(ctx);
  if (isLocked(state.state)) return fail('locked', { state: state.state });

  let body: Record<string, unknown>;
  let deviceId: string;
  try {
    body = asObject(parseJson(raw));
    deviceId = uuid(body.device_id, 'device_id');
  } catch {
    return fail('bad_request');
  }
  const device = await getDevice(ctx, deviceId);
  const h = readSigHeaders(req);
  const sigOk = !!device && device.revoked_at === null && !!h && h.deviceId === deviceId && (await checkSignature(ctx, m, deviceSignJwk(device), h, raw, `dev:${deviceId}`)) === 'ok';
  if (!device || device.revoked_at !== null || !sigOk) {
    // R1: unregistered/revoked device or a signature that is not from the registered device key.
    await burnArgon2(ARGON2_PASSWORD);
    await recordAuthFailure(ctx, {
      ip: m.ip,
      country: m.country,
      event: 'auth.fail.unknown_device',
      actor: `device:${deviceId}`,
      detail: { known: !!device, revoked: !!device?.revoked_at },
    });
    await raiseAlert(ctx, { rule: 'R1', severity: 'high', deviceId: device ? deviceId : null, ip: m.ip, country: m.country, reason: device ? 'bad_device_signature' : 'unregistered_device' });
    return fail('unauthorized');
  }
  return { m, raw, body, device };
}

async function finishLogin(ctx: AppContext, m: RequestMeta, device: DeviceRow, method: string): Promise<Response> {
  const cookie = await createSession(ctx, device.id);
  await ctx.db.batch([
    {
      sql: `UPDATE devices SET last_seen_at = CAST(? AS INTEGER), last_ip = ?${m.country ? ', last_country = ?' : ''} WHERE id = ?`,
      params: m.country ? [m.now, m.ip, m.country, device.id] : [m.now, m.ip, device.id],
    },
    auditStatement(ctx, { event: 'auth.login', actor: `device:${device.id}`, result: 'ok', ip: m.ip, country: m.country, detail: { method } }),
  ]);
  return json({ ok: true, approved: device.vm_approved_at !== null }, 200, { 'Set-Cookie': cookie });
}

// POST /api/auth/login  { device_id, password, totp }
export async function handleLogin(req: Request, ctx: AppContext): Promise<Response> {
  const p = await loginPreamble(req, ctx);
  if (p instanceof Response) return p;
  const { m, body, device } = p;
  const owner = await getOwner(ctx);
  const passwordOk = await verifySecret(String(body.password ?? ''), owner?.password_hash);
  const totpOk = passwordOk && owner ? await checkTotp(ctx, owner, String(body.totp ?? '')) : false;
  if (!passwordOk || !totpOk) {
    await recordAuthFailure(ctx, {
      ip: m.ip,
      country: m.country,
      event: passwordOk ? 'auth.fail.totp' : 'auth.fail.password',
      actor: `device:${device.id}`,
    });
    return fail('unauthorized');
  }
  return finishLogin(ctx, m, device, 'password_totp');
}

// POST /api/auth/logout
export async function handleLogout(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx, { approved: false });
  if (a instanceof Response) return a.status === 401 ? json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() }) : a;
  await deleteSession(ctx, a.session.id_hash);
  await audit(ctx, { event: 'auth.logout', actor: `device:${a.device.id}`, result: 'ok', ip: a.ip });
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

// ---------------------------------------------------------------------------
// Passkeys (optional, OD2)
// ---------------------------------------------------------------------------

const CHALLENGE_TTL_MS = 5 * 60_000;

async function webauthn() {
  // Loaded lazily: only passkey requests pay for the import.
  return import('@simplewebauthn/server');
}

async function storeChallenge(ctx: AppContext, deviceId: string, purpose: 'register' | 'login', challenge: string): Promise<string> {
  const id = randomUuid();
  await ctx.db.batch([
    { sql: 'DELETE FROM webauthn_challenges WHERE expires_at < ? OR (device_id = ? AND purpose = ?)', params: [ctx.now(), deviceId, purpose] },
    insert('webauthn_challenges', { id, device_id: deviceId, purpose, challenge, expires_at: ctx.now() + CHALLENGE_TTL_MS }),
  ]);
  return id;
}

async function takeChallenge(ctx: AppContext, deviceId: string, purpose: 'register' | 'login'): Promise<string | null> {
  const [r] = await ctx.db.batch([
    {
      sql: 'DELETE FROM webauthn_challenges WHERE device_id = ? AND purpose = ? AND expires_at >= CAST(? AS INTEGER) RETURNING challenge',
      params: [deviceId, purpose, ctx.now()],
    },
  ]);
  const row = r?.rows[0];
  return row ? String(row.challenge) : null;
}

// POST /api/auth/passkey/options  { purpose: 'register' } (session) | { purpose: 'login', device_id } (no session)
export async function handlePasskeyOptions(req: Request, ctx: AppContext): Promise<Response> {
  const purpose = req.headers.get('x-vesper-passkey-purpose');
  const sw = await webauthn();
  if (purpose === 'register') {
    const a = await authDevice(req, ctx);
    if (a instanceof Response) return a;
    const options = await sw.generateRegistrationOptions({
      rpName: 'Vesper',
      rpID: ctx.env.rpId,
      userName: 'owner',
      userID: new TextEncoder().encode('vesper-owner'),
      attestationType: 'none',
      excludeCredentials: a.device.webauthn_credential_id ? [{ id: a.device.webauthn_credential_id }] : [],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257],
    });
    await storeChallenge(ctx, a.device.id, 'register', options.challenge);
    return json({ options });
  }
  if (purpose === 'login') {
    const p = await loginPreamble(req, ctx);
    if (p instanceof Response) return p;
    if (!p.device.webauthn_credential_id) return fail('not_ready', { need: 'passkey' });
    const options = await sw.generateAuthenticationOptions({
      rpID: ctx.env.rpId,
      allowCredentials: [{ id: p.device.webauthn_credential_id }],
      userVerification: 'required',
    });
    await storeChallenge(ctx, p.device.id, 'login', options.challenge);
    return json({ options });
  }
  return fail('bad_request');
}

// POST /api/auth/passkey/verify  { purpose, response, device_id? }
export async function handlePasskeyVerify(req: Request, ctx: AppContext): Promise<Response> {
  const purpose = req.headers.get('x-vesper-passkey-purpose');
  const sw = await webauthn();
  if (purpose === 'register') {
    const a = await authDevice(req, ctx);
    if (a instanceof Response) return a;
    const body = parseJson(a.body) as { response?: unknown } | undefined;
    const challenge = await takeChallenge(ctx, a.device.id, 'register');
    if (!body?.response || !challenge) return fail('bad_request');
    try {
      const v = await sw.verifyRegistrationResponse({
        response: body.response as Parameters<typeof sw.verifyRegistrationResponse>[0]['response'],
        expectedChallenge: challenge,
        expectedOrigin: ctx.env.appOrigin,
        expectedRPID: ctx.env.rpId,
        requireUserVerification: true,
      });
      if (!v.verified) return fail('bad_request');
      const cred = v.registrationInfo.credential;
      await ctx.db.batch([
        {
          sql: 'UPDATE devices SET webauthn_credential_id = ?, webauthn_public_key = ?, sign_count = CAST(? AS INTEGER) WHERE id = ?',
          params: [cred.id, b64urlEncode(cred.publicKey), cred.counter, a.device.id],
        },
        auditStatement(ctx, { event: 'auth.passkey_registered', actor: `device:${a.device.id}`, result: 'ok', ip: a.ip }),
      ]);
      return json({ ok: true });
    } catch {
      return fail('bad_request');
    }
  }
  if (purpose === 'login') {
    const p = await loginPreamble(req, ctx);
    if (p instanceof Response) return p;
    const { m, body, device } = p;
    const challenge = await takeChallenge(ctx, device.id, 'login');
    let ok = false;
    let newCounter = 0;
    if (challenge && device.webauthn_credential_id && device.webauthn_public_key && body.response) {
      try {
        const v = await sw.verifyAuthenticationResponse({
          response: body.response as Parameters<typeof sw.verifyAuthenticationResponse>[0]['response'],
          expectedChallenge: challenge,
          expectedOrigin: ctx.env.appOrigin,
          expectedRPID: ctx.env.rpId,
          credential: { id: device.webauthn_credential_id, publicKey: new Uint8Array(b64urlDecode(device.webauthn_public_key)), counter: device.sign_count },
          requireUserVerification: true,
        });
        ok = v.verified;
        newCounter = v.authenticationInfo.newCounter;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.passkey', actor: `device:${device.id}` });
      return fail('unauthorized');
    }
    // A counter that does not increase can indicate a cloned authenticator (0 means the authenticator has no counter).
    const changes = await run(ctx.db, 'UPDATE devices SET sign_count = CAST(? AS INTEGER) WHERE id = ? AND (sign_count < CAST(? AS INTEGER) OR CAST(? AS INTEGER) = 0)', [
      newCounter,
      device.id,
      newCounter,
      newCounter,
    ]);
    if (changes !== 1) {
      await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.passkey_counter', actor: `device:${device.id}` });
      return fail('unauthorized');
    }
    return finishLogin(ctx, m, device, 'passkey');
  }
  return fail('bad_request');
}
