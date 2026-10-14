// Test harness: runs the real web handlers against in-memory SQLite (with the
// same string-only parameter rules as D1), a controllable clock and a fake
// push service. `h.fetch` routes requests to the handlers without HTTP.

import { SqliteDb } from '../../web/lib/db/sqlite.ts';
import { dispatch } from '../../web/lib/router.ts';
import type { AppContext, PushSender } from '../../web/lib/context.ts';
import type { Env } from '../../web/lib/env.ts';
import { randomBytes } from 'node:crypto';

export const SETUP_TOKEN = 'setup-token-for-tests-0123456789abcdefghijklmnop';
export const BASE = 'https://vesper.test';
export const T0 = Date.UTC(2026, 9, 14, 2, 0, 0); // 10:00 in Kuala Lumpur

export interface SentPush {
  device: string;
  endpoint: string;
  payload: { k: string; n: number };
}

export interface Harness {
  ctx: AppContext;
  db: SqliteDb;
  env: Env;
  clock: { t: number; advance(ms: number): void };
  pushes: SentPush[];
  flush(): Promise<void>;
  fetch: typeof fetch;
  /** run a raw SQL statement (for "attacker with DB access" tests) */
  sql(sql: string, params?: (string | number)[]): Promise<Record<string, unknown>[]>;
}

export function makeHarness(overrides: Partial<Env> = {}): Harness {
  const db = new SqliteDb(':memory:');
  db.applySchema(new URL('../../web/lib/db/schema.sql', import.meta.url));
  const env: Env = {
    appOrigin: BASE,
    rpId: 'vesper.test',
    setupToken: SETUP_TOKEN,
    totpEncKey: new Uint8Array(randomBytes(32)),
    vapid: { publicKey: 'test-public', privateKey: 'test-private', subject: 'mailto:test@example.com' },
    db: { driver: 'sqlite', path: ':memory:' },
    trustProxyHeaders: true,
    isProduction: false,
    ...overrides,
  };
  const clock = {
    t: T0,
    advance(ms: number) {
      this.t += ms;
    },
  };
  const deferred: Array<Promise<void>> = [];
  const pushes: SentPush[] = [];
  const push: PushSender = {
    async send(sub, payload) {
      pushes.push({ device: sub.device_id, endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return { ok: true, gone: false };
    },
  };
  const ctx: AppContext = {
    db,
    env,
    now: () => clock.t,
    defer: (task) => {
      deferred.push(task());
    },
    push,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(typeof input === 'string' && input.startsWith('/') ? BASE + input : input, init);
    const headers = new Headers(req.headers);
    if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', '192.0.2.50');
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    return dispatch(new Request(req.url, { method: req.method, headers, body }), ctx);
  };
  return {
    ctx,
    db,
    env,
    clock,
    pushes,
    fetch: fetchImpl,
    async flush() {
      while (deferred.length) await deferred.shift();
    },
    async sql(sql, params = []) {
      const [r] = await db.batch([{ sql, params }]);
      return r?.rows ?? [];
    },
  };
}
