import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTicketEvent, newTicketState, tick, type TicketState, type TicketConfig } from '@vesper/core/ticket-state';
import { applySystemEvent, initialSystemState, tickSystem, workerDecision, type SystemState } from '@vesper/core/system-state';
import { CONFIG } from '@vesper/core/config';

const T0 = 1_760_400_000_000;
const cfg: TicketConfig = { leaseMs: 5 * 60_000, maxAttempts: 3, reviewWindowMs: 12 * 3600_000, staleAfterMs: 72 * 3600_000 };

function mustOk(r: ReturnType<typeof applyTicketEvent>): TicketState {
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  return r.ticket;
}

// ---------------------------------------------------------------------------
// Ticket (§6.1)
// ---------------------------------------------------------------------------

test('ticket: config defaults follow the spec and the user decisions', () => {
  assert.equal(CONFIG.staleAfterMs, 72 * 3600_000); // OD7
  assert.equal(CONFIG.reviewWindowMs, 12 * 3600_000);
  assert.equal(CONFIG.maxAttempts, 3);
  assert.equal(CONFIG.leaseMs, 5 * 60_000);
  assert.equal(CONFIG.dailyTicketCap, 50); // OD6
  assert.equal(CONFIG.lockdownTimeoutMs, 20 * 60_000); // OD3
});

test('ticket: happy path pending → processing → awaiting_review → used', () => {
  let t = newTicketState(T0, cfg);
  assert.equal(t.status, 'pending');
  assert.equal(t.stale_at, T0 + cfg.staleAfterMs);
  t = mustOk(applyTicketEvent(t, { type: 'claim', now: T0 + 1000 }, cfg));
  assert.equal(t.status, 'processing');
  assert.equal(t.attempts, 1);
  assert.equal(t.lease_until, T0 + 1000 + cfg.leaseMs);
  t = mustOk(applyTicketEvent(t, { type: 'result_ok', now: T0 + 2000, processedAt: T0 + 1900 }, cfg));
  assert.equal(t.status, 'awaiting_review');
  assert.equal(t.expires_at, T0 + 2000 + cfg.reviewWindowMs);
  assert.equal(t.processed_at, T0 + 1900);
  t = mustOk(applyTicketEvent(t, { type: 'mark_used', now: T0 + 3000 }, cfg));
  assert.equal(t.status, 'used');
});

test('ticket: awaiting_review → rejected', () => {
  let t = newTicketState(T0, cfg);
  t = mustOk(applyTicketEvent(t, { type: 'claim', now: T0 }, cfg));
  t = mustOk(applyTicketEvent(t, { type: 'result_ok', now: T0, processedAt: T0 }, cfg));
  t = mustOk(applyTicketEvent(t, { type: 'reject', now: T0 + 1 }, cfg));
  assert.equal(t.status, 'rejected');
});

test('ticket: awaiting_review → expired after 12 h, and then cannot be used or rejected', () => {
  let t = newTicketState(T0, cfg);
  t = mustOk(applyTicketEvent(t, { type: 'claim', now: T0 }, cfg));
  t = mustOk(applyTicketEvent(t, { type: 'result_ok', now: T0, processedAt: T0 }, cfg));
  assert.equal(tick(t, T0 + cfg.reviewWindowMs, cfg).status, 'awaiting_review'); // boundary: not yet
  assert.equal(tick(t, T0 + cfg.reviewWindowMs + 1, cfg).status, 'expired');
  const used = applyTicketEvent(t, { type: 'mark_used', now: T0 + cfg.reviewWindowMs + 1 }, cfg);
  assert.equal(used.ok, false);
  assert.equal(!used.ok && used.error, 'expired');
  assert.equal(used.ticket.status, 'expired');
  const rej = applyTicketEvent(t, { type: 'reject', now: T0 + cfg.reviewWindowMs + 1 }, cfg);
  assert.equal(rej.ok, false);
});

test('ticket: lease expiry returns the ticket to pending (lazy)', () => {
  let t = newTicketState(T0, cfg);
  t = mustOk(applyTicketEvent(t, { type: 'claim', now: T0 }, cfg));
  assert.equal(tick(t, T0 + cfg.leaseMs, cfg).status, 'processing');
  const back = tick(t, T0 + cfg.leaseMs + 1, cfg);
  assert.equal(back.status, 'pending');
  assert.equal(back.lease_until, null);
  assert.equal(back.attempts, 1);
});

