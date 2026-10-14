// §6.3 local latch. While state/latch exists the worker processes nothing,
// even if Vercel says NORMAL. Only a human at the VM terminal can remove it
// (v2: `vesper unlock`). The worker itself never deletes it.

import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

export interface LatchInfo {
  reason: string;
  since: number;
  detail?: string;
}

export function latchExists(p: Paths): boolean {
  return existsSync(p.latch);
}

export function readLatch(p: Paths): LatchInfo | null {
  if (!existsSync(p.latch)) return null;
  try {
    return JSON.parse(readFileSync(p.latch, 'utf8')) as LatchInfo;
  } catch {
    return { reason: 'unreadable', since: 0 };
  }
}

/** Idempotent: an existing latch (and its original reason) is kept. */
export function writeLatch(p: Paths, reason: string, now: number, detail?: string): void {
  if (latchExists(p)) return;
  writeJsonAtomic(p.latch, { reason, since: now, ...(detail ? { detail } : {}) } satisfies LatchInfo);
}
