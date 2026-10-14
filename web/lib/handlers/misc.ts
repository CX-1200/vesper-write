// Kill switch, push subscription, audit log, config, alerts, secret rotation.

import { CONFIG } from '@vesper/core/config';
import { formatLocal } from '@vesper/core/time';
import { asObject, str } from '@vesper/core/schemas';
import { first } from '../db/types.ts';
import { fail, json, parseJson } from '../http.ts';
import { authDevice, preflight, readBodyOr413 } from '../guard.ts';
import { recordAuthFailure } from '../rate-limit.ts';
import { raiseAlert, recentAlerts } from '../alerts.ts';
import { audit, auditStatement, queryAudit, type AuditResult } from '../audit.ts';
import { applySystem } from '../system.ts';
import { isAllowedPushEndpoint } from '../notify.ts';
import { checkTotp, getOwner, normalizeUserSecret, upsertSecretStatement, verifyStoredSecret } from '../owner.ts';
import { listDevices } from '../devices.ts';
import { TICKET_TYPES } from '../ticket-types.ts';
import type { AppContext } from '../context.ts';

// POST /api/kill — exception: only the kill token, no session. It can ONLY set KILLED.
export async function handleKill(req: Request, ctx: AppContext): Promise<Response> {
  const m = await preflight(req, ctx, 'killPerIp');
  if (m instanceof Response) return m;
  const raw = await readBodyOr413(req);
  if (raw instanceof Response) return raw;
  const body = parseJson(raw) as { kill_token?: unknown } | undefined;
  const token = normalizeUserSecret(body?.kill_token);
  if (!token || !(await verifyStoredSecret(ctx, 'kill_token', token))) {
    await recordAuthFailure(ctx, { ip: m.ip, country: m.country, event: 'auth.fail.kill_token', actor: 'anon' });
    return fail('unauthorized');
  }
  const r = await applySystem(ctx, { type: 'kill', now: m.now });
  await audit(ctx, { event: 'kill_switch', actor: 'kill_token', result: 'ok', ip: m.ip, country: m.country, detail: { state: r.state.state } });
  await raiseAlert(ctx, { rule: 'kill', severity: 'high', ip: m.ip, country: m.country, reason: 'kill_switch', push: false });
  return json({ ok: true, state: r.state.state });
}

