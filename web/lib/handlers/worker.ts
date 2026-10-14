// Worker endpoints (§7 "Worker 端"). All require the worker token AND a VM
// signature (except /register, which uses the setup token + proof of possession).

import { assertValidPublicJwk, importVerifyKey } from '@vesper/core/keys';
import { computeFingerprint } from '@vesper/core/fingerprint';
import { approvalSigningString, revocationSigningString, verifyOutput, verifyString } from '@vesper/core/sign';
import { asObject, bool, int, oneOf, parseOutputEnvelopes, str, uuid } from '@vesper/core/schemas';
import { canonicalJson } from '@vesper/core/canonical';
import { run } from '../db/types.ts';
import { fail, json, parseJson } from '../http.ts';
import { authWorker, checkSignature, getVm, preflight, readBodyOr413, readSigHeaders } from '../guard.ts';
import { recordAuthFailure } from '../rate-limit.ts';
import { raiseAlert } from '../alerts.ts';
import { audit, auditStatement } from '../audit.ts';
import { notify } from '../notify.ts';
import { getOwner, setupTokenValid } from '../owner.ts';
import { hashSecret, ARGON2_TOKEN } from '../server-crypto.ts';
import { deviceEncJwk, deviceSignJwk, getDevice, pendingDevices } from '../devices.ts';
import { claimTickets, failTicketsOfDevice, runMaintenance, storeFailure, storeResult } from '../tickets.ts';
import type { AppContext } from '../context.ts';

// POST /api/worker/register — exception: setup token only (+ the request is signed by the VM key being registered).
export async function handleWorkerRegister(req: Request, ctx: AppContext): Promise<Response> {
  const m = await preflight(req, ctx, 'authPerIp');
  if (m instanceof Response) return m;
  const raw = await readBodyOr413(req);
  if (raw instanceof Response) return raw;
  let body: Record<string, unknown>;
  let workerToken: string;
  try {
    body = asObject(parseJson(raw));
    workerToken = str(body.worker_token, 'worker_token', { min: 43, max: 128, re: /^[A-Za-z0-9_-]+$/ });
  } catch {
    return fail('bad_request');
  }
  if (!(await setupTokenValid(ctx, body.setup_token))) {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.setup_token', actor: 'vm' });
    return fail('unauthorized');
  }
  // Once a device has started setup it has seen (and the user compared) this VM's fingerprint: the VM identity is then fixed.
  if (await getOwner(ctx)) return fail('conflict', { hint: 'setup already started on a device' });

  let signJwk, encJwk;
  try {
    const vm = asObject(body.vm, 'vm');
    signJwk = await assertValidPublicJwk(vm.sign_public_key);
    encJwk = await assertValidPublicJwk(vm.enc_public_key);
  } catch {
    return fail('bad_request');
  }
  const h = readSigHeaders(req);
  if (!h || (await checkSignature(ctx, m, signJwk, h, raw, 'vm')) !== 'ok') {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.signature', actor: 'vm', detail: { step: 'register' } });
    return fail('unauthorized');
  }
  const fingerprint = await computeFingerprint(signJwk, encJwk);
  await ctx.db.batch([
    { sql: 'DELETE FROM vm_identity' },
    {
      sql: `INSERT INTO vm_identity (id, sign_public_key, enc_public_key, fingerprint, registered_at, last_seen_at, last_ip, latched)
            VALUES (1, ?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), ?, 0)`,
      params: [JSON.stringify(signJwk), JSON.stringify(encJwk), fingerprint, m.now, m.now, m.ip],
    },
    {
      sql: `INSERT INTO secrets_meta (kind, hash, created_at) VALUES ('worker_token', ?, CAST(? AS INTEGER))
            ON CONFLICT (kind) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at, used_at = NULL`,
      params: [await hashSecret(workerToken, ARGON2_TOKEN), m.now],
    },
    auditStatement(ctx, { event: 'vm.register', actor: 'vm', result: 'ok', ip: m.ip, country: m.country, detail: { fingerprint } }),
  ]);
  return json({ ok: true, fingerprint });
}

