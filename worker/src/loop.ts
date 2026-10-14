// §9.1 main loop.
//
//  every 30 s:
//    latch present → heartbeat only, process nothing
//    pull (VM-signed)
//    server says LOCKDOWN/KILLED → write the latch, stop
//    for each claimed ticket:
//      1 verify the device signature with the key from trusted-devices.json
//        (device not in the list → R8)
//      2 decrypt with the VM key and the exact AAD (failure → R8)
//      3 read ticket-types.json, preferences.md and the template
//      4 assemble the input, run claude -p
//      5 lint the output
//      6 encrypt { prompt, lint, model, … } separately for every trusted device; VM-sign
//      7 POST /api/worker/result
//      8 append to log/tickets.jsonl
//    R8 → write the latch, report /api/worker/alert, stop
//    N consecutive connection failures → exponential backoff

import { canonicalTicketBody, parseInputPlaintext, parseOutputPlaintext, TARGETS, TICKET_TYPE_RE } from '@vesper/core/schemas';
import { HPKE_INFO, hpkePublicKeyFromJwk, inputAad, openJson, outputAad, parseEnvelope, sealJson, type Envelope, type Target } from '@vesper/core/envelope';
import { importVerifyKey } from '@vesper/core/keys';
import { isFresh, isValidNonce, signOutput, verifyRequestSignature } from '@vesper/core/sign';
import { lintPrompt } from '@vesper/core/lint';
import { workerDecision, type SystemStateName } from '@vesper/core/system-state';
import { UUID_RE } from '@vesper/core/encoding';
import { CONFIG } from '@vesper/core/config';
import { HttpError, NetworkError, type PulledTicket, type VercelClient } from './api.ts';
import { ContentError, loadPreferences, loadType } from './content.ts';
import { latchExists, writeLatch } from './latch.ts';
import { listDeviceActions, removeDeviceAction } from './outbox.ts';
import { appendTicketRecord } from './local-log.ts';
import { loadRevoked, loadTrusted } from './trust.ts';
import { writeJsonAtomic } from './fsutil.ts';
import { ProcessorError, type Processor } from './processor.ts';
import type { VmKeys } from './keystore.ts';
import type { Paths } from './paths.ts';
import type { WorkerConfig } from './config.ts';

export type LogFn = (event: string, fields?: Record<string, string | number | boolean | null>) => void;

export interface WorkerDeps {
  cfg: Pick<WorkerConfig, 'contentDir' | 'claimMax' | 'pollIntervalMs'>;
  paths: Paths;
  keys: VmKeys;
  client: VercelClient;
  processor: Processor;
  now: () => number;
  log: LogFn;
}

export type PollOutcome =
  | { kind: 'processed'; state: SystemStateName; processed: number; failed: number }
  | { kind: 'heartbeat'; state: SystemStateName; latched: boolean }
  | { kind: 'latched'; reason: string }
  | { kind: 'r8'; reason: string };

/** Raised when a VM-side detection rule (R8) fires. */
export class R8Error extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = 'R8Error';
  }
}

/** Failures that are not attacks: report to Vercel and continue with the next ticket. */
class TicketFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'TicketFailure';
  }
}

export async function deliverDeviceActions(d: WorkerDeps): Promise<number> {
  let delivered = 0;
  for (const { file, item } of listDeviceActions(d.paths)) {
    try {
      await d.client.deviceAction(item);
      removeDeviceAction(file);
      delivered++;
      d.log('device_action_delivered', { action: item.action, device: item.device_id });
    } catch (e) {
      // 404 (unknown device) or 409 (fingerprint mismatch) will never succeed: drop it, keep the evidence in the log.
      if (e instanceof HttpError && (e.status === 404 || e.status === 409 || e.status === 400)) {
        removeDeviceAction(file);
        d.log('device_action_rejected', { action: item.action, device: item.device_id, status: e.status, code: e.code });
      } else {
        d.log('device_action_deferred', { action: item.action, device: item.device_id });
        break;
      }
    }
  }
  return delivered;
}

function writeStatus(d: WorkerDeps, fields: Record<string, unknown>): void {
  try {
    writeJsonAtomic(d.paths.status, { ...fields, updated_at: d.now() });
  } catch {
    // status is informational only
  }
}