// POST /api/push/subscribe  { endpoint, keys: { p256dh, auth } }
export async function handlePushSubscribe(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  let endpoint: string;
  let p256dh: string;
  let authKey: string;
  try {
    const b = asObject(parseJson(a.body));
    endpoint = str(b.endpoint, 'endpoint', { min: 10, max: 1024 });
    const keys = asObject(b.keys, 'keys');
    p256dh = str(keys.p256dh, 'p256dh', { min: 40, max: 200, re: /^[A-Za-z0-9_-]+={0,2}$/ });
    authKey = str(keys.auth, 'auth', { min: 16, max: 64, re: /^[A-Za-z0-9_-]+={0,2}$/ });
  } catch {
    return fail('bad_request');
  }
  if (!isAllowedPushEndpoint(endpoint)) return fail('push_endpoint_not_allowed');
  await ctx.db.batch([
    {
      sql: `INSERT INTO push_subscriptions (endpoint, device_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, CAST(? AS INTEGER))
            ON CONFLICT (endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
      params: [endpoint, a.device.id, p256dh, authKey, a.now],
    },
    auditStatement(ctx, { event: 'push.subscribe', actor: `device:${a.device.id}`, result: 'ok', ip: a.ip }),
  ]);
  return json({ ok: true });
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // CSV injection: a leading = + - @ would be evaluated as a formula by spreadsheet apps.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/audit?view=simple|full[&event=&result=&from=&to=&q=&limit=&offset=&format=csv]
export async function handleAudit(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  const u = new URL(req.url);
  const view = u.searchParams.get('view') === 'full' ? 'full' : 'simple';
  const devices = new Map((await listDevices(ctx)).map((d) => [d.id, d.name]));
  const actorName = (actor: string) => (actor.startsWith('device:') ? (devices.get(actor.slice(7)) ?? actor) : actor);

  if (view === 'simple') {
    const rows = await queryAudit(ctx, { limit: CONFIG.auditSimpleLimit });
    return json({
      view,
      rows: rows.map((r) => ({ ts: r.ts, time: formatLocal(r.ts), event: r.event, result: r.result, device: actorName(r.actor) })),
    });
  }

  const num = (k: string) => {
    const v = u.searchParams.get(k);
    return v && /^\d{1,16}$/.test(v) ? Number(v) : undefined;
  };
  const result = u.searchParams.get('result');
  const rows = await queryAudit(ctx, {
    event: (u.searchParams.get('event') ?? '').slice(0, 64) || undefined,
    result: result === 'ok' || result === 'fail' || result === 'info' ? (result as AuditResult) : undefined,
    from: num('from'),
    to: num('to'),
    q: (u.searchParams.get('q') ?? '').slice(0, 64) || undefined,
    limit: Math.min(num('limit') ?? 200, 1000),
    offset: num('offset') ?? 0,
  });
  const out = rows.map((r) => {
    let detail: Record<string, unknown> = {};
    try {
      detail = r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {};
    } catch {
      detail = {};
    }
    return {
      id: r.id,
      ts: r.ts,
      time: formatLocal(r.ts, true),
      event: r.event,
      result: r.result,
      actor: r.actor,
      device: actorName(r.actor),
      ip: r.ip,
      country: r.country,
      rule: (detail.rule as string | undefined) ?? null,
      detail,
    };
  });
  if (u.searchParams.get('format') === 'csv') {
    const header = ['id', 'time', 'event', 'result', 'device', 'ip', 'country', 'rule', 'detail'];
    const lines = [header.join(',')].concat(
      out.map((r) => [r.id, r.time, r.event, r.result, r.device, r.ip, r.country, r.rule, JSON.stringify(r.detail)].map(csvCell).join(',')),
    );
    return new Response(lines.join('\r\n') + '\r\n', {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="vesper-audit.csv"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  return json({ view, rows: out });
}

// GET /api/config — static settings the PWA needs.
export async function handleConfig(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx, { approved: false });
  if (a instanceof Response) return a;
  return json({
    ticket_types: TICKET_TYPES,
    vapid_public_key: ctx.env.vapid?.publicKey ?? null,
    max_raw_input_chars: CONFIG.maxRawInputChars,
    daily_ticket_cap: CONFIG.dailyTicketCap,
    server_time: a.now,
  });
}

// GET /api/alerts — the last 7 days.
export async function handleAlerts(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  const alerts = await recentAlerts(ctx, a.now - 7 * 24 * 3600_000);
  return json({ alerts, system_state: a.state });
}

// POST /api/secrets/rotate  { totp, recovery_key?, break_glass_key?, kill_token? }
// Replaces any of the three user secrets (e.g. after the recovery key was used).
export async function handleSecretsRotate(req: Request, ctx: AppContext): Promise<Response> {
  const a = await authDevice(req, ctx);
  if (a instanceof Response) return a;
  const body = parseJson(a.body) as Record<string, unknown> | undefined;
  const owner = await getOwner(ctx);
  if (!body || !owner) return fail('bad_request');
  if (!(await checkTotp(ctx, owner, String(body.totp ?? '')))) {
    await recordAuthFailure(ctx, { ip: a.ip, country: a.country, event: 'auth.fail.totp', actor: `device:${a.device.id}`, detail: { step: 'rotate' } });
    return fail('unauthorized');
  }
  const kinds = [
    ['recovery', 'recovery_key'],
    ['break_glass', 'break_glass_key'],
    ['kill_token', 'kill_token'],
  ] as const;
  const stmts = [];
  const rotated: string[] = [];
  for (const [kind, field] of kinds) {
    if (body[field] === undefined) continue;
    const v = normalizeUserSecret(body[field]);
    if (!v) return fail('bad_request');
    stmts.push(await upsertSecretStatement(ctx, kind, v));
    rotated.push(kind);
  }
  if (!stmts.length) return fail('bad_request');
  stmts.push(auditStatement(ctx, { event: 'secrets.rotate', actor: `device:${a.device.id}`, result: 'ok', ip: a.ip, detail: { kinds: rotated } }));
  await ctx.db.batch(stmts);
  return json({ ok: true, rotated });
}

/** For tests/diagnostics: whether a secret kind exists and is unused. */
export async function secretUsable(ctx: AppContext, kind: 'recovery' | 'break_glass' | 'kill_token'): Promise<boolean> {
  const r = await first<{ used_at: unknown }>(ctx.db, 'SELECT used_at FROM secrets_meta WHERE kind = ?', [kind]);
  return !!r && r.used_at === null;
}
