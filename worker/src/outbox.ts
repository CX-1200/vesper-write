// Device approvals / revocations made at the VM terminal are queued here,
// already signed by the VM, and delivered by the running worker on its next
// pull. This keeps the CLI free of network access and of the worker token.

import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

export type DeviceOutboxItem =
  | { action: 'approve'; device_id: string; fingerprint: string; approved_at: number; sig: string }
  | { action: 'revoke'; device_id: string; revoked_at: number; sig: string };

export function enqueueDeviceAction(p: Paths, item: DeviceOutboxItem): void {
  ensureDir(p.outboxDir);
  const ts = item.action === 'approve' ? item.approved_at : item.revoked_at;
  writeJsonAtomic(join(p.outboxDir, `${ts}-${item.action}-${item.device_id}.json`), item);
}

export function listDeviceActions(p: Paths): Array<{ file: string; item: DeviceOutboxItem }> {
  ensureDir(p.outboxDir);
  return readdirSync(p.outboxDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: join(p.outboxDir, f), item: JSON.parse(readFileSync(join(p.outboxDir, f), 'utf8')) as DeviceOutboxItem }));
}

export function removeDeviceAction(file: string): void {
  unlinkSync(file);
}
