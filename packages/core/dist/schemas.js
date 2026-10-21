// Small hand-written validators (no schema library dependency). Every value
// that crosses a trust boundary (HTTP body, DB row from Vercel on the VM,
// decrypted plaintext) goes through one of these.
import { canonicalJson, isCanonicalJson } from "./canonical.js";
import { CONFIG } from "./config.js";
import { UUID_RE } from "./encoding.js";
import { parseEnvelope } from "./envelope.js";
import { parsePublicJwk } from "./keys.js";
import { parseLintHits } from "./lint.js";
export class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}
export function asObject(v, what = 'body') {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new ValidationError(`${what} must be an object`);
    return v;
}
export function exactKeys(o, allowed, what = 'body') {
    for (const k of Object.keys(o))
        if (!allowed.includes(k))
            throw new ValidationError(`${what}: unexpected field ${k}`);
}
export function str(v, name, opts = {}) {
    if (typeof v !== 'string')
        throw new ValidationError(`${name} must be a string`);
    const { min = 0, max = 10_000, re } = opts;
    if (v.length < min || v.length > max)
        throw new ValidationError(`${name} has an invalid length`);
    if (re && !re.test(v))
        throw new ValidationError(`${name} has an invalid format`);
    return v;
}
export function int(v, name, opts = {}) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v))
        throw new ValidationError(`${name} must be an integer`);
    if (opts.min !== undefined && v < opts.min)
        throw new ValidationError(`${name} too small`);
    if (opts.max !== undefined && v > opts.max)
        throw new ValidationError(`${name} too large`);
    return v;
}
export function bool(v, name) {
    if (typeof v !== 'boolean')
        throw new ValidationError(`${name} must be a boolean`);
    return v;
}
export function oneOf(v, name, values) {
    if (typeof v !== 'string' || !values.includes(v))
        throw new ValidationError(`${name} is not allowed`);
    return v;
}
export function uuid(v, name) {
    return str(v, name, { re: UUID_RE, min: 36, max: 36 });
}
export function jwk(v, name) {
    try {
        return parsePublicJwk(v);
    }
    catch (e) {
        throw new ValidationError(`${name}: ${e.message}`);
    }
}
export function envelope(v, name) {
    try {
        return parseEnvelope(v);
    }
    catch (e) {
        throw new ValidationError(`${name}: ${e.message}`);
    }
}
export const TARGETS = ['claude_ai', 'claude_code'];
export const TICKET_TYPE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const DEVICE_NAME_MAX = 40;
export function deviceName(v) {
    const name = str(v, 'name', { min: 1, max: DEVICE_NAME_MAX }).trim();
    // eslint-disable-next-line no-control-regex
    if (!name || /[\u0000-\u001f\u007f<>]/.test(name))
        throw new ValidationError('name has invalid characters');
    return name;
}
const TICKET_BODY_KEYS = ['id', 'type', 'target', 'device_id', 'ts', 'input_envelope'];
/** The exact bytes the device signs and the VM later re-hashes (§8.4). */
export function canonicalTicketBody(b) {
    return canonicalJson({
        id: b.id,
        type: b.type,
        target: b.target,
        device_id: b.device_id,
        ts: b.ts,
        input_envelope: { v: b.input_envelope.v, alg: b.input_envelope.alg, enc: b.input_envelope.enc, ct: b.input_envelope.ct },
    });
}
/** Parses the raw body and insists it is byte-for-byte canonical, so the VM can rebuild it. */
export function parseTicketCreateBody(raw) {
    if (!isCanonicalJson(raw))
        throw new ValidationError('ticket body must be canonical JSON');
    const o = asObject(JSON.parse(raw));
    exactKeys(o, TICKET_BODY_KEYS);
    const body = {
        id: uuid(o.id, 'id'),
        type: str(o.type, 'type', { re: TICKET_TYPE_RE }),
        target: oneOf(o.target, 'target', TARGETS),
        device_id: uuid(o.device_id, 'device_id'),
        ts: int(o.ts, 'ts', { min: 0 }),
        input_envelope: envelope(o.input_envelope, 'input_envelope'),
    };
    if (canonicalTicketBody(body) !== raw)
        throw new ValidationError('ticket body is not reconstructible');
    return body;
}
export function parseInputPlaintext(v) {
    const o = asObject(v, 'input plaintext');
    exactKeys(o, ['raw_input'], 'input plaintext');
    return { raw_input: str(o.raw_input, 'raw_input', { min: 1, max: CONFIG.maxRawInputChars }) };
}
export function parseOutputPlaintext(v) {
    const o = asObject(v, 'output plaintext');
    exactKeys(o, ['prompt', 'lint', 'model', 'raw_input', 'truncated', 'limits'], 'output plaintext');
    const limits = asObject(o.limits, 'limits');
    exactKeys(limits, ['max_chars', 'typical_chars'], 'limits');
    let lint;
    try {
        lint = parseLintHits(o.lint);
    }
    catch (e) {
        throw new ValidationError(e.message);
    }
    return {
        prompt: str(o.prompt, 'prompt', { max: 200_000 }),
        lint,
        model: str(o.model, 'model', { min: 1, max: 100 }),
        raw_input: str(o.raw_input, 'raw_input', { max: CONFIG.maxRawInputChars }),
        truncated: bool(o.truncated, 'truncated'),
        limits: {
            max_chars: int(limits.max_chars, 'limits.max_chars', { min: 1 }),
            typical_chars: limits.typical_chars === null ? null : int(limits.typical_chars, 'limits.typical_chars', { min: 1 }),
        },
    };
}
// ---- output envelopes map --------------------------------------------------------
export function parseOutputEnvelopes(v) {
    const o = asObject(v, 'output_envelopes');
    const out = {};
    const keys = Object.keys(o);
    if (keys.length === 0 || keys.length > 20)
        throw new ValidationError('output_envelopes: bad recipient count');
    for (const k of keys)
        out[uuid(k, 'output_envelopes key')] = envelope(o[k], `output_envelopes.${k}`);
    return out;
}
