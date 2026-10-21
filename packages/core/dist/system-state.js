// §6.2 system state machine and §6.3 worker/latch decision, as pure functions.
//
//  NORMAL ──(R4/R5/R6)──▶ SUSPICIOUS
//  SUSPICIOUS ──(confirmation from ANOTHER registered device, or recovery key)──▶ NORMAL
//  SUSPICIOUS ──(now − since > T)──▶ LOCKDOWN
//  any ──(R7: invalid VM signature on a worker request)──▶ LOCKDOWN
//  any ──(kill switch)──▶ KILLED
//  LOCKDOWN / KILLED ──(VM-signed unlock + break-glass key)──▶ NORMAL
import { CONFIG } from "./config.js";
export const SYSTEM_STATES = ['NORMAL', 'SUSPICIOUS', 'LOCKDOWN', 'KILLED'];
export function initialSystemState(now) {
    return { state: 'NORMAL', since: now, trigger_rule: null, suspicious_device_id: null };
}
export function isLocked(s) {
    return s === 'LOCKDOWN' || s === 'KILLED';
}
/** Lazy escalation, run at the start of every request (including each worker pull). */
export function tickSystem(s, now, timeoutMs = CONFIG.lockdownTimeoutMs) {
    if (s.state === 'SUSPICIOUS' && now - s.since > timeoutMs) {
        return { state: 'LOCKDOWN', since: now, trigger_rule: 'timeout', suspicious_device_id: s.suspicious_device_id };
    }
    return s;
}
export function applySystemEvent(s0, ev, timeoutMs = CONFIG.lockdownTimeoutMs) {
    const s = tickSystem(s0, ev.now, timeoutMs);
    const changed = (n) => JSON.stringify(n) !== JSON.stringify(s0);
    const ok = (n) => ({ ok: true, state: n, changed: changed(n) });
    const fail = (error) => ({ ok: false, error, state: s });
    switch (ev.type) {
        case 'tick':
            return ok(s);
        case 'suspicious':
            // Only NORMAL escalates; an existing SUSPICIOUS keeps its original `since`
            // so repeated triggers cannot postpone the LOCKDOWN deadline.
            if (s.state !== 'NORMAL')
                return ok(s);
            return ok({ state: 'SUSPICIOUS', since: ev.now, trigger_rule: ev.rule, suspicious_device_id: ev.deviceId });
        case 'confirm_me':
            if (s.state !== 'SUSPICIOUS')
                return fail(isLocked(s.state) ? 'locked' : 'not_suspicious');
            if (s.suspicious_device_id !== null && ev.byDeviceId === s.suspicious_device_id)
                return fail('suspicious_device_cannot_confirm');
            return ok({ state: 'NORMAL', since: ev.now, trigger_rule: null, suspicious_device_id: null });
        case 'recovery_key':
            if (s.state !== 'SUSPICIOUS')
                return fail(isLocked(s.state) ? 'locked' : 'not_suspicious');
            return ok({ state: 'NORMAL', since: ev.now, trigger_rule: null, suspicious_device_id: null });
        case 'vm_sig_invalid':
            return ok({ state: 'LOCKDOWN', since: ev.now, trigger_rule: 'R7', suspicious_device_id: null });
        case 'kill':
            return ok({ state: 'KILLED', since: ev.now, trigger_rule: 'kill_switch', suspicious_device_id: null });
        case 'unlock':
            if (!isLocked(s.state))
                return fail('not_locked');
            if (!ev.vmSignatureValid)
                return fail('vm_signature_invalid');
            if (!ev.breakGlassValid)
                return fail('break_glass_invalid');
            return ok({ state: 'NORMAL', since: ev.now, trigger_rule: null, suspicious_device_id: null });
    }
}
/**
 * What the worker may do after a pull.
 * - LOCKDOWN/KILLED from the server → write the latch and stop.
 * - A local latch always wins: even if the server says NORMAL, do not process.
 * - Only NORMAL allows processing (the server also hands out tickets only in NORMAL).
 */
export function workerDecision(latchExists, serverState) {
    if (serverState !== null && isLocked(serverState))
        return 'latch_and_stop';
    if (latchExists)
        return 'heartbeat_only';
    if (serverState === 'NORMAL')
        return 'process';
    return 'heartbeat_only';
}
