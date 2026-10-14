// §6.2 system state persistence. The pure transition logic lives in
// @vesper/core/system-state; this file loads/saves the single row with
// optimistic concurrency and performs the side effects of each state.

import { applySystemEvent, isLocked, tickSystem, type SystemEvent, type SystemState, type SystemStateName } from '@vesper/core/system-state';
import { CONFIG } from '@vesper/core/config';
import { first } from './db/types.ts';
import { auditStatement } from './audit.ts';
import { notify } from './notify.ts';
import { num, strOrNull } from './sql.ts';
import type { AppContext } from './context.ts';
import type { Statement } from './db/types.ts';

interface Row {
  state: SystemStateName;
  since: number;
  trigger_rule: string | null;
  suspicious_device_id: string | null;
  version: number;
}

async function loadRow(ctx: AppContext): Promise<SystemState & { version: number }> {
  const r = await first<Row>(ctx.db, 'SELECT state, since, trigger_rule, suspicious_device_id, version FROM system_state WHERE id = 1');
  if (!r) return { state: 'NORMAL', since: 0, trigger_rule: null, suspicious_device_id: null, version: 0 };
  return {
    state: r.state,
    since: num(r.since),
    trigger_rule: strOrNull(r.trigger_rule),
    suspicious_device_id: strOrNull(r.suspicious_device_id),
    version: num(r.version),
  };
}

/** Statements that apply the side effects of entering `next` (from `prev`). */
function sideEffects(ctx: AppContext, prev: SystemState, next: SystemState): Statement[] {
  const stmts: Statement[] = [];
  if (isLocked(next.state) && !isLocked(prev.state)) {
    // LOCKDOWN / KILLED: revoke every session (§6.2).
    stmts.push({ sql: 'DELETE FROM sessions' });
  }
  if (next.state === 'SUSPICIOUS' && prev.state !== 'SUSPICIOUS' && next.suspicious_device_id) {
    // Freeze the suspicious device's sessions and its pending tickets (v2 triggers use this).
    stmts.push({ sql: 'UPDATE sessions SET frozen = 1 WHERE device_id = ?', params: [next.suspicious_device_id] });
    stmts.push({ sql: "UPDATE tickets SET status = 'frozen' WHERE device_id = ? AND status = 'pending'", params: [next.suspicious_device_id] });
  }
  if (prev.state === 'SUSPICIOUS' && next.state === 'NORMAL' && prev.suspicious_device_id) {
    stmts.push({ sql: 'UPDATE sessions SET frozen = 0 WHERE device_id = ?', params: [prev.suspicious_device_id] });
    stmts.push({ sql: "UPDATE tickets SET status = 'pending' WHERE device_id = ? AND status = 'frozen'", params: [prev.suspicious_device_id] });
  }
  stmts.push(
    auditStatement(ctx, {
      event: 'system.state',
      actor: 'system',
      result: 'info',
      detail: { from: prev.state, to: next.state, trigger: next.trigger_rule },
    }),
  );
  return stmts;
}

/**
 * Write `next` if the row is still at `version`. Returns false if someone else
 * changed the state in the meantime (caller re-reads and retries).
 */
async function save(ctx: AppContext, prev: SystemState & { version: number }, next: SystemState): Promise<boolean> {
  const set = [
    `state = ?`,
    `since = CAST(? AS INTEGER)`,
    next.trigger_rule === null ? 'trigger_rule = NULL' : 'trigger_rule = ?',
    next.suspicious_device_id === null ? 'suspicious_device_id = NULL' : 'suspicious_device_id = ?',
    'version = version + 1',
  ];
  const params: (string | number)[] = [next.state, next.since];
  if (next.trigger_rule !== null) params.push(next.trigger_rule);
  if (next.suspicious_device_id !== null) params.push(next.suspicious_device_id);
  params.push(prev.version);
  const [upd] = await ctx.db.batch([{ sql: `UPDATE system_state SET ${set.join(', ')} WHERE id = 1 AND version = CAST(? AS INTEGER)`, params }]);
  if (!upd || upd.changes !== 1) return false;
  await ctx.db.batch(sideEffects(ctx, prev, next));
  if (isLocked(next.state) && !isLocked(prev.state)) notify(ctx, 'locked', 1, { kind: 'approved_devices' });
  return true;
}

/** Current state, after lazy escalation (SUSPICIOUS → LOCKDOWN after T). */
export async function currentSystemState(ctx: AppContext): Promise<SystemState> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await loadRow(ctx);
    const ticked = tickSystem(cur, ctx.now(), CONFIG.lockdownTimeoutMs);
    if (ticked === cur || JSON.stringify(ticked) === JSON.stringify(stripVersion(cur))) return stripVersion(cur);
    if (await save(ctx, cur, ticked)) return ticked;
  }
  return stripVersion(await loadRow(ctx));
}

function stripVersion(s: SystemState & { version?: number }): SystemState {
  return { state: s.state, since: s.since, trigger_rule: s.trigger_rule, suspicious_device_id: s.suspicious_device_id };
}

/** Apply an event (kill, R7, …). Persists the lazily escalated state even when the event itself is refused. */
export async function applySystem(ctx: AppContext, ev: SystemEvent): Promise<{ ok: boolean; error?: string; state: SystemState }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await loadRow(ctx);
    const r = applySystemEvent(cur, ev, CONFIG.lockdownTimeoutMs);
    const target = r.state;
    const changed = JSON.stringify(target) !== JSON.stringify(stripVersion(cur));
    if (changed && !(await save(ctx, cur, target))) continue;
    return r.ok ? { ok: true, state: target } : { ok: false, error: r.error, state: target };
  }
  return { ok: false, error: 'conflict', state: stripVersion(await loadRow(ctx)) };
}
