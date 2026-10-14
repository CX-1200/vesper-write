// §13 Web Push. Payloads carry only a kind code and a count; the service
// worker turns them into one of the fixed texts. Sending happens after the
// response (ctx.defer) so it never slows a request down.

import { all, run } from './db/types.ts';
import type { AppContext, PushSubscriptionRow } from './context.ts';
import type { NotifyKind, NotifyPayload } from '@vesper/core/notify-texts';

export type PushAudience = { kind: 'approved_devices' } | { kind: 'devices'; deviceIds: string[] };

async function subscriptionsFor(ctx: AppContext, audience: PushAudience): Promise<PushSubscriptionRow[]> {
  if (audience.kind === 'approved_devices') {
    return all<PushSubscriptionRow>(
      ctx.db,
      `SELECT p.endpoint, p.p256dh, p.auth, p.device_id FROM push_subscriptions p JOIN devices d ON d.id = p.device_id
       WHERE d.revoked_at IS NULL AND d.vm_approved_at IS NOT NULL`,
    );
  }
  if (audience.deviceIds.length === 0) return [];
  const marks = audience.deviceIds.map(() => '?').join(', ');
  return all<PushSubscriptionRow>(
    ctx.db,
    `SELECT p.endpoint, p.p256dh, p.auth, p.device_id FROM push_subscriptions p JOIN devices d ON d.id = p.device_id
     WHERE d.revoked_at IS NULL AND p.device_id IN (${marks})`,
    audience.deviceIds,
  );
}

export async function sendPushNow(ctx: AppContext, kind: NotifyKind, n: number, audience: PushAudience): Promise<number> {
  const subs = await subscriptionsFor(ctx, audience);
  const payload: NotifyPayload = { k: kind, n: Math.max(1, Math.min(999, Math.floor(n))) };
  const urgency = kind === 'alert' || kind === 'locked' ? 'high' : 'normal';
  let sent = 0;
  await Promise.allSettled(
    subs.map(async (s) => {
      const r = await ctx.push.send(s, JSON.stringify(payload), { ttlSeconds: 6 * 3600, urgency });
      if (r.ok) sent++;
      if (r.gone) await run(ctx.db, 'DELETE FROM push_subscriptions WHERE endpoint = ?', [s.endpoint]);
    }),
  );
  return sent;
}

/** Fire-and-forget push (after the response). Security alerts go to ALL registered devices (§13). */
export function notify(ctx: AppContext, kind: NotifyKind, n = 1, audience: PushAudience = { kind: 'approved_devices' }): void {
  ctx.defer(async () => {
    try {
      await sendPushNow(ctx, kind, n, audience);
    } catch {
      // Push is best effort; failures are not content-bearing and need no logging.
    }
  });
}

/** Only well-known push services may be targets (prevents the server being used to POST to arbitrary URLs). */
const PUSH_HOST_SUFFIXES = ['.push.apple.com', 'fcm.googleapis.com', '.push.services.mozilla.com', '.notify.windows.com'];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => (s.startsWith('.') ? host.endsWith(s) : host === s));
}
