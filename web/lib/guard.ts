// Request authentication pipelines (§7, §8.4).
//
// Device endpoints: rate limit → system state → session → device signature
// (key from Vercel's DB, §8.4) → ±60 s freshness → nonce not seen before.
// Worker endpoints: rate limit → worker token → VM signature (R7 on failure)
// → freshness → nonce.

import { isLocked, type SystemState } from '@vesper/core/system-state';
import { importVerifyKey, type EcPublicJwk } from '@vesper/core/keys';
import { isFresh, isValidNonce, verifyRequestSignature } from '@vesper/core/sign';
import { CONFIG } from '@vesper/core/config';
import { first, run } from './db/types.ts';
import { BodyTooLargeError, clientCountry, clientIp, fail, readBody, signedPath } from './http.ts';
import { isBlocked, overRateLimit, recordAuthFailure, type RateClass } from './rate-limit.ts';
import { currentSystemState, applySystem } from './system.ts';
import { deleteSession, findSession, type SessionRow } from './sessions.ts';
import { deviceSignJwk, getDevice, isApproved, type DeviceRow } from './devices.ts';
import { consumeNonce } from './nonces.ts';
import { verifySecret } from './server-crypto.ts';
import { raiseAlert } from './alerts.ts';
import { audit } from './audit.ts';
import { num, strOrNull } from './sql.ts';
import type { AppContext } from './context.ts';

export interface RequestMeta {
  ip: string;
  country: string | null;
  now: number;
  method: string;
  path: string;
}

export interface SigHeaders {
  deviceId: string | null;
  ts: number;
  nonce: string;
  sig: string;
}

export function requestMeta(req: Request, ctx: AppContext): RequestMeta {
  return { ip: clientIp(req, ctx.env), country: clientCountry(req), now: ctx.now(), method: req.method.toUpperCase(), path: signedPath(req) };
}

export function readSigHeaders(req: Request): SigHeaders | null {
  const ts = Number(req.headers.get('x-vesper-ts'));
  const nonce = req.headers.get('x-vesper-nonce');
  const sig = req.headers.get('x-vesper-sig');
  if (!Number.isSafeInteger(ts) || !isValidNonce(nonce) || !sig || sig.length > 200) return null;
  return { deviceId: req.headers.get('x-vesper-device'), ts, nonce, sig };
}

/** Block list (R3) and per-minute rate limit. */
export async function preflight(req: Request, ctx: AppContext, cls: RateClass): Promise<RequestMeta | Response> {
  const m = requestMeta(req, ctx);
  if (await isBlocked(ctx, m.ip)) return fail('rate_limited');
  if (await overRateLimit(ctx, cls, m.ip)) return fail('rate_limited');
  return m;
}

export async function readBodyOr413(req: Request): Promise<string | Response> {
  try {
    return await readBody(req);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return fail('payload_too_large');
    return fail('bad_request');
  }
}

export type SigCheck = 'ok' | 'bad_signature' | 'stale' | 'replay';

/** Verify a request signature made with `jwk`, then freshness, then consume the nonce. */
export async function checkSignature(ctx: AppContext, m: RequestMeta, jwk: EcPublicJwk, h: SigHeaders, body: string, scope: string): Promise<SigCheck> {
  let key: CryptoKey;
  try {
    key = await importVerifyKey(jwk);
  } catch {
    return 'bad_signature';
  }
  const ok = await verifyRequestSignature(key, { method: m.method, path: m.path, ts: h.ts, nonce: h.nonce, body }, h.sig);
  if (!ok) return 'bad_signature';
  if (!isFresh(h.ts, m.now, CONFIG.signatureWindowMs)) return 'stale';
  if (!(await consumeNonce(ctx, scope, h.nonce))) return 'replay';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Device requests
// ---------------------------------------------------------------------------

export interface DeviceAuth extends RequestMeta {
  device: DeviceRow;
  session: SessionRow;
  body: string;
  state: SystemState;
}

export async function authDevice(req: Request, ctx: AppContext, opts: { approved?: boolean } = {}): Promise<DeviceAuth | Response> {
  const m = await preflight(req, ctx, 'devicePerIp');
  if (m instanceof Response) return m;
  const body = await readBodyOr413(req);
  if (body instanceof Response) return body;

  const state = await currentSystemState(ctx);
  if (isLocked(state.state)) return fail('locked', { state: state.state });

  const session = await findSession(ctx, req);
  if (!session) return fail('unauthorized', { login: true });
  if (num(session.frozen) === 1) return fail('forbidden', { frozen: true });

  const h = readSigHeaders(req);
  if (!h || h.deviceId !== session.device_id) {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.signature', actor: `device:${session.device_id}`, detail: { reason: 'missing_or_mismatched_headers' } });
    return fail('unauthorized');
  }
  const device = await getDevice(ctx, session.device_id);
  if (!device || device.revoked_at !== null) {
    await deleteSession(ctx, session.id_hash);
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.revoked_device', actor: `device:${session.device_id}` });
    return fail('unauthorized', { login: true });
  }
  const check = await checkSignature(ctx, m, deviceSignJwk(device), h, body, `dev:${device.id}`);
  if (check !== 'ok') {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: `auth.fail.${check}`, actor: `device:${device.id}` });
    return fail('unauthorized');
  }
  if (opts.approved !== false && !isApproved(device)) return fail('forbidden', { pending_approval: true });

  if (device.last_seen_at === null || m.now - device.last_seen_at > 60_000 || device.last_ip !== m.ip) {
    await ctx.db.batch([
      {
        sql: `UPDATE devices SET last_seen_at = CAST(? AS INTEGER), last_ip = ?${m.country ? ', last_country = ?' : ''} WHERE id = ?`,
        params: m.country ? [m.now, m.ip, m.country, device.id] : [m.now, m.ip, device.id],
      },
    ]);
  }
  return { ...m, device, session, body, state };
}

