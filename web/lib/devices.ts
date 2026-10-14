import { all, first } from './db/types.ts';
import { num, numOrNull, strOrNull } from './sql.ts';
import type { AppContext } from './context.ts';
import type { EcPublicJwk } from '@vesper/core/keys';

export interface DeviceRow {
  id: string;
  name: string;
  sign_public_key: string;
  enc_public_key: string;
  fingerprint: string;
  vm_approved_at: number | null;
  vm_approval_sig: string | null;
  enrolled_at: number;
  enrolled_via: 'setup' | 'recovery';
  last_seen_at: number | null;
  last_ip: string | null;
  last_country: string | null;
  revoked_at: number | null;
  webauthn_credential_id: string | null;
  webauthn_public_key: string | null;
  sign_count: number;
}

const COLS =
  'id, name, sign_public_key, enc_public_key, fingerprint, vm_approved_at, vm_approval_sig, enrolled_at, enrolled_via, last_seen_at, last_ip, last_country, revoked_at, webauthn_credential_id, webauthn_public_key, sign_count';

function normalize(r: DeviceRow): DeviceRow {
  return {
    ...r,
    vm_approved_at: numOrNull(r.vm_approved_at),
    enrolled_at: num(r.enrolled_at),
    last_seen_at: numOrNull(r.last_seen_at),
    revoked_at: numOrNull(r.revoked_at),
    vm_approval_sig: strOrNull(r.vm_approval_sig),
    webauthn_credential_id: strOrNull(r.webauthn_credential_id),
    webauthn_public_key: strOrNull(r.webauthn_public_key),
    sign_count: num(r.sign_count ?? 0),
  };
}

export async function getDevice(ctx: AppContext, id: string): Promise<DeviceRow | null> {
  const r = await first<DeviceRow>(ctx.db, `SELECT ${COLS} FROM devices WHERE id = ?`, [id]);
  return r ? normalize(r) : null;
}

export async function listDevices(ctx: AppContext): Promise<DeviceRow[]> {
  return (await all<DeviceRow>(ctx.db, `SELECT ${COLS} FROM devices ORDER BY enrolled_at ASC`)).map(normalize);
}

export async function pendingDevices(ctx: AppContext): Promise<DeviceRow[]> {
  return (await all<DeviceRow>(ctx.db, `SELECT ${COLS} FROM devices WHERE vm_approved_at IS NULL AND revoked_at IS NULL ORDER BY enrolled_at ASC`)).map(
    normalize,
  );
}

export function deviceSignJwk(d: DeviceRow): EcPublicJwk {
  return JSON.parse(d.sign_public_key) as EcPublicJwk;
}

export function deviceEncJwk(d: DeviceRow): EcPublicJwk {
  return JSON.parse(d.enc_public_key) as EcPublicJwk;
}

export function isApproved(d: DeviceRow): boolean {
  return d.vm_approved_at !== null && d.revoked_at === null;
}
