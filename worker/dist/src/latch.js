// §6.3 local latch. While state/latch exists the worker processes nothing,
// even if Vercel says NORMAL. Only a human at the VM terminal can remove it
// (v2: `vesper unlock`). The worker itself never deletes it.
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from "./fsutil.js";
export function latchExists(p) {
    return existsSync(p.latch);
}
export function readLatch(p) {
    if (!existsSync(p.latch))
        return null;
    try {
        return JSON.parse(readFileSync(p.latch, 'utf8'));
    }
    catch {
        return { reason: 'unreadable', since: 0 };
    }
}
/** Idempotent: an existing latch (and its original reason) is kept. */
export function writeLatch(p, reason, now, detail) {
    if (latchExists(p))
        return;
    writeJsonAtomic(p.latch, { reason, since: now, ...(detail ? { detail } : {}) });
}
