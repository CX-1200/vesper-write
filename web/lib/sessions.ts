// Sessions (§5.1): 12 h lifetime, cookie is HttpOnly + Secure + SameSite=Strict
// with the __Host- prefix; only SHA-256(session id) is stored.

import { CONFIG } from '@vesper/core/config';
import { first, run } from './db/types.ts';
import { getCookie } from './http.ts';
import { randomToken, sha256Hex } from './server-crypto.ts';
import { insert, num } from './sql.ts';
import type { AppContext } from './context.ts';

export const SESSION_COOKIE = '__Host-vesper_sid';

export interface SessionRow {
  id_hash: string;
  device_id: string;
  created_at: number;
  expires_at: number;
  frozen: number;
}

export async function createSession(ctx: AppContext, deviceId: string): Promise<string> {
  const id = randomToken(32);
  const now = ctx.now();
  await ctx.db.batch([insert('sessions', { id_hash: sha256Hex(id), device_id: deviceId, created_at: now, expires_at: now + CONFIG.sessionTtlMs, frozen: 0 })]);
  return sessionCookie(id);
}

export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(CONFIG.sessionTtlMs / 1000)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function findSession(ctx: AppContext, req: Request): Promise<SessionRow | null> {
  const id = getCookie(req, SESSION_COOKIE);
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const row = await first<SessionRow>(ctx.db, 'SELECT id_hash, device_id, created_at, expires_at, frozen FROM sessions WHERE id_hash = ?', [sha256Hex(id)]);
  if (!row) return null;
  if (num(row.expires_at) <= ctx.now()) {
    await run(ctx.db, 'DELETE FROM sessions WHERE id_hash = ?', [row.id_hash]);
    return null;
  }
  return row;
}

export async function deleteSession(ctx: AppContext, idHash: string): Promise<void> {
  await run(ctx.db, 'DELETE FROM sessions WHERE id_hash = ?', [idHash]);
}
