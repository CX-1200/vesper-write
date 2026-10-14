// Everything a handler needs, injected so tests can run handlers directly
// against SQLite with a controllable clock and a fake push service.

import type { Db } from './db/types.ts';
import type { Env } from './env.ts';

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  device_id: string;
}

export interface PushSender {
  /** `gone` means the push service says the subscription no longer exists. */
  send(sub: PushSubscriptionRow, payload: string, opts: { ttlSeconds: number; urgency: 'normal' | 'high' }): Promise<{ ok: boolean; gone: boolean }>;
}

export interface AppContext {
  db: Db;
  env: Env;
  now(): number;
  /** Run work after the response is sent (Next.js `after`); tests collect and await it. */
  defer(task: () => Promise<void>): void;
  push: PushSender;
}
