// Tickets (§6.1, §7). Vercel only ever sees ciphertext envelopes and metadata.

import { CONFIG } from '@vesper/core/config';
import { parseTicketCreateBody, uuid, ValidationError } from '@vesper/core/schemas';
import { LINT_RULES, type LintRuleId } from '@vesper/core/lint';
import { fail, json, parseJson } from '../http.ts';
import { authDevice } from '../guard.ts';
import { audit, auditStatement } from '../audit.ts';
import { raiseAlert } from '../alerts.ts';
import { insert } from '../sql.ts';
import { isKnownTicketType } from '../ticket-types.ts';
import { getTicket, listTickets, markReviewed, markReviewOutcome, runMaintenance, ticketsCreatedToday } from '../tickets.ts';
import type { AppContext } from '../context.ts';

// POST /api/tickets — body must be the canonical JSON the device signed.
export async function handleTicketCreate(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  let body;
  try {
    body = parseTicketCreateBody(a.body);
  } catch (e) {
    if (e instanceof ValidationError) return fail('bad_request');
    throw e;
  }
  const ts = Number(req.headers.get('x-vesper-ts'));
  // The body's device_id and ts are bound into the AAD; they must match the signer and the signed timestamp.
  if (body.device_id !== a.device.id || body.ts !== ts) return fail('bad_request');
  if (!isKnownTicketType(body.type)) return fail('bad_request');
  if (a.state.state !== 'NORMAL') return fail('locked', { state: a.state.state });
  if ((await ticketsCreatedToday(ctx)) >= CONFIG.dailyTicketCap) {
    await audit(ctx, { event: 'ticket.create', actor: `device:${a.device.id}`, result: 'fail', ip: a.ip, detail: { reason: 'daily_cap' } });
    return fail('daily_cap');
  }
  try {
    await ctx.db.batch([
      insert('tickets', {
        id: body.id,
        type: body.type,
        target: body.target,
        device_id: body.device_id,
        input_envelope: JSON.stringify(body.input_envelope),
        input_sig: req.headers.get('x-vesper-sig')!,
        input_nonce: req.headers.get('x-vesper-nonce')!,
        input_ts: body.ts,
        status: 'pending',
        attempts: 0,
        created_at: a.now,
        stale_at: a.now + CONFIG.staleAfterMs,
      }),
      auditStatement(ctx, { event: 'ticket.create', actor: `device:${a.device.id}`, result: 'ok', ip: a.ip, detail: { ticket: body.id, type: body.type, target: body.target } }),
    ]);
  } catch {
    return fail('conflict');
  }
  return json({ ok: true, id: body.id }, 201);
}

// GET /api/tickets — runs the lazy expiry/stale/lease checks first.
export async function handleTicketList(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  await runMaintenance(ctx);
  const tickets = await listTickets(ctx, 100);
  return json({ tickets, today: await ticketsCreatedToday(ctx), daily_cap: CONFIG.dailyTicketCap, server_time: a.now });
}

function ticketId(params: { id: string }): string | null {
  try {
    return uuid(params.id, 'id');
  } catch {
    return null;
  }
}

// GET /api/tickets/:id — includes ALL output envelopes so the device can verify the VM signature.
export async function handleTicketGet(req: Request, ctx: AppContext, params: { id: string }): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  const id = ticketId(params);
  if (!id) return fail('bad_request');
  await runMaintenance(ctx);
  const t = await getTicket(ctx, id);
  if (!t) return fail('not_found');
  return json({ ticket: t });
}

function lintHigh(body: unknown): LintRuleId[] {
  const list = (body as { lint_high?: unknown })?.lint_high;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((r): r is LintRuleId => typeof r === 'string' && r in LINT_RULES && LINT_RULES[r as LintRuleId].severity === 'high'))];
}

async function finish(req: Request, ctx: AppContext, params: { id: string }, outcome: 'used' | 'rejected'): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  const id = ticketId(params);
  if (!id) return fail('bad_request');
  const high = lintHigh(parseJson(a.body));
  if (high.length) await audit(ctx, { event: 'lint.high', actor: `device:${a.device.id}`, result: 'info', detail: { ticket: id, rules: high } });
  const r = await markReviewOutcome(ctx, id, outcome, `device:${a.device.id}`);
  if (r === 'not_found') return fail('not_found');
  if (r === 'wrong_state') {
    await runMaintenance(ctx);
    const t = await getTicket(ctx, id);
    return t?.status === 'expired' ? fail('expired') : fail('conflict');
  }
  return json({ ok: true });
}

// POST /api/tickets/:id/used
export function handleTicketUsed(req: Request, ctx: AppContext, params: { id: string }): Promise<Response> {
  return finish(req, ctx, params, 'used');
}

// POST /api/tickets/:id/reject
export function handleTicketReject(req: Request, ctx: AppContext, params: { id: string }): Promise<Response> {
  return finish(req, ctx, params, 'rejected');
}

// POST /api/tickets/:id/reviewed — the device opened the output; it reports
// which HIGH lint rules fired (rule ids only, §14) so they are audited.
export async function handleTicketReviewed(req: Request, ctx: AppContext, params: { id: string }): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  const id = ticketId(params);
  if (!id) return fail('bad_request');
  const body = parseJson(a.body) as { mismatch?: unknown; signature_ok?: unknown } | undefined;
  const high = lintHigh(body);
  await markReviewed(ctx, id);
  if (high.length) await audit(ctx, { event: 'lint.high', actor: `device:${a.device.id}`, result: 'info', detail: { ticket: id, rules: high } });
  if (body?.signature_ok === false) {
    // The VM signature over the output did not verify on the device: the stored
    // ciphertext was altered after the VM wrote it. Alert every device.
    await audit(ctx, { event: 'ticket.output_signature_invalid', actor: `device:${a.device.id}`, result: 'fail', ip: a.ip, detail: { ticket: id } });
    await raiseAlert(ctx, { rule: 'tamper', severity: 'high', deviceId: a.device.id, ip: a.ip, country: a.country, reason: 'output_signature_invalid' });
  }
  if (body?.mismatch === true) {
    await audit(ctx, { event: 'lint.vm_device_mismatch', actor: `device:${a.device.id}`, result: 'info', detail: { ticket: id } });
  }
  return json({ ok: true });
}