// POST /api/worker/pull  { max, latched } — heartbeat + state; claims tickets only in NORMAL.
export async function handleWorkerPull(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authWorker(req, ctx, { allowLocked: true });
  if (a instanceof Response) return a;
  let max: number;
  let latched: boolean;
  try {
    const b = asObject(parseJson(a.body));
    max = int(b.max, 'max', { min: 0, max: 5 });
    latched = bool(b.latched, 'latched');
  } catch {
    return fail('bad_request');
  }
  await run(ctx.db, 'UPDATE vm_identity SET latched = CAST(? AS INTEGER) WHERE id = 1', [latched ? 1 : 0]);

  // LOCKDOWN / KILLED: the worker only learns the state (§6.2).
  if (a.state.state === 'LOCKDOWN' || a.state.state === 'KILLED') {
    return json({ state: a.state.state, server_time: a.now, tickets: [], pending_devices: [] });
  }
  await runMaintenance(ctx);
  const tickets = a.state.state === 'NORMAL' && !latched ? await claimTickets(ctx, max) : [];
  const pending = await pendingDevices(ctx);
  return json({
    state: a.state.state,
    server_time: a.now,
    tickets: tickets.map((t) => ({
      id: t.id,
      type: t.type,
      target: t.target,
      device_id: t.device_id,
      input_envelope: JSON.parse(String(t.input_envelope)),
      input_sig: t.input_sig,
      input_nonce: t.input_nonce,
      input_ts: Number(t.input_ts),
      attempts: Number(t.attempts),
      created_at: Number(t.created_at),
    })),
    // Candidates for `vesper device approve`. The VM recomputes fingerprints itself and trusts nothing here.
    pending_devices: pending.map((d) => ({
      id: d.id,
      name: d.name,
      sign_public_key: deviceSignJwk(d),
      enc_public_key: deviceEncJwk(d),
      enrolled_at: d.enrolled_at,
    })),
  });
}

const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

// POST /api/worker/result
//   { ticket_id, ok: true, processed_at, output_envelopes, output_sig }
//   { ticket_id, ok: false, error_code }
export async function handleWorkerResult(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authWorker(req, ctx);
  if (a instanceof Response) return a;
  let b: Record<string, unknown>;
  let ticketId: string;
  try {
    b = asObject(parseJson(a.body));
    ticketId = uuid(b.ticket_id, 'ticket_id');
  } catch {
    return fail('bad_request');
  }
  if (b.ok === false) {
    let code: string;
    try {
      code = str(b.error_code, 'error_code', { re: ERROR_CODE_RE });
    } catch {
      return fail('bad_request');
    }
    const r = await storeFailure(ctx, ticketId, code);
    return r === 'ok' ? json({ ok: true }) : fail(r === 'not_found' ? 'not_found' : 'conflict');
  }
  let processedAt: number;
  let envelopes;
  let sig: string;
  try {
    processedAt = int(b.processed_at, 'processed_at', { min: 0 });
    envelopes = parseOutputEnvelopes(b.output_envelopes);
    sig = str(b.output_sig, 'output_sig', { min: 40, max: 200 });
  } catch {
    return fail('bad_request');
  }
  if (Math.abs(processedAt - a.now) > 10 * 60_000) return fail('bad_request');
  // Sanity check with the registered VM key (devices verify it again with their pinned key).
  const vmKey = await importVerifyKey(JSON.parse(a.vm.sign_public_key));
  if (!(await verifyOutput(vmKey, ticketId, envelopes, sig))) {
    await audit(ctx, { event: 'ticket.output_signature_invalid', actor: 'vm', result: 'fail', ip: a.ip, detail: { ticket: ticketId } });
    return fail('bad_request');
  }
  const r = await storeResult(ctx, ticketId, processedAt, canonicalJson(envelopes), sig);
  if (r !== 'ok') return fail(r === 'not_found' ? 'not_found' : 'conflict');
  notify(ctx, 'review', 1);
  return json({ ok: true });
}

