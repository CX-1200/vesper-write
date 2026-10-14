// Production/dev wiring of AppContext for Next.js route handlers.

import { after } from 'next/server';
import { loadEnv, type Env } from './env.ts';
import { D1RestDb } from './db/d1.ts';
import { fail } from './http.ts';
import type { AppContext, PushSender } from './context.ts';
import type { Db } from './db/types.ts';

let cached: AppContext | null = null;

async function localSqlite(path: string): Promise<Db> {
  const { SqliteDb } = await import('./db/sqlite.ts');
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new SqliteDb(path);
  db.applySchema(new URL('./db/schema.sql', import.meta.url));
  return db;
}

function webPushSender(env: Env): PushSender {
  return {
    async send(sub, payload, opts) {
      if (!env.vapid) return { ok: false, gone: false };
      const webpush = (await import('web-push')).default;
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
          vapidDetails: { subject: env.vapid.subject, publicKey: env.vapid.publicKey, privateKey: env.vapid.privateKey },
          TTL: opts.ttlSeconds,
          urgency: opts.urgency,
          timeout: 10_000,
        });
        return { ok: true, gone: false };
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        return { ok: false, gone: status === 404 || status === 410 };
      }
    },
  };
}

export async function getAppContext(): Promise<AppContext> {
  if (cached) return cached;
  const env = loadEnv();
  const db =
    env.db.driver === 'd1'
      ? new D1RestDb({ accountId: env.db.accountId, databaseId: env.db.databaseId, apiToken: env.db.apiToken, mode: env.db.mode })
      : await localSqlite(env.db.path);
  cached = {
    db,
    env,
    now: () => Date.now(),
    defer: (task) => after(task),
    push: webPushSender(env),
  };
  return cached;
}

type Handler = (req: Request, ctx: AppContext, params: Record<string, string>) => Promise<Response>;

/** Wrap a handler for app/api route files. Unexpected errors become a generic 500 with no details. */
export function route(handler: Handler) {
  return async (req: Request, info?: { params?: Promise<Record<string, string>> }): Promise<Response> => {
    try {
      const ctx = await getAppContext();
      const params = info?.params ? await info.params : {};
      return await handler(req, ctx, params);
    } catch (e) {
      // Log only the error class: messages could echo SQL or upstream errors (§18: no bodies, content or secrets in logs).
      console.error(`[vesper] ${new URL(req.url).pathname} failed: ${(e as Error)?.name ?? 'Error'}`);
      return fail('server_error');
    }
  };
}
