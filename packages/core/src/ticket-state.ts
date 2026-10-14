// §6.1 ticket state machine as pure functions. The web layer runs the same
// transitions in SQL (single atomic statements); tests check both agree.
//
//  pending ──▶ processing ──▶ awaiting_review ──▶ used
//     │   ▲         │                │
//     │   └─(lease expired)          ├──▶ rejected
//     │             │                └──▶ expired (now > expires_at)
//     │             └──▶ failed (attempts ≥ 3)
//     ├──▶ stale (now > stale_at while still pending)
//     └──▶ frozen (system not NORMAL; v2)

import { CONFIG } from './config.ts';

export const TICKET_STATUSES = [
  'pending',
  'processing',
  'awaiting_review',
  'used',
  'rejected',
  'expired',
  'failed',
  'stale',
  'frozen',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set(['used', 'rejected', 'expired', 'failed', 'stale']);

export interface TicketState {
  status: TicketStatus;
  created_at: number;
  stale_at: number;
  lease_until: number | null;
  attempts: number;
  processed_at: number | null;
  expires_at: number | null;
  error_code: string | null;
}

export type TicketEvent =
  | { type: 'tick'; now: number }
  | { type: 'claim'; now: number }
  | { type: 'result_ok'; now: number; processedAt: number }
  | { type: 'result_fail'; now: number; errorCode: string }
  | { type: 'mark_used'; now: number }
  | { type: 'reject'; now: number }
  | { type: 'freeze'; now: number }
  | { type: 'unfreeze'; now: number };

export type TransitionResult = { ok: true; ticket: TicketState; changed: boolean } | { ok: false; error: string; ticket: TicketState };

export interface TicketConfig {
  leaseMs: number;
  maxAttempts: number;
  reviewWindowMs: number;
  staleAfterMs: number;
}

const DEFAULTS: TicketConfig = {
  leaseMs: CONFIG.leaseMs,
  maxAttempts: CONFIG.maxAttempts,
  reviewWindowMs: CONFIG.reviewWindowMs,
  staleAfterMs: CONFIG.staleAfterMs,
};

export function newTicketState(now: number, cfg: TicketConfig = DEFAULTS): TicketState {
  return {
    status: 'pending',
    created_at: now,
    stale_at: now + cfg.staleAfterMs,
    lease_until: null,
    attempts: 0,
    processed_at: null,
    expires_at: null,
    error_code: null,
  };
}

/**
 * Lazy time-based transitions (§6.1 "惰性判断"): lease expiry, stale, expired.
 * Applied before every other event so decisions never use outdated state.
 */
export function tick(t: TicketState, now: number, cfg: TicketConfig = DEFAULTS): TicketState {
  let s = t;
  if (s.status === 'processing' && s.lease_until !== null && now > s.lease_until) {
    s =
      s.attempts >= cfg.maxAttempts
        ? { ...s, status: 'failed', lease_until: null, error_code: 'lease_timeout' }
        : { ...s, status: 'pending', lease_until: null };
  }
  if (s.status === 'pending' && now > s.stale_at) s = { ...s, status: 'stale' };
  if (s.status === 'awaiting_review' && s.expires_at !== null && now > s.expires_at) s = { ...s, status: 'expired' };
  return s;
}

export function applyTicketEvent(t: TicketState, ev: TicketEvent, cfg: TicketConfig = DEFAULTS): TransitionResult {
  const before = t;
  const s = tick(t, ev.now, cfg);
  const fail = (error: string): TransitionResult => ({ ok: false, error, ticket: s });
  const ok = (ticket: TicketState): TransitionResult => ({ ok: true, ticket, changed: JSON.stringify(ticket) !== JSON.stringify(before) });

  switch (ev.type) {
    case 'tick':
      return ok(s);
    case 'claim':
      if (s.status !== 'pending') return fail('not_pending');
      if (s.attempts >= cfg.maxAttempts) return fail('max_attempts');
      return ok({ ...s, status: 'processing', lease_until: ev.now + cfg.leaseMs, attempts: s.attempts + 1 });
    case 'result_ok':
      if (s.status !== 'processing') return fail('not_processing');
      return ok({
        ...s,
        status: 'awaiting_review',
        lease_until: null,
        processed_at: ev.processedAt,
        expires_at: ev.now + cfg.reviewWindowMs,
        error_code: null,
      });
    case 'result_fail':
      if (s.status !== 'processing') return fail('not_processing');
      return ok(
        s.attempts >= cfg.maxAttempts
          ? { ...s, status: 'failed', lease_until: null, error_code: ev.errorCode }
          : { ...s, status: 'pending', lease_until: null, error_code: ev.errorCode },
      );
    case 'mark_used':
      if (s.status !== 'awaiting_review') return fail(s.status === 'expired' ? 'expired' : 'not_awaiting_review');
      return ok({ ...s, status: 'used' });
    case 'reject':
      if (s.status !== 'awaiting_review') return fail(s.status === 'expired' ? 'expired' : 'not_awaiting_review');
      return ok({ ...s, status: 'rejected' });
    case 'freeze':
      if (s.status !== 'pending') return fail('not_pending');
      return ok({ ...s, status: 'frozen' });
    case 'unfreeze':
      if (s.status !== 'frozen') return fail('not_frozen');
      return ok(tick({ ...s, status: 'pending' }, ev.now, cfg));
  }
}

/** Statuses a device can see content for. */
export function hasOutput(status: TicketStatus): boolean {
  return status === 'awaiting_review' || status === 'used' || status === 'rejected' || status === 'expired';
}
