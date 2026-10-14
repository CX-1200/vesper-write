// HTTPS client for the worker endpoints. Every request carries the worker
// token AND a VM signature over method | path | ts | nonce | sha256(body)
// (§7, §8.4). The VM only ever makes outbound requests (§22: no inbound ports).

import { randomNonce } from '@vesper/core/encoding';
import { signRequest } from '@vesper/core/sign';
import type { EcPublicJwk } from '@vesper/core/keys';
import type { Envelope } from '@vesper/core/envelope';
import type { SystemStateName } from '@vesper/core/system-state';
import type { DeviceOutboxItem } from './outbox.ts';

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`HTTP ${status} ${code}`);
    this.status = status;
    this.code = code;
    this.name = 'HttpError';
  }
}

export interface PulledTicket {
  id: string;
  type: string;
  target: string;
  device_id: string;
  input_envelope: Envelope;
  input_sig: string;
  input_nonce: string;
  input_ts: number;
  attempts: number;
  created_at: number;
}

export interface PendingDevice {
  id: string;
  name: string;
  sign_public_key: EcPublicJwk;
  enc_public_key: EcPublicJwk;
  enrolled_at: number;
}

export interface PullResponse {
  state: SystemStateName;
  server_time: number;
  tickets: PulledTicket[];
  pending_devices: PendingDevice[];
}

export interface ClientOptions {
  baseUrl: string;
  workerToken: string;
  vmSignKey: CryptoKey;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new NetworkError('request failed');
  }
}

async function decode<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (!res.ok) throw new HttpError(res.status, String((body as { error?: unknown }).error ?? 'error'));
  return body as T;
}

type ResolvedOptions = Required<ClientOptions>;

export class VercelClient {
  readonly #o: ResolvedOptions;

  constructor(o: ClientOptions) {
    this.#o = { fetchImpl: globalThis.fetch.bind(globalThis), now: Date.now, timeoutMs: 20_000, ...o };
  }

  async post<T>(path: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload);
    const ts = this.#o.now();
    const nonce = randomNonce();
    const sig = await signRequest(this.#o.vmSignKey, { method: 'POST', path, ts, nonce, body });
    const res = await send(
      this.#o.fetchImpl,
      this.#o.baseUrl + path,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#o.workerToken}`,
          'Content-Type': 'application/json',
          'X-Vesper-Ts': String(ts),
          'X-Vesper-Nonce': nonce,
          'X-Vesper-Sig': sig,
        },
        body,
      },
      this.#o.timeoutMs,
    );
    return decode<T>(res);
  }

  pull(max: number, latched: boolean): Promise<PullResponse> {
    return this.post<PullResponse>('/api/worker/pull', { max, latched });
  }

  resultOk(ticketId: string, processedAt: number, outputEnvelopes: Record<string, Envelope>, outputSig: string): Promise<{ ok: true }> {
    return this.post('/api/worker/result', { ticket_id: ticketId, ok: true, processed_at: processedAt, output_envelopes: outputEnvelopes, output_sig: outputSig });
  }

  resultFail(ticketId: string, errorCode: string): Promise<{ ok: true }> {
    return this.post('/api/worker/result', { ticket_id: ticketId, ok: false, error_code: errorCode });
  }

  deviceAction(item: DeviceOutboxItem): Promise<{ ok: true }> {
    return this.post('/api/worker/device-approval', item);
  }

  alert(reason: string, ticketId?: string): Promise<{ ok: true }> {
    return this.post('/api/worker/alert', { rule: 'R8', reason, ...(ticketId ? { ticket_id: ticketId } : {}) });
  }
}

/**
 * First-time registration (`vesper init`): authenticated by the one-time
 * setup token; the request is signed by the VM key being registered (proof
 * of possession).
 */
export async function registerVm(o: {
  baseUrl: string;
  setupToken: string;
  workerToken: string;
  vmSignKey: CryptoKey;
  signPublicJwk: EcPublicJwk;
  encPublicJwk: EcPublicJwk;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<{ fingerprint: string }> {
  const path = '/api/worker/register';
  const body = JSON.stringify({
    setup_token: o.setupToken,
    worker_token: o.workerToken,
    vm: { sign_public_key: o.signPublicJwk, enc_public_key: o.encPublicJwk },
  });
  const ts = (o.now ?? Date.now)();
  const nonce = randomNonce();
  const sig = await signRequest(o.vmSignKey, { method: 'POST', path, ts, nonce, body });
  const res = await send(
    o.fetchImpl ?? globalThis.fetch.bind(globalThis),
    o.baseUrl + path,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vesper-Ts': String(ts), 'X-Vesper-Nonce': nonce, 'X-Vesper-Sig': sig }, body },
    20_000,
  );
  return decode<{ fingerprint: string }>(res);
}
