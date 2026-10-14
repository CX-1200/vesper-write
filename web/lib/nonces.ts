// §8.4 replay protection: (signer, nonce) may be used only once. Nonces are
// kept for longer than twice the ±60 s signature window, so a replay can never
// slip in after its nonce was forgotten.

import { CONFIG } from '@vesper/core/config';
import { run } from './db/types.ts';
import type { AppContext } from './context.ts';

/** True if the nonce was fresh (and is now recorded); false on replay. */
export async function consumeNonce(ctx: AppContext, scope: string, nonce: string): Promise<boolean> {
  const now = ctx.now();
  const changes = await run(ctx.db, 'INSERT INTO nonces (scope, nonce, seen_at) VALUES (?, ?, CAST(? AS INTEGER)) ON CONFLICT DO NOTHING', [
    scope,
    nonce,
    now,
  ]);
  if (Math.random() < 0.05) await run(ctx.db, 'DELETE FROM nonces WHERE seen_at < ?', [now - CONFIG.nonceRetentionMs]);
  return changes === 1;
}
