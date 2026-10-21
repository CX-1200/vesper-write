// HTTPS client for the worker endpoints. Every request carries the worker
// token AND a VM signature over method | path | ts | nonce | sha256(body)
// (§7, §8.4). The VM only ever makes outbound requests (§22: no inbound ports).
import { randomNonce } from '@vesper/core/encoding';
import { signRequest } from '@vesper/core/sign';
export class NetworkError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NetworkError';
    }
}
export class HttpError extends Error {
    status;
    code;
    constructor(status, code) {
        super(`HTTP ${status} ${code}`);
        this.status = status;
        this.code = code;
        this.name = 'HttpError';
    }
}
async function send(fetchImpl, url, init, timeoutMs) {
    try {
        return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    }
    catch {
        throw new NetworkError('request failed');
    }
}
async function decode(res) {
    let body;
    try {
        body = await res.json();
    }
    catch {
        body = {};
    }
    if (!res.ok)
        throw new HttpError(res.status, String(body.error ?? 'error'));
    return body;
}
export class VercelClient {
    #o;
    constructor(o) {
        this.#o = { fetchImpl: globalThis.fetch.bind(globalThis), now: Date.now, timeoutMs: 20_000, ...o };
    }
    async post(path, payload) {
        const body = JSON.stringify(payload);
        const ts = this.#o.now();
        const nonce = randomNonce();
        const sig = await signRequest(this.#o.vmSignKey, { method: 'POST', path, ts, nonce, body });
        const res = await send(this.#o.fetchImpl, this.#o.baseUrl + path, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.#o.workerToken}`,
                'Content-Type': 'application/json',
                'X-Vesper-Ts': String(ts),
                'X-Vesper-Nonce': nonce,
                'X-Vesper-Sig': sig,
            },
            body,
        }, this.#o.timeoutMs);
        return decode(res);
    }
    pull(max, latched) {
        return this.post('/api/worker/pull', { max, latched });
    }
    resultOk(ticketId, processedAt, outputEnvelopes, outputSig) {
        return this.post('/api/worker/result', { ticket_id: ticketId, ok: true, processed_at: processedAt, output_envelopes: outputEnvelopes, output_sig: outputSig });
    }
    resultFail(ticketId, errorCode) {
        return this.post('/api/worker/result', { ticket_id: ticketId, ok: false, error_code: errorCode });
    }
    deviceAction(item) {
        return this.post('/api/worker/device-approval', item);
    }
    alert(reason, ticketId) {
        return this.post('/api/worker/alert', { rule: 'R8', reason, ...(ticketId ? { ticket_id: ticketId } : {}) });
    }
}
/**
 * First-time registration (`vesper init`): authenticated by the one-time
 * setup token; the request is signed by the VM key being registered (proof
 * of possession).
 */
export async function registerVm(o) {
    const path = '/api/worker/register';
    const body = JSON.stringify({
        setup_token: o.setupToken,
        worker_token: o.workerToken,
        vm: { sign_public_key: o.signPublicJwk, enc_public_key: o.encPublicJwk },
    });
    const ts = (o.now ?? Date.now)();
    const nonce = randomNonce();
    const sig = await signRequest(o.vmSignKey, { method: 'POST', path, ts, nonce, body });
    const res = await send(o.fetchImpl ?? globalThis.fetch.bind(globalThis), o.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vesper-Ts': String(ts), 'X-Vesper-Nonce': nonce, 'X-Vesper-Sig': sig }, body }, 20_000);
    return decode(res);
}