// POST /api/worker/device-approval — VM-signed approval or revocation of a device.
//   { action: 'approve', device_id, fingerprint, approved_at, sig }
//   { action: 'revoke', device_id, revoked_at, sig }
export async function handleWorkerDeviceApproval(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authWorker(req, ctx);
  if (a instanceof Response) return a;
  let b: Record<string, unknown>;
  let action: 'approve' | 'revoke';
  let deviceId: string;
  let sig: string;
  try {
    b = asObject(parseJson(a.body));
    action = oneOf(b.action, 'action', ['approve', 'revoke'] as const);
    deviceId = uuid(b.device_id, 'device_id');
    sig = str(b.sig, 'sig', { min: 40, max: 200 });
  } catch {
    return fail('bad_request');
  }
  const vmKey = await importVerifyKey(JSON.parse(a.vm.sign_public_key));
  const device = await getDevice(ctx, deviceId);
  if (!device) return fail('not_found');

  if (action === 'approve') {
    let fingerprint: string;
    let approvedAt: number;
    try {
      fingerprint = str(b.fingerprint, 'fingerprint', { re: /^\d{5}( \d{5}){5}$/ });
      approvedAt = int(b.approved_at, 'approved_at', { min: 0 });
    } catch {
      return fail('bad_request');
    }
    if (!(await verifyString(vmKey, approvalSigningString({ deviceId, fingerprint, approvedAt }), sig))) return fail('bad_request');
    // The VM approved the keys it saw; they must be the keys stored here, or Vercel's copy was altered.
    const expected = await computeFingerprint(deviceSignJwk(device), deviceEncJwk(device));
    if (expected !== fingerprint || device.fingerprint !== fingerprint) {
      await raiseAlert(ctx, { rule: 'tamper', severity: 'high', deviceId, ip: a.ip, country: a.country, reason: 'approval_fingerprint_mismatch' });
      return fail('conflict');
    }
    if (device.revoked_at !== null) return fail('conflict');
    await ctx.db.batch([
      {
        sql: 'UPDATE devices SET vm_approved_at = CAST(? AS INTEGER), vm_approval_sig = ? WHERE id = ? AND revoked_at IS NULL',
        params: [approvedAt, sig, deviceId],
      },
      auditStatement(ctx, { event: 'device.vm_approve', actor: 'vm', result: 'ok', ip: a.ip, detail: { device: deviceId } }),
    ]);
    return json({ ok: true });
  }

  let revokedAt: number;
  try {
    revokedAt = int(b.revoked_at, 'revoked_at', { min: 0 });
  } catch {
    return fail('bad_request');
  }
  if (!(await verifyString(vmKey, revocationSigningString({ deviceId, revokedAt }), sig))) return fail('bad_request');
  await ctx.db.batch([
    { sql: 'UPDATE devices SET revoked_at = CAST(? AS INTEGER) WHERE id = ? AND revoked_at IS NULL', params: [a.now, deviceId] },
    { sql: 'DELETE FROM sessions WHERE device_id = ?', params: [deviceId] },
    { sql: 'DELETE FROM push_subscriptions WHERE device_id = ?', params: [deviceId] },
    failTicketsOfDevice(deviceId, a.now),
    auditStatement(ctx, { event: 'device.revoke', actor: 'vm', result: 'ok', ip: a.ip, detail: { device: deviceId, side: 'vm' } }),
  ]);
  return json({ ok: true });
}

// POST /api/worker/alert  { rule: 'R8', reason, ticket_id? } — VM-side events.
export async function handleWorkerAlert(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authWorker(req, ctx);
  if (a instanceof Response) return a;
  let reason: string;
  let ticketId: string | null = null;
  try {
    const b = asObject(parseJson(a.body));
    oneOf(b.rule, 'rule', ['R8'] as const);
    reason = str(b.reason, 'reason', { re: ERROR_CODE_RE });
    if (b.ticket_id !== undefined) ticketId = uuid(b.ticket_id, 'ticket_id');
  } catch {
    return fail('bad_request');
  }
  await run(ctx.db, 'UPDATE vm_identity SET latched = 1 WHERE id = 1');
  await raiseAlert(ctx, { rule: 'R8', severity: 'high', ip: a.ip, country: a.country, reason });
  if (ticketId) await audit(ctx, { event: 'vm.r8', actor: 'vm', result: 'fail', ip: a.ip, detail: { ticket: ticketId, reason } });
  return json({ ok: true });
}
