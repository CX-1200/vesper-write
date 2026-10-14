// §14 audit log: append-only, metadata only. `detail` accepts only short
// primitive values (and lists of short strings) so request bodies, ticket
// content or secrets cannot end up here by accident.

import { all, first, type Param, type Statement } from './db/types.ts';
import { insert, num } from './sql.ts';
import type { AppContext } from './context.ts';

export type AuditResult = 'ok' | 'fail' | 'info';

export type DetailValue = string | number | boolean | null | string[];

export interface AuditEntry {
  event: string;
  actor: string;
  result: AuditResult;
  ip?: string | null;
  country?: string | null;
  detail?: Record<string, DetailValue>;
}

const EVENT_RE = /^[a-z0-9_.]{1,64}$/;

function sanitizeDetail(detail: Record<string, DetailValue> | undefined): string | null {
  if (!detail) return null;
  const out: Record<string, DetailValue> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (!/^[a-z0-9_]{1,32}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 120);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((s) => String(s).slice(0, 40));
  }
  return JSON.stringify(out);
}

export function auditStatement(ctx: AppContext, e: AuditEntry): Statement {
  if (!EVENT_RE.test(e.event)) throw new Error(`bad audit event name ${e.event}`);
  return insert('audit_log', {
    ts: ctx.now(),
    event: e.event,
    actor: e.actor.slice(0, 80),
    ip: e.ip ?? null,
    country: e.country ?? null,
    result: e.result,
    detail: sanitizeDetail(e.detail),
  });
}

export async function audit(ctx: AppContext, e: AuditEntry): Promise<void> {
  await ctx.db.batch([auditStatement(ctx, e)]);
}

export async function countAuthFailures(ctx: AppContext, ip: string, sinceMs: number): Promise<number> {
  const row = await first<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM audit_log WHERE ip = ? AND ts >= ? AND result = 'fail' AND event LIKE 'auth.fail.%'", [
    ip,
    sinceMs,
  ]);
  return row ? num(row.n) : 0;
}

export interface AuditRow {
  id: number;
  ts: number;
  event: string;
  actor: string;
  ip: string | null;
  country: string | null;
  result: AuditResult;
  detail: string | null;
}

export interface AuditQuery {
  event?: string;
  result?: AuditResult;
  from?: number;
  to?: number;
  q?: string;
  limit: number;
  offset?: number;
}

export async function queryAudit(ctx: AppContext, q: AuditQuery): Promise<AuditRow[]> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.event) {
    where.push("event LIKE ? ESCAPE '\\'");
    params.push(q.event.replace(/[\\%_]/g, (c) => `\\${c}`) + '%');
  }
  if (q.result) {
    where.push('result = ?');
    params.push(q.result);
  }
  if (q.from !== undefined) {
    where.push('ts >= ?');
    params.push(q.from);
  }
  if (q.to !== undefined) {
    where.push('ts <= ?');
    params.push(q.to);
  }
  if (q.q) {
    const like = '%' + q.q.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
    where.push("(event LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  params.push(q.limit, q.offset ?? 0);
  const sql = `SELECT id, ts, event, actor, ip, country, result, detail FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT CAST(? AS INTEGER) OFFSET CAST(? AS INTEGER)`;
  return all<AuditRow>(ctx.db, sql, params);
}