test('ticket: third failed attempt → failed (worker-reported and lease timeout)', () => {
  let t = newTicketState(T0, cfg);
  for (let i = 1; i <= 2; i++) {
    t = mustOk(applyTicketEvent(t, { type: 'claim', now: T0 + i }, cfg));
    t = mustOk(applyTicketEvent(t, { type: 'result_fail', now: T0 + i, errorCode: 'claude_timeout' }, cfg));
    assert.equal(t.status, 'pending');
    assert.equal(t.attempts, i);
  }
  const third = mustOk(applyTicketEvent(t, { type: 'claim', now: T0 + 10 }, cfg));
  assert.equal(third.attempts, 3);
  const failed = mustOk(applyTicketEvent(third, { type: 'result_fail', now: T0 + 11, errorCode: 'claude_error' }, cfg));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'claude_error');
  // same via lease timeout
  const timedOut = tick(third, T0 + 10 + cfg.leaseMs + 1, cfg);
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.error_code, 'lease_timeout');
});

test('ticket: pending → stale after OD7; processing is not stale until it falls back to pending', () => {
  const t = newTicketState(T0, cfg);
  assert.equal(tick(t, T0 + cfg.staleAfterMs, cfg).status, 'pending');
  assert.equal(tick(t, T0 + cfg.staleAfterMs + 1, cfg).status, 'stale');
  const claimed = mustOk(applyTicketEvent(t, { type: 'claim', now: T0 + cfg.staleAfterMs - 10 }, cfg));
  assert.equal(tick(claimed, T0 + cfg.staleAfterMs + 1, cfg).status, 'processing');
  // lease expires after the stale deadline → pending → stale in the same tick
  assert.equal(tick(claimed, T0 + cfg.staleAfterMs - 10 + cfg.leaseMs + 1, cfg).status, 'stale');
  const r = applyTicketEvent(t, { type: 'claim', now: T0 + cfg.staleAfterMs + 1 }, cfg);
  assert.equal(r.ok, false);
});

test('ticket: the VM rejecting a ticket (R8) fails it at once, from pending or processing only', () => {
  const pending = newTicketState(T0, cfg);
  const fromPending = mustOk(applyTicketEvent(pending, { type: 'vm_rejected', now: T0 + 1, errorCode: 'vm_rejected' }, cfg));
  assert.equal(fromPending.status, 'failed');
  assert.equal(fromPending.error_code, 'vm_rejected');
  const processing = mustOk(applyTicketEvent(pending, { type: 'claim', now: T0 + 1 }, cfg));
  const fromProcessing = mustOk(applyTicketEvent(processing, { type: 'vm_rejected', now: T0 + 2, errorCode: 'vm_rejected' }, cfg));
  assert.deepEqual([fromProcessing.status, fromProcessing.lease_until], ['failed', null]);
  // it can never be claimed again
  assert.equal(applyTicketEvent(fromProcessing, { type: 'claim', now: T0 + 3 }, cfg).ok, false);
  // a ticket that already has a result is not affected
  const done = mustOk(applyTicketEvent(processing, { type: 'result_ok', now: T0 + 2, processedAt: T0 + 2 }, cfg));
  const r = applyTicketEvent(done, { type: 'vm_rejected', now: T0 + 3, errorCode: 'vm_rejected' }, cfg);
  assert.equal(r.ok, false);
});

test('ticket: freeze / unfreeze (SUSPICIOUS) and frozen tickets are not claimable', () => {
  const t = newTicketState(T0, cfg);
  const frozen = mustOk(applyTicketEvent(t, { type: 'freeze', now: T0 + 1 }, cfg));
  assert.equal(frozen.status, 'frozen');
  assert.equal(applyTicketEvent(frozen, { type: 'claim', now: T0 + 2 }, cfg).ok, false);
  assert.equal(tick(frozen, T0 + cfg.staleAfterMs + 1, cfg).status, 'frozen');
  assert.equal(mustOk(applyTicketEvent(frozen, { type: 'unfreeze', now: T0 + 3 }, cfg)).status, 'pending');
  assert.equal(mustOk(applyTicketEvent(frozen, { type: 'unfreeze', now: T0 + cfg.staleAfterMs + 1 }, cfg)).status, 'stale');
});

