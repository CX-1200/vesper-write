// Rate limits (fixed one-minute windows) and rule R3:
// ≥ 5 authentication failures from one source within 10 minutes →
// block that source for 15 minutes and raise an alert.

import { CONFIG } from '@vesper/core/config';
import { first, run } from './db/types.ts';
import { audit, countAuthFailures, type DetailValue } from './audit.ts';
import { raiseAlert } from './alerts.ts';
import { num } from './sql.ts';
import type { AppContext } from './context.ts';

export type RateClass = keyof typeof CONFIG.rateLimits;

export async function isBlocked(ctx: AppContext, source: string): Promise<boolean> {
  const row = await first<{ until: number }>(ctx.db, 'SELECT until FROM blocks WHERE source = ?', [source]);
  return row !== null && num(row.until) > ctx.now();
}

/** Returns true when the caller is over its per-minute limit. */
export async function overRateLimit(ctx: AppContext, cls: RateClass, source: string): Promise<boolean> {
  const now = ctx.now();
  const window = Math.floor(now / 60_000) * 60_000;
  const row = await first<{ count: number }>(
    ctx.db,
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, CAST(? AS INTEGER), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
    [`${cls}:${source}`, window],
  );
  // Occasional cleanup of old windows (cheap, keeps the table tiny).
  if (Math.random() < 0.02) await run(ctx.db, 'DELETE FROM rate_limits WHERE window_start < ?', [now - 3_600_000]);
  return row !== null && num(row.count) > CONFIG.rateLimits[cls];
}

export interface AuthFailure {
  ip: string;
  country: string | null;
  /** e.g. "auth.fail.password" — must start with "auth.fail." to count toward R3 */
  event: `auth.fail.${string}`;
  actor: string;
  detail?: Record<string, DetailValue>;
}

/** §7: every failed authentication is audited and counts toward R3. */
export async function recordAuthFailure(ctx: AppContext, f: AuthFailure): Promise<void> {
  await audit(ctx, { event: f.event, actor: f.actor, result: 'fail', ip: f.ip, country: f.country, detail: f.detail });
  const now = ctx.now();
  const n = await countAuthFailures(ctx, f.ip, now - CONFIG.r3.windowMs);
  if (n >= CONFIG.r3.maxFailures && !(await isBlocked(ctx, f.ip))) {
    await run(
      ctx.db,
      `INSERT INTO blocks (source, until, rule, created_at) VALUES (?, CAST(? AS INTEGER), 'R3', CAST(? AS INTEGER))
       ON CONFLICT (source) DO UPDATE SET until = excluded.until, rule = excluded.rule, created_at = excluded.created_at`,
      [f.ip, now + CONFIG.r3.blockMs, now],
    );
    await raiseAlert(ctx, { rule: 'R3', severity: 'high', ip: f.ip, country: f.country, reason: `${n}_failures` });
  }
}
