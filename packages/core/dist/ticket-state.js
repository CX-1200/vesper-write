// §6.1 ticket state machine as pure functions. The web layer runs the same
// transitions in SQL (single atomic statements); tests check both agree.
//
//  pending ──▶ processing ──▶ awaiting_review ──▶ used
//     │   ▲         │                │
//     │   └─(lease expired)          ├──▶ rejected
//     │             │                └──▶ expired (now > expires_at)
//     │             └──▶ failed (attempts ≥ 3, or the VM rejected it: R8)
//     ├──▶ stale (now > stale_at while still pending)
//     └──▶ frozen (system not NORMAL; v2)
import { CONFIG } from "./config.js";
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
];
export const TERMINAL_STATUSES = new Set(['used', 'rejected', 'expired', 'failed', 'stale']);
const DEFAULTS = {
    leaseMs: CONFIG.leaseMs,
    maxAttempts: CONFIG.maxAttempts,
    reviewWindowMs: CONFIG.reviewWindowMs,
    staleAfterMs: CONFIG.staleAfterMs,
};
export function newTicketState(now, cfg = DEFAULTS) {
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
export function tick(t, now, cfg = DEFAULTS) {
    let s = t;
    if (s.status === 'processing' && s.lease_until !== null && now > s.lease_until) {
        s =
            s.attempts >= cfg.maxAttempts
                ? { ...s, status: 'failed', lease_until: null, error_code: 'lease_timeout' }
                : { ...s, status: 'pending', lease_until: null };
    }
    if (s.status === 'pending' && now > s.stale_at)
        s = { ...s, status: 'stale' };
    if (s.status === 'awaiting_review' && s.expires_at !== null && now > s.expires_at)
        s = { ...s, status: 'expired' };
    return s;
}
export function applyTicketEvent(t, ev, cfg = DEFAULTS) {
    const before = t;
    const s = tick(t, ev.now, cfg);
    const fail = (error) => ({ ok: false, error, ticket: s });
    const ok = (ticket) => ({ ok: true, ticket, changed: JSON.stringify(ticket) !== JSON.stringify(before) });
    switch (ev.type) {
        case 'tick':
            return ok(s);
        case 'claim':
            if (s.status !== 'pending')
                return fail('not_pending');
            if (s.attempts >= cfg.maxAttempts)
                return fail('max_attempts');
            return ok({ ...s, status: 'processing', lease_until: ev.now + cfg.leaseMs, attempts: s.attempts + 1 });
        case 'result_ok':
            if (s.status !== 'processing')
                return fail('not_processing');
            return ok({
                ...s,
                status: 'awaiting_review',
                lease_until: null,
                processed_at: ev.processedAt,
                expires_at: ev.now + cfg.reviewWindowMs,
                error_code: null,
            });
        case 'result_fail':
            if (s.status !== 'processing')
                return fail('not_processing');
            return ok(s.attempts >= cfg.maxAttempts
                ? { ...s, status: 'failed', lease_until: null, error_code: ev.errorCode }
                : { ...s, status: 'pending', lease_until: null, error_code: ev.errorCode });
        case 'vm_rejected':
            if (s.status !== 'processing' && s.status !== 'pending')
                return fail('not_open');
            return ok({ ...s, status: 'failed', lease_until: null, error_code: ev.errorCode });
        case 'mark_used':
            if (s.status !== 'awaiting_review')
                return fail(s.status === 'expired' ? 'expired' : 'not_awaiting_review');
            return ok({ ...s, status: 'used' });
        case 'reject':
            if (s.status !== 'awaiting_review')
                return fail(s.status === 'expired' ? 'expired' : 'not_awaiting_review');
            return ok({ ...s, status: 'rejected' });
        case 'freeze':
            if (s.status !== 'pending')
                return fail('not_pending');
            return ok({ ...s, status: 'frozen' });
        case 'unfreeze':
            if (s.status !== 'frozen')
                return fail('not_frozen');
            return ok(tick({ ...s, status: 'pending' }, ev.now, cfg));
    }
}
/** Statuses a device can see content for. */
export function hasOutput(status) {
    return status === 'awaiting_review' || status === 'used' || status === 'rejected' || status === 'expired';
}