export async function pollOnce(d: WorkerDeps): Promise<PollOutcome> {
  const latched = latchExists(d.paths);
  const res = await d.client.pull(latched ? 0 : d.cfg.claimMax, latched);

  // Cache approval candidates for `vesper device approve` (the CLI recomputes fingerprints itself).
  writeJsonAtomic(d.paths.pendingDevices, { fetched_at: d.now(), devices: res.pending_devices });

  const action = workerDecision(latched, res.state);
  if (action === 'latch_and_stop') {
    writeLatch(d.paths, `server_${res.state.toLowerCase()}`, d.now());
    d.log('latched', { reason: `server_${res.state.toLowerCase()}` });
    writeStatus(d, { state: res.state, latched: true, last_pull_ok: d.now() });
    return { kind: 'latched', reason: `server_${res.state.toLowerCase()}` };
  }
  if (res.state !== 'LOCKDOWN' && res.state !== 'KILLED') await deliverDeviceActions(d);
  if (action === 'heartbeat_only') {
    writeStatus(d, { state: res.state, latched, last_pull_ok: d.now() });
    // Defensive: tickets are never handed out in this situation, but never process them if they are.
    for (const t of res.tickets) if (UUID_RE.test(t.id)) await d.client.resultFail(t.id, 'worker_not_processing').catch(() => {});
    return { kind: 'heartbeat', state: res.state, latched };
  }

  let processed = 0;
  let failed = 0;
  for (const t of res.tickets) {
    try {
      await processTicket(d, t);
      processed++;
    } catch (e) {
      if (e instanceof R8Error) {
        writeLatch(d.paths, 'r8', d.now(), e.reason);
        d.log('r8', { reason: e.reason, ticket: UUID_RE.test(t.id) ? t.id : null });
        await d.client.alert(e.reason, UUID_RE.test(t.id) ? t.id : undefined).catch(() => d.log('r8_report_failed'));
        writeStatus(d, { state: res.state, latched: true, last_pull_ok: d.now() });
        return { kind: 'r8', reason: e.reason };
      }
      failed++;
      const code = e instanceof TicketFailure || e instanceof ProcessorError || e instanceof ContentError ? e.code : 'worker_error';
      d.log('ticket_failed', { ticket: t.id, code });
      appendTicketRecord(d.paths, { ts: d.now(), ticket_id: t.id, type: t.type, target: t.target, device_id: t.device_id, status: 'failed', attempts: t.attempts, error_code: code });
      await d.client.resultFail(t.id, code).catch(() => d.log('result_report_failed', { ticket: t.id }));
    }
  }
  writeStatus(d, { state: res.state, latched: false, last_pull_ok: d.now(), last_processed: processed, last_failed: failed });
  return { kind: 'processed', state: res.state, processed, failed };
}

