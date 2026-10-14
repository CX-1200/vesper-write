// §6.1 ticket persistence. Every transition is a single SQL statement whose
// WHERE clause encodes the allowed "from" states, mirroring the pure state
// machine in @vesper/core/ticket-state (tests check they agree).

import { CONFIG } from '@vesper/core/config';
import { localDayStart } from '@vesper/core/time';
import type { TicketStatus } from '@vesper/core/ticket-state';
import { all, first, type Statement } from './db/types.ts';
import { auditStatement } from './audit.ts';
import { notify } from './notify.ts';
import { num, numOrNull, strOrNull } from './sql.ts';
import type { AppContext } from './context.ts';

export interface TicketMeta {
  id: string;
  type: string;
  target: 'claude_ai' | 'claude_code';
  device_id: string;
  status: TicketStatus;
  attempts: number;
  created_at: number;
  processed_at: number | null;
  reviewed_at: number | null;
  used_at: number | null;
  expires_at: number | null;
  stale_at: number;
  error_code: string | null;
}

const META_COLS = 'id, type, target, device_id, status, attempts, created_at, processed_at, reviewed_at, used_at, expires_at, stale_at, error_code';

export function normalizeMeta(r: Record<string, unknown>): TicketMeta {
  return {
    id: String(r.id),
    type: String(r.type),
    target: r.target as TicketMeta['target'],
    device_id: String(r.device_id),
    status: r.status as TicketStatus,
    attempts: num(r.attempts),
    created_at: num(r.created_at),
    processed_at: numOrNull(r.processed_at),
    reviewed_at: numOrNull(r.reviewed_at),
    used_at: numOrNull(r.used_at),
    expires_at: numOrNull(r.expires_at),
    stale_at: num(r.stale_at),
    error_code: strOrNull(r.error_code),
  };
}

/**
 * Lazy maintenance (§6.1 "惰性判断"): lease expiry, stale and expired, in the
 * same order as the pure `tick`. Runs on every list/read and every worker pull.
 */
export async function runMaintenance(ctx: AppContext): Promise<{ expired: number; stale: number; failed: number; requeued: number }> {
  const now = ctx.now();
  const [failed, requeued, stale, expired] = await ctx.db.batch([
    {
      sql: `UPDATE tickets SET status = 'failed', lease_until = NULL, error_code = 'lease_timeout', finished_at = CAST(?1 AS INTEGER)
            WHERE status = 'processing' AND lease_until < CAST(?1 AS INTEGER) AND attempts >= CAST(?2 AS INTEGER) RETURNING id`,
      params: [now, CONFIG.maxAttempts],
    },
    {
      sql: `UPDATE tickets SET status = 'pending', lease_until = NULL
            WHERE status = 'processing' AND lease_until < CAST(?1 AS INTEGER) RETURNING id`,
      params: [now],
    },
    {
      sql: `UPDATE tickets SET status = 'stale', finished_at = CAST(?1 AS INTEGER)
            WHERE status = 'pending' AND stale_at < CAST(?1 AS INTEGER) RETURNING id`,
      params: [now],
    },
    {
      sql: `UPDATE tickets SET status = 'expired', finished_at = CAST(?1 AS INTEGER)
            WHERE status = 'awaiting_review' AND expires_at < CAST(?1 AS INTEGER) RETURNING id`,
      params: [now],
    },
  ]);
  const audits: Statement[] = [];
  const log = (rows: Array<Record<string, unknown>> | undefined, to: TicketStatus, from: TicketStatus) => {
    for (const r of rows ?? []) {
      audits.push(auditStatement(ctx, { event: 'ticket.status', actor: 'system', result: 'info', detail: { ticket: String(r.id), from, to } }));
    }
  };
  log(failed?.rows, 'failed', 'processing');
  log(requeued?.rows, 'pending', 'processing');
  log(stale?.rows, 'stale', 'pending');
  log(expired?.rows, 'expired', 'awaiting_review');
  if (audits.length) await ctx.db.batch(audits);
  const counts = {
    failed: failed?.rows.length ?? 0,
    requeued: requeued?.rows.length ?? 0,
    stale: stale?.rows.length ?? 0,
    expired: expired?.rows.length ?? 0,
  };
  if (counts.expired > 0) notify(ctx, 'expired', counts.expired);
  if (counts.stale > 0) notify(ctx, 'stale', counts.stale);
  return counts;
}

export async function listTickets(ctx: AppContext, limit = 100): Promise<TicketMeta[]> {
  const rows = await all(ctx.db, `SELECT ${META_COLS} FROM tickets ORDER BY created_at DESC LIMIT CAST(? AS INTEGER)`, [limit]);
  return rows.map(normalizeMeta);
}

export interface TicketDetail extends TicketMeta {
  output_envelopes: Record<string, unknown> | null;
  output_sig: string | null;
}

export async function getTicket(ctx: AppContext, id: string): Promise<TicketDetail | null> {
  const r = await first(ctx.db, `SELECT ${META_COLS}, output_envelopes, output_sig FROM tickets WHERE id = ?`, [id]);
  if (!r) return null;
  return {
    ...normalizeMeta(r),
    output_envelopes: r.output_envelopes ? (JSON.parse(String(r.output_envelopes)) as Record<string, unknown>) : null,
    output_sig: strOrNull(r.output_sig),
  };
}