test('ticket: illegal transitions are rejected', () => {
  const pending = newTicketState(T0, cfg);
  for (const ev of ['result_ok', 'result_fail', 'mark_used', 'reject', 'unfreeze'] as const) {
    const r = applyTicketEvent(pending, { type: ev, now: T0, processedAt: T0, errorCode: 'x' } as never, cfg);
    assert.equal(r.ok, false, ev);
  }
  const used = { ...pending, status: 'used' as const };
  for (const ev of ['claim', 'mark_used', 'reject', 'freeze', 'result_ok'] as const) {
    assert.equal(applyTicketEvent(used, { type: ev, now: T0, processedAt: T0 } as never, cfg).ok, false, ev);
  }
  const processing = mustOk(applyTicketEvent(pending, { type: 'claim', now: T0 }, cfg));
  assert.equal(applyTicketEvent(processing, { type: 'claim', now: T0 + 1 }, cfg).ok, false);
  assert.equal(applyTicketEvent(processing, { type: 'mark_used', now: T0 + 1 }, cfg).ok, false);
  // a result arriving after the lease ran out is rejected (ticket went back to pending)
  assert.equal(applyTicketEvent(processing, { type: 'result_ok', now: T0 + cfg.leaseMs + 1, processedAt: T0 }, cfg).ok, false);
});

// ---------------------------------------------------------------------------
// System (§6.2)
// ---------------------------------------------------------------------------

const TIMEOUT = 20 * 60_000;

function sys(state: SystemState['state'], extra: Partial<SystemState> = {}): SystemState {
  return { state, since: T0, trigger_rule: null, suspicious_device_id: null, ...extra };
}

test('system: NORMAL → SUSPICIOUS on R4/R5/R6', () => {
  for (const rule of ['R4', 'R5', 'R6'] as const) {
    const r = applySystemEvent(initialSystemState(T0), { type: 'suspicious', now: T0 + 1, rule, deviceId: 'dev-a' }, TIMEOUT);
    assert.equal(r.ok, true);
    assert.deepEqual(r.state, { state: 'SUSPICIOUS', since: T0 + 1, trigger_rule: rule, suspicious_device_id: 'dev-a' });
  }
});

test('system: repeated triggers do not postpone the LOCKDOWN deadline', () => {
  const s = sys('SUSPICIOUS', { since: T0, trigger_rule: 'R6', suspicious_device_id: 'dev-a' });
  const r = applySystemEvent(s, { type: 'suspicious', now: T0 + 60_000, rule: 'R4', deviceId: 'dev-b' }, TIMEOUT);
  assert.equal(r.state.since, T0);
  assert.equal(r.state.suspicious_device_id, 'dev-a');
});

test('system: SUSPICIOUS → NORMAL when ANOTHER device confirms', () => {
  const s = sys('SUSPICIOUS', { suspicious_device_id: 'dev-a', trigger_rule: 'R6' });
  const r = applySystemEvent(s, { type: 'confirm_me', now: T0 + 1000, byDeviceId: 'dev-b' }, TIMEOUT);
  assert.equal(r.ok, true);
  assert.equal(r.state.state, 'NORMAL');
});

test('system: the suspicious device cannot confirm itself (must fail)', () => {
  const s = sys('SUSPICIOUS', { suspicious_device_id: 'dev-a', trigger_rule: 'R6' });
  const r = applySystemEvent(s, { type: 'confirm_me', now: T0 + 1000, byDeviceId: 'dev-a' }, TIMEOUT);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, 'suspicious_device_cannot_confirm');
  assert.equal(r.state.state, 'SUSPICIOUS');
});

test('system: SUSPICIOUS → NORMAL with the recovery key', () => {
  const r = applySystemEvent(sys('SUSPICIOUS', { suspicious_device_id: 'dev-a' }), { type: 'recovery_key', now: T0 + 1 }, TIMEOUT);
  assert.equal(r.ok, true);
  assert.equal(r.state.state, 'NORMAL');
});

