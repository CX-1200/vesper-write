// The single owner's credentials (OD2) and the one-time secrets (§5.1 secrets_meta).

import { CONFIG } from '@vesper/core/config';
import { first, run } from './db/types.ts';
import { decryptAtRest, verifySecret, hashSecret, ARGON2_TOKEN, timingSafeEqualStrings } from './server-crypto.ts';
import { verifyTotp } from './totp.ts';
import { num, numOrNull } from './sql.ts';
import type { AppContext } from './context.ts';

export interface OwnerRow {
  password_hash: string;
  totp_secret_enc: string;
  totp_confirmed: number;
  totp_last_step: number;
  setup_completed_at: number | null;
}

export async function getOwner(ctx: AppContext): Promise<OwnerRow | null> {
  const r = await first<OwnerRow>(ctx.db, 'SELECT password_hash, totp_secret_enc, totp_confirmed, totp_last_step, setup_completed_at FROM owner WHERE id = 1');
  return r ? { ...r, totp_confirmed: num(r.totp_confirmed), totp_last_step: num(r.totp_last_step), setup_completed_at: numOrNull(r.setup_completed_at) } : null;
}

export async function isSetupComplete(ctx: AppContext): Promise<boolean> {
  const o = await getOwner(ctx);
  return !!o && o.setup_completed_at !== null;
}

/**
 * Verify a TOTP code and atomically record its step so the same code (or an
 * older one) can never be accepted again.
 */
export async function checkTotp(ctx: AppContext, owner: OwnerRow, code: string): Promise<boolean> {
  let secret: Uint8Array;
  try {
    secret = decryptAtRest(ctx.env.totpEncKey, owner.totp_secret_enc);
  } catch {
    return false;
  }
  const step = verifyTotp(secret, code, ctx.now(), owner.totp_last_step);
  if (step === null) return false;
  const changes = await run(ctx.db, 'UPDATE owner SET totp_last_step = CAST(? AS INTEGER) WHERE id = 1 AND totp_last_step < CAST(? AS INTEGER)', [step, step]);
  return changes === 1;
}

export function passwordAcceptable(pw: unknown): pw is string {
  return typeof pw === 'string' && [...pw].length >= CONFIG.passwordMinLength && pw.length <= CONFIG.passwordMaxLength;
}

export type SecretKind = 'setup' | 'recovery' | 'break_glass' | 'kill_token' | 'worker_token';

export async function getSecretMeta(ctx: AppContext, kind: SecretKind): Promise<{ hash: string; used_at: number | null } | null> {
  const r = await first<{ hash: string; used_at: number | null }>(ctx.db, 'SELECT hash, used_at FROM secrets_meta WHERE kind = ?', [kind]);
  return r ? { hash: r.hash, used_at: numOrNull(r.used_at) } : null;
}

/** Verify an unused one-time secret of `kind`. */
export async function verifyStoredSecret(ctx: AppContext, kind: SecretKind, value: unknown): Promise<boolean> {
  if (typeof value !== 'string' || value.length < 16 || value.length > 256) return false;
  const meta = await getSecretMeta(ctx, kind);
  if (!meta || meta.used_at !== null) return false;
  return verifySecret(value, meta.hash);
}

export async function upsertSecretStatement(ctx: AppContext, kind: SecretKind, value: string): Promise<{ sql: string; params: (string | number)[] }> {
  const hash = await hashSecret(value, ARGON2_TOKEN);
  return {
    sql: `INSERT INTO secrets_meta (kind, hash, created_at) VALUES (?, ?, CAST(? AS INTEGER))
          ON CONFLICT (kind) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at, used_at = NULL`,
    params: [kind, hash, ctx.now()],
  };
}

/** The setup token lives in the SETUP_TOKEN env var and stops working once setup is complete. */
export async function setupTokenValid(ctx: AppContext, provided: unknown): Promise<boolean> {
  const expected = ctx.env.setupToken;
  if (typeof provided !== 'string' || !expected) return false;
  if (!timingSafeEqualStrings(provided, expected)) return false;
  const used = await getSecretMeta(ctx, 'setup');
  return !(used && used.used_at !== null);
}

/**
 * Recovery key, break-glass key and kill token are generated on the device as
 * 20 random bytes (160 bits) in base32, shown in groups like ABCD-EFGH-….
 * Normalize what the user typed: case-insensitive, spaces and dashes ignored.
 */
export function normalizeUserSecret(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 128) return null;
  // base32 has no 0 or 1: read them as the letters O and I they look like
  const s = v.toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I');
  return /^[A-Z2-7]{32}$/.test(s) ? s : null;
}
