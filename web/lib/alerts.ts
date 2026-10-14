// Alerts (§5.1 alerts, §12). Every alert is audited and pushed to ALL
// registered devices with the fixed text "安全警报，请在另一台设备上查看".

import { randomUuid } from '@vesper/core/encoding';
import { all } from './db/types.ts';
import { auditStatement } from './audit.ts';
import { insert } from './sql.ts';
import { notify } from './notify.ts';
import type { AppContext } from './context.ts';

export type AlertRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R7_ip' | 'R8' | 'kill' | 'tamper';

export interface AlertInput {
  rule: AlertRule;
  severity: 'high' | 'medium' | 'low';
  deviceId?: string | null;
  ip?: string | null;
  country?: string | null;
  /** short reason code, never content */
  reason?: string;
  /** default true */
  push?: boolean;
}

export async function raiseAlert(ctx: AppContext, a: AlertInput): Promise<string> {
  const id = randomUuid();
  await ctx.db.batch([
    insert('alerts', {
      id,
      rule: a.rule,
      severity: a.severity,
      device_id: a.deviceId ?? null,
      ip: a.ip ?? null,
      country: a.country ?? null,
      created_at: ctx.now(),
      detail: a.reason ? a.reason.slice(0, 60) : null,
    }),
    auditStatement(ctx, {
      event: 'rule.triggered',
      actor: 'system',
      result: 'info',
      ip: a.ip ?? null,
      country: a.country ?? null,
      detail: { rule: a.rule, reason: a.reason ?? null, device: a.deviceId ?? null },
    }),
  ]);
  if (a.push !== false) notify(ctx, 'alert', 1, { kind: 'approved_devices' });
  return id;
}

export interface AlertRow {
  id: string;
  rule: string;
  severity: string;
  device_id: string | null;
  ip: string | null;
  country: string | null;
  created_at: number;
  detail: string | null;
  resolved_at: number | null;
  resolution: string | null;
}

export async function recentAlerts(ctx: AppContext, sinceMs: number): Promise<AlertRow[]> {
  return all<AlertRow>(
    ctx.db,
    'SELECT id, rule, severity, device_id, ip, country, created_at, detail, resolved_at, resolution FROM alerts WHERE created_at >= ? ORDER BY created_at DESC LIMIT 100',
    [sinceMs],
  );
}
