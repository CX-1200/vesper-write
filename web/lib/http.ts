// HTTP helpers. Error responses are deliberately generic (§7: "错误信息对外只
// 回传通用信息"); the precise reason goes only to the audit log.

import type { Env } from './env.ts';

export const MAX_BODY_BYTES = 512 * 1024;

const NO_STORE = {
  'Cache-Control': 'no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...NO_STORE, ...headers } });
}

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'locked'
  | 'payload_too_large'
  | 'server_error'
  // business errors safe to expose after authentication
  | 'daily_cap'
  | 'expired'
  | 'not_ready'
  | 'weak_password'
  | 'setup_complete'
  | 'setup_not_ready'
  | 'push_endpoint_not_allowed';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  locked: 423,
  payload_too_large: 413,
  server_error: 500,
  daily_cap: 429,
  expired: 409,
  not_ready: 409,
  weak_password: 400,
  setup_complete: 409,
  setup_not_ready: 409,
  push_endpoint_not_allowed: 400,
};

export function fail(code: ErrorCode, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json({ error: code, ...extra }, STATUS[code], headers);
}

export class BodyTooLargeError extends Error {}

export async function readBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw new BodyTooLargeError('body too large');
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError('body too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

export function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Client IP. On Vercel, X-Forwarded-For is overwritten by the platform, so it cannot be spoofed. */
export function clientIp(req: Request, env: Pick<Env, 'trustProxyHeaders'>): string {
  if (env.trustProxyHeaders) {
    for (const h of ['x-vercel-forwarded-for', 'x-forwarded-for', 'x-real-ip']) {
      const v = req.headers.get(h);
      if (v) {
        const ip = v.split(',')[0]!.trim();
        if (/^[0-9a-fA-F:.]{2,45}$/.test(ip)) return ip;
      }
    }
  }
  return 'unknown';
}

export function clientCountry(req: Request): string | null {
  const c = req.headers.get('x-vercel-ip-country');
  return c && /^[A-Z]{2}$/.test(c) ? c : null;
}

/** pathname + query string, exactly as signed by the client (§8.4). */
export function signedPath(req: Request): string {
  const u = new URL(req.url);
  return u.pathname + u.search;
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}