// ---------------------------------------------------------------------------
// Worker requests
// ---------------------------------------------------------------------------

export interface VmRow {
  sign_public_key: string;
  enc_public_key: string;
  fingerprint: string;
  registered_at: number;
  last_seen_at: number | null;
  last_ip: string | null;
  latched: number;
}

export async function getVm(ctx: AppContext): Promise<VmRow | null> {
  const r = await first<VmRow>(ctx.db, 'SELECT sign_public_key, enc_public_key, fingerprint, registered_at, last_seen_at, last_ip, latched FROM vm_identity WHERE id = 1');
  return r ? { ...r, last_seen_at: r.last_seen_at === null ? null : num(r.last_seen_at), last_ip: strOrNull(r.last_ip), latched: num(r.latched) } : null;
}

export interface WorkerAuth extends RequestMeta {
  body: string;
  state: SystemState;
  vm: VmRow;
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h ? /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(h) : null;
  return m ? m[1]! : null;
}

export async function authWorker(req: Request, ctx: AppContext, opts: { allowLocked?: boolean } = {}): Promise<WorkerAuth | Response> {
  const m = await preflight(req, ctx, 'workerPerIp');
  if (m instanceof Response) return m;
  const body = await readBodyOr413(req);
  if (body instanceof Response) return body;

  // 1. worker token (slow hash)
  const token = bearer(req);
  const row = await first<{ hash: string }>(ctx.db, "SELECT hash FROM secrets_meta WHERE kind = 'worker_token'");
  const vm = await getVm(ctx);
  if (!token || !row || !vm || !(await verifySecret(token, row.hash))) {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.worker_token', actor: 'vm' });
    return fail('unauthorized');
  }

  // 2. VM signature. A valid token with an invalid VM signature means the
  //    token leaked without the VM key → R7: LOCKDOWN.
  const h = readSigHeaders(req);
  const check = h ? await checkSignature(ctx, m, JSON.parse(vm.sign_public_key) as EcPublicJwk, h, body, 'vm') : 'bad_signature';
  if (check === 'bad_signature') {
    await audit(ctx, { event: 'auth.fail.vm_signature', actor: 'vm', result: 'fail', ip: m.ip, country: m.country, detail: { path: m.path } });
    await applySystem(ctx, { type: 'vm_sig_invalid', now: m.now });
    await raiseAlert(ctx, { rule: 'R7', severity: 'high', ip: m.ip, country: m.country, reason: 'invalid_vm_signature' });
    return fail('unauthorized');
  }
  if (check !== 'ok') {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: `auth.fail.${check}`, actor: 'vm' });
    return fail('unauthorized');
  }

  // 3. heartbeat bookkeeping + R7 (IP change → alert only)
  const ipChanged = vm.last_ip !== null && vm.last_ip !== m.ip;
  await run(ctx.db, 'UPDATE vm_identity SET last_seen_at = CAST(? AS INTEGER), last_ip = ? WHERE id = 1', [m.now, m.ip]);
  if (ipChanged) await raiseAlert(ctx, { rule: 'R7_ip', severity: 'medium', ip: m.ip, country: m.country, reason: 'worker_ip_changed' });

  const state = await currentSystemState(ctx);
  if (isLocked(state.state) && !opts.allowLocked) return fail('locked', { state: state.state });
  return { ...m, body, state, vm };
}