/** Throws R8Error for anything that indicates tampering, TicketFailure/ProcessorError for ordinary failures. */
export async function processTicket(d: WorkerDeps, t: PulledTicket): Promise<void> {
  // 0. shape — anything malformed coming from Vercel is treated as tampering
  let envelope: Envelope;
  try {
    if (!UUID_RE.test(t.id) || !UUID_RE.test(t.device_id)) throw new Error('ids');
    if (!TICKET_TYPE_RE.test(t.type) || !(TARGETS as readonly string[]).includes(t.target)) throw new Error('type/target');
    if (!Number.isSafeInteger(t.input_ts) || !isValidNonce(t.input_nonce) || typeof t.input_sig !== 'string') throw new Error('sig fields');
    envelope = parseEnvelope(t.input_envelope);
  } catch {
    throw new R8Error('malformed_ticket');
  }
  const target = t.target as Target;

  // 1. the device must be in OUR trust list; its key comes only from there (§8.4)
  const trusted = await loadTrusted(d.paths);
  const device = trusted.find((x) => x.id === t.device_id);
  if (!device) {
    if (loadRevoked(d.paths).some((x) => x.id === t.device_id)) throw new TicketFailure('device_revoked');
    throw new R8Error('untrusted_device');
  }
  const body = canonicalTicketBody({ id: t.id, type: t.type, target, device_id: t.device_id, ts: t.input_ts, input_envelope: envelope });
  const sigOk = await verifyRequestSignature(
    await importVerifyKey(device.sign_public_key),
    { method: 'POST', path: '/api/tickets', ts: t.input_ts, nonce: t.input_nonce, body },
    t.input_sig,
  );
  if (!sigOk) throw new R8Error('bad_device_signature');
  // A ticket signed long before the stale deadline can only be a replay.
  if (!isFresh(t.input_ts, d.now(), CONFIG.staleAfterMs + 3_600_000)) throw new R8Error('ticket_too_old');

  // 2. decrypt with the exact AAD
  let raw: string;
  try {
    const plain = await openJson(d.keys.enc, envelope, { info: HPKE_INFO.in, aad: inputAad({ ticketId: t.id, type: t.type, target, deviceId: t.device_id, ts: t.input_ts }) });
    raw = parseInputPlaintext(plain).raw_input;
  } catch {
    throw new R8Error('decrypt_failed');
  }

  // 3. content (read fresh every time)
  const type = loadType(d.cfg.contentDir, t.type);
  const preferences = loadPreferences(d.cfg.contentDir);

  // 4. claude -p
  const out = await d.processor.generate({
    rawInput: raw,
    type: t.type,
    target,
    preferences,
    template: type.template,
    model: type.config.model,
    maxChars: type.config.max_output_chars,
  });

  // 5. lint (the device runs the same rules again)
  const limits = { max_chars: type.config.max_output_chars, typical_chars: type.config.typical_chars ?? null };
  const lint = lintPrompt(out.prompt, { truncated: out.meta.truncated, limits: { max_chars: limits.max_chars, ...(limits.typical_chars ? { typical_chars: limits.typical_chars } : {}) } });
  const plaintext = parseOutputPlaintext({ prompt: out.prompt, lint, model: out.meta.model, raw_input: raw, truncated: out.meta.truncated, limits });

  // 6. encrypt for every trusted device, then sign all envelopes together
  const processedAt = d.now();
  const envelopes: Record<string, Envelope> = {};
  for (const r of trusted) {
    envelopes[r.id] = await sealJson(await hpkePublicKeyFromJwk(r.enc_public_key), plaintext, {
      info: HPKE_INFO.out,
      aad: outputAad({ ticketId: t.id, type: t.type, target, recipientDeviceId: r.id, processedAt }),
    });
  }
  const sig = await signOutput(d.keys.signPrivate, t.id, envelopes);

  // 7. write back
  await d.client.resultOk(t.id, processedAt, envelopes, sig);

  // 8. local record (plaintext stays on the VM)
  appendTicketRecord(d.paths, {
    ts: processedAt,
    ticket_id: t.id,
    type: t.type,
    target,
    device_id: t.device_id,
    status: 'awaiting_review',
    attempts: t.attempts,
    raw_input: raw,
    prompt: out.prompt,
    lint,
    model: out.meta.model,
    truncated: out.meta.truncated,
    duration_ms: out.meta.durationMs,
    recipients: trusted.length,
  });
  d.log('ticket_processed', { ticket: t.id, type: t.type, ms: out.meta.durationMs, lint: lint.length, recipients: trusted.length });
}

export interface RunOptions {
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Runs until the signal aborts. Never throws for network trouble; backs off instead. */
export async function runLoop(d: WorkerDeps, opts: RunOptions = {}): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  let failures = 0;
  while (!opts.signal?.aborted) {
    let delay = d.cfg.pollIntervalMs;
    try {
      const r = await pollOnce(d);
      failures = 0;
      if (r.kind === 'processed' && r.processed + r.failed > 0) delay = 1_000; // more work may be waiting
    } catch (e) {
      if (e instanceof NetworkError || (e instanceof HttpError && (e.status >= 500 || e.status === 429))) {
        failures++;
        const { failuresBeforeBackoff, baseMs, maxMs } = CONFIG.workerBackoff;
        if (failures >= failuresBeforeBackoff) delay = Math.min(maxMs, baseMs * 2 ** (failures - failuresBeforeBackoff + 1));
        d.log('pull_failed', { kind: e instanceof NetworkError ? 'network' : `http_${(e as HttpError).status}`, failures, next_ms: delay });
      } else if (e instanceof HttpError) {
        d.log('pull_rejected', { status: e.status, code: e.code });
      } else {
        d.log('loop_error', { error: (e as Error)?.name ?? 'Error' });
      }
    }
    await sleep(delay, opts.signal);
  }
}
