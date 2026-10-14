// Ticket encryption (device → VM) and output verification + decryption
// (VM → device). The VM key used here is ALWAYS the one pinned at pairing.

import { hpkePublicKeyFromJwk, HPKE_INFO, inputAad, openJson, outputAad, sealJson, type Target } from '@vesper/core/envelope';
import { importVerifyKey } from '@vesper/core/keys';
import { verifyOutput } from '@vesper/core/sign';
import { canonicalTicketBody, parseOutputPlaintext, type OutputPlaintext } from '@vesper/core/schemas';
import { randomUuid } from '@vesper/core/encoding';
import type { Identity, PinnedVm } from './identity.ts';

export async function buildTicket(identity: Identity, vm: PinnedVm, o: { type: string; target: Target; raw: string }) {
  const id = randomUuid();
  const ts = Date.now();
  const envelope = await sealJson(await hpkePublicKeyFromJwk(vm.encJwk), { raw_input: o.raw }, {
    info: HPKE_INFO.in,
    aad: inputAad({ ticketId: id, type: o.type, target: o.target, deviceId: identity.id, ts }),
  });
  const body = canonicalTicketBody({ id, type: o.type, target: o.target, device_id: identity.id, ts, input_envelope: envelope });
  return { id, ts, body };
}

export interface TicketView {
  id: string;
  type: string;
  target: Target;
  status: string;
  processed_at: number | null;
  output_envelopes: Record<string, unknown> | null;
  output_sig: string | null;
}

export type OpenResult =
  | { ok: true; plain: OutputPlaintext }
  | { ok: false; reason: 'no_output' | 'bad_signature' | 'not_for_this_device' | 'decrypt_failed' | 'bad_plaintext' };

export async function openTicketOutput(identity: Identity, vm: PinnedVm, t: TicketView): Promise<OpenResult> {
  if (!t.output_envelopes || !t.output_sig || t.processed_at === null) return { ok: false, reason: 'no_output' };
  const sigOk = await verifyOutput(await importVerifyKey(vm.signJwk), t.id, t.output_envelopes, t.output_sig);
  if (!sigOk) return { ok: false, reason: 'bad_signature' };
  const mine = t.output_envelopes[identity.id];
  if (!mine) return { ok: false, reason: 'not_for_this_device' };
  let plain: unknown;
  try {
    plain = await openJson(identity.enc, mine as never, {
      info: HPKE_INFO.out,
      aad: outputAad({ ticketId: t.id, type: t.type, target: t.target, recipientDeviceId: identity.id, processedAt: t.processed_at }),
    });
  } catch {
    return { ok: false, reason: 'decrypt_failed' };
  }
  try {
    return { ok: true, plain: parseOutputPlaintext(plain) };
  } catch {
    return { ok: false, reason: 'bad_plaintext' };
  }
}