test('system: SUSPICIOUS → LOCKDOWN lazily after T; confirming afterwards fails', () => {
  const s = sys('SUSPICIOUS', { suspicious_device_id: 'dev-a' });
  assert.equal(tickSystem(s, T0 + TIMEOUT, TIMEOUT).state, 'SUSPICIOUS');
  const locked = tickSystem(s, T0 + TIMEOUT + 1, TIMEOUT);
  assert.equal(locked.state, 'LOCKDOWN');
  assert.equal(locked.trigger_rule, 'timeout');
  const late = applySystemEvent(s, { type: 'confirm_me', now: T0 + TIMEOUT + 1, byDeviceId: 'dev-b' }, TIMEOUT);
  assert.equal(late.ok, false);
  assert.equal(late.state.state, 'LOCKDOWN');
  const lateKey = applySystemEvent(s, { type: 'recovery_key', now: T0 + TIMEOUT + 1 }, TIMEOUT);
  assert.equal(lateKey.ok, false);
});

test('system: R7 (invalid VM signature) → LOCKDOWN from any state', () => {
  for (const st of ['NORMAL', 'SUSPICIOUS', 'LOCKDOWN', 'KILLED'] as const) {
    const r = applySystemEvent(sys(st), { type: 'vm_sig_invalid', now: T0 + 5 }, TIMEOUT);
    assert.equal(r.state.state, 'LOCKDOWN', st);
    assert.equal(r.state.trigger_rule, 'R7');
  }
});

test('system: kill switch → KILLED from any state', () => {
  for (const st of ['NORMAL', 'SUSPICIOUS', 'LOCKDOWN', 'KILLED'] as const) {
    const r = applySystemEvent(sys(st), { type: 'kill', now: T0 + 5 }, TIMEOUT);
    assert.equal(r.state.state, 'KILLED', st);
  }
});

test('system: unlock needs BOTH a valid VM signature and the break-glass key', () => {
  for (const st of ['LOCKDOWN', 'KILLED'] as const) {
    assert.equal(applySystemEvent(sys(st), { type: 'unlock', now: T0, vmSignatureValid: true, breakGlassValid: false }, TIMEOUT).ok, false);
    assert.equal(applySystemEvent(sys(st), { type: 'unlock', now: T0, vmSignatureValid: false, breakGlassValid: true }, TIMEOUT).ok, false);
    const r = applySystemEvent(sys(st), { type: 'unlock', now: T0, vmSignatureValid: true, breakGlassValid: true }, TIMEOUT);
    assert.equal(r.ok, true);
    assert.equal(r.state.state, 'NORMAL');
  }
  assert.equal(applySystemEvent(sys('NORMAL'), { type: 'unlock', now: T0, vmSignatureValid: true, breakGlassValid: true }, TIMEOUT).ok, false);
});

test('system: confirm / recovery are meaningless outside SUSPICIOUS', () => {
  for (const st of ['NORMAL', 'LOCKDOWN', 'KILLED'] as const) {
    assert.equal(applySystemEvent(sys(st), { type: 'confirm_me', now: T0, byDeviceId: 'x' }, TIMEOUT).ok, false);
    assert.equal(applySystemEvent(sys(st), { type: 'recovery_key', now: T0 }, TIMEOUT).ok, false);
  }
  // LOCKDOWN/KILLED do not drop back to SUSPICIOUS
  assert.equal(applySystemEvent(sys('LOCKDOWN'), { type: 'suspicious', now: T0, rule: 'R6', deviceId: null }, TIMEOUT).state.state, 'LOCKDOWN');
});

// ---------------------------------------------------------------------------
// Worker / latch (§6.3)
// ---------------------------------------------------------------------------

test('worker: processes only when NORMAL and no local latch', () => {
  assert.equal(workerDecision(false, 'NORMAL'), 'process');
  assert.equal(workerDecision(false, 'SUSPICIOUS'), 'heartbeat_only');
  assert.equal(workerDecision(false, null), 'heartbeat_only');
});

test('worker: local latch wins even if Vercel reports NORMAL', () => {
  assert.equal(workerDecision(true, 'NORMAL'), 'heartbeat_only');
  assert.equal(workerDecision(true, null), 'heartbeat_only');
});

test('worker: LOCKDOWN or KILLED from the server → latch and stop', () => {
  assert.equal(workerDecision(false, 'LOCKDOWN'), 'latch_and_stop');
  assert.equal(workerDecision(false, 'KILLED'), 'latch_and_stop');
  assert.equal(workerDecision(true, 'KILLED'), 'latch_and_stop');
});