export async function ticketsCreatedToday(ctx: AppContext): Promise<number> {
  const start = localDayStart(ctx.now());
  const r = await first<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ?', [start]);
  return r ? num(r.n) : 0;
}

/** Atomic claim: pending → processing with a lease (§6.1). */
export async function claimTickets(ctx: AppContext, max: number): Promise<Array<Record<string, unknown>>> {
  if (max <= 0) return [];
  const now = ctx.now();
  const [r] = await ctx.db.batch([
    {
      sql: `UPDATE tickets SET status = 'processing', lease_until = CAST(?1 AS INTEGER), attempts = attempts + 1
            WHERE id IN (
              SELECT id FROM tickets
              WHERE status = 'pending' AND attempts < CAST(?2 AS INTEGER) AND stale_at >= CAST(?3 AS INTEGER)
              ORDER BY created_at ASC LIMIT CAST(?4 AS INTEGER)
            )
            RETURNING id, type, target, device_id, input_envelope, input_sig, input_nonce, input_ts, attempts, created_at`,
      params: [now + CONFIG.leaseMs, CONFIG.maxAttempts, now, max],
    },
  ]);
  return r?.rows ?? [];
}

export type FinishResult = 'ok' | 'not_found' | 'wrong_state';

async function transition(ctx: AppContext, id: string, sql: string, params: (string | number)[], audit: Statement): Promise<FinishResult> {
  const [r] = await ctx.db.batch([{ sql, params }]);
  if (r && r.changes === 1) {
    await ctx.db.batch([audit]);
    return 'ok';
  }
  const exists = await first(ctx.db, 'SELECT id FROM tickets WHERE id = ?', [id]);
  return exists ? 'wrong_state' : 'not_found';
}

export async function storeResult(
  ctx: AppContext,
  id: string,
  processedAt: number,
  outputEnvelopesJson: string,
  outputSig: string,
): Promise<FinishResult> {
  const now = ctx.now();
  return transition(
    ctx,
    id,
    `UPDATE tickets SET status = 'awaiting_review', lease_until = NULL, processed_at = CAST(?1 AS INTEGER),
       expires_at = CAST(?2 AS INTEGER), output_envelopes = ?3, output_sig = ?4, error_code = NULL
     WHERE id = ?5 AND status = 'processing' AND lease_until >= CAST(?6 AS INTEGER)`,
    [processedAt, now + CONFIG.reviewWindowMs, outputEnvelopesJson, outputSig, id, now],
    auditStatement(ctx, { event: 'ticket.status', actor: 'vm', result: 'ok', detail: { ticket: id, from: 'processing', to: 'awaiting_review' } }),
  );
}

export async function storeFailure(ctx: AppContext, id: string, errorCode: string): Promise<FinishResult> {
  const now = ctx.now();
  const [r] = await ctx.db.batch([
    {
      sql: `UPDATE tickets SET
              status = CASE WHEN attempts >= CAST(?1 AS INTEGER) THEN 'failed' ELSE 'pending' END,
              finished_at = CASE WHEN attempts >= CAST(?1 AS INTEGER) THEN CAST(?2 AS INTEGER) ELSE finished_at END,
              lease_until = NULL, error_code = ?3
            WHERE id = ?4 AND status = 'processing' AND lease_until >= CAST(?2 AS INTEGER)
            RETURNING status`,
      params: [CONFIG.maxAttempts, now, errorCode, id],
    },
  ]);
  const row = r?.rows[0];
  if (row) {
    await ctx.db.batch([
      auditStatement(ctx, { event: 'ticket.status', actor: 'vm', result: 'fail', detail: { ticket: id, from: 'processing', to: String(row.status), error: errorCode } }),
    ]);
    return 'ok';
  }
  const exists = await first(ctx.db, 'SELECT id FROM tickets WHERE id = ?', [id]);
  return exists ? 'wrong_state' : 'not_found';
}

export async function markReviewOutcome(ctx: AppContext, id: string, outcome: 'used' | 'rejected', actor: string): Promise<FinishResult> {
  const now = ctx.now();
  const extra = outcome === 'used' ? ', used_at = CAST(?1 AS INTEGER)' : '';
  return transition(
    ctx,
    id,
    `UPDATE tickets SET status = '${outcome}', finished_at = CAST(?1 AS INTEGER)${extra},
       reviewed_at = COALESCE(reviewed_at, CAST(?1 AS INTEGER))
     WHERE id = ?2 AND status = 'awaiting_review' AND expires_at >= CAST(?1 AS INTEGER)`,
    [now, id],
    auditStatement(ctx, { event: 'ticket.status', actor, result: 'ok', detail: { ticket: id, from: 'awaiting_review', to: outcome } }),
  );
}

export async function markReviewed(ctx: AppContext, id: string): Promise<void> {
  await ctx.db.batch([{ sql: 'UPDATE tickets SET reviewed_at = CAST(? AS INTEGER) WHERE id = ? AND reviewed_at IS NULL', params: [ctx.now(), id] }]);
}

/** When a device is revoked, its queued tickets must never reach the VM. */
export function failTicketsOfDevice(deviceId: string, now: number): Statement {
  return {
    sql: `UPDATE tickets SET status = 'failed', error_code = 'device_revoked', lease_until = NULL, finished_at = CAST(? AS INTEGER)
          WHERE device_id = ? AND status IN ('pending', 'frozen')`,
    params: [now, deviceId],
  };
}
