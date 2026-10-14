// Small hand-written validators (no schema library dependency). Every value
// that crosses a trust boundary (HTTP body, DB row from Vercel on the VM,
// decrypted plaintext) goes through one of these.

import { canonicalJson, isCanonicalJson } from './canonical.ts';
import { CONFIG } from './config.ts';
import { UUID_RE } from './encoding.ts';
import { parseEnvelope, type Envelope, type Target } from './envelope.ts';
import { parsePublicJwk, type EcPublicJwk } from './keys.ts';
import { parseLintHits, type LintHit } from './lint.ts';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

type Obj = Record<string, unknown>;

export function asObject(v: unknown, what = 'body'): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(`${what} must be an object`);
  return v as Obj;
}

export function exactKeys(o: Obj, allowed: readonly string[], what = 'body'): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ValidationError(`${what}: unexpected field ${k}`);
}

export function str(v: unknown, name: string, opts: { min?: number; max?: number; re?: RegExp } = {}): string {
  if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`);
  const { min = 0, max = 10_000, re } = opts;
  if (v.length < min || v.length > max) throw new ValidationError(`${name} has an invalid length`);
  if (re && !re.test(v)) throw new ValidationError(`${name} has an invalid format`);
  return v;
}

export function int(v: unknown, name: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new ValidationError(`${name} must be an integer`);
  if (opts.min !== undefined && v < opts.min) throw new ValidationError(`${name} too small`);
  if (opts.max !== undefined && v > opts.max) throw new ValidationError(`${name} too large`);
  return v;
}

export function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new ValidationError(`${name} must be a boolean`);
  return v;
}

export function oneOf<T extends string>(v: unknown, name: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new ValidationError(`${name} is not allowed`);
  return v as T;
}

export function uuid(v: unknown, name: string): string {
  return str(v, name, { re: UUID_RE, min: 36, max: 36 });
}

export function jwk(v: unknown, name: string): EcPublicJwk {
  try {
    return parsePublicJwk(v);
  } catch (e) {
    throw new ValidationError(`${name}: ${(e as Error).message}`);
  }
}

export function envelope(v: unknown, name: string): Envelope {
  try {
    return parseEnvelope(v);
  } catch (e) {
    throw new ValidationError(`${name}: ${(e as Error).message}`);
  }
}

export const TARGETS = ['claude_ai', 'claude_code'] as const satisfies readonly Target[];
export const TICKET_TYPE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const DEVICE_NAME_MAX = 40;

export function deviceName(v: unknown): string {
  const name = str(v, 'name', { min: 1, max: DEVICE_NAME_MAX }).trim();
  // eslint-disable-next-line no-control-regex
  if (!name || /[\u0000-\u001f\u007f<>]/.test(name)) throw new ValidationError('name has invalid characters');
  return name;
}

// ---- POST /api/tickets body ---------------------------------------------------

export interface TicketCreateBody {
  id: string;
  type: string;
  target: Target;
  device_id: string;
  ts: number;
  input_envelope: Envelope;
}

const TICKET_BODY_KEYS = ['id', 'type', 'target', 'device_id', 'ts', 'input_envelope'] as const;

/** The exact bytes the device signs and the VM later re-hashes (§8.4). */
export function canonicalTicketBody(b: TicketCreateBody): string {
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
export function parseTicketCreateBody(raw: string): TicketCreateBody {
  if (!isCanonicalJson(raw)) throw new ValidationError('ticket body must be canonical JSON');
  const o = asObject(JSON.parse(raw));
  exactKeys(o, TICKET_BODY_KEYS);
  const body: TicketCreateBody = {
    id: uuid(o.id, 'id'),
    type: str(o.type, 'type', { re: TICKET_TYPE_RE }),
    target: oneOf(o.target, 'target', TARGETS),
    device_id: uuid(o.device_id, 'device_id'),
    ts: int(o.ts, 'ts', { min: 0 }),
    input_envelope: envelope(o.input_envelope, 'input_envelope'),
  };
  if (canonicalTicketBody(body) !== raw) throw new ValidationError('ticket body is not reconstructible');
  return body;
}

// ---- plaintexts ---------------------------------------------------------------

export interface InputPlaintext {
  raw_input: string;
}

export function parseInputPlaintext(v: unknown): InputPlaintext {
  const o = asObject(v, 'input plaintext');
  exactKeys(o, ['raw_input'], 'input plaintext');
  return { raw_input: str(o.raw_input, 'raw_input', { min: 1, max: CONFIG.maxRawInputChars }) };
}

export interface OutputPlaintext {
  prompt: string;
  lint: LintHit[];
  model: string;
  raw_input: string;
  truncated: boolean;
  limits: { max_chars: number; typical_chars: number | null };
}

export function parseOutputPlaintext(v: unknown): OutputPlaintext {
  const o = asObject(v, 'output plaintext');
  exactKeys(o, ['prompt', 'lint', 'model', 'raw_input', 'truncated', 'limits'], 'output plaintext');
  const limits = asObject(o.limits, 'limits');
  exactKeys(limits, ['max_chars', 'typical_chars'], 'limits');
  let lint: LintHit[];
  try {
    lint = parseLintHits(o.lint);
  } catch (e) {
    throw new ValidationError((e as Error).message);
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

export function parseOutputEnvelopes(v: unknown): Record<string, Envelope> {
  const o = asObject(v, 'output_envelopes');
  const out: Record<string, Envelope> = {};
  const keys = Object.keys(o);
  if (keys.length === 0 || keys.length > 20) throw new ValidationError('output_envelopes: bad recipient count');
  for (const k of keys) out[uuid(k, 'output_envelopes key')] = envelope(o[k], `output_envelopes.${k}`);
  return out;
}
