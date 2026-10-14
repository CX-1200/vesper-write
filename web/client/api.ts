// Every API call from the PWA is signed with this device's key (§8.4):
// signature over METHOD | path+query | ts | nonce | sha256(body).
// The session cookie is HttpOnly; JavaScript never sees it.

import { randomNonce } from '@vesper/core/encoding';
import { signRequest } from '@vesper/core/sign';
import type { Identity } from './identity.ts';

export interface ApiResult<T = any> {
  status: number;
  ok: boolean;
  json: T;
}

export class ApiError extends Error {
  status: number;
  code: string;
  info: Record<string, unknown>;
  constructor(status: number, code: string, info: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    this.info = info;
  }
}

export interface CallOptions {
  /** send this exact string as the body (used for the canonical ticket body) */
  raw?: string;
  ts?: number;
  headers?: Record<string, string>;
  /** sign with this identity instead of the stored one (setup/enroll, before it is stored) */
  identity?: Identity;
}

/** A signed request; returns the raw Response (used directly for the CSV export). */
export async function fetchSigned(identity: Identity, method: 'GET' | 'POST', path: string, body?: unknown, o: CallOptions = {}): Promise<Response> {
  const raw = o.raw ?? (body === undefined ? '' : JSON.stringify(body));
  const ts = o.ts ?? Date.now();
  const nonce = randomNonce();
  const sig = await signRequest(identity.sign.privateKey, { method, path, ts, nonce, body: raw });
  return fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(raw ? { 'Content-Type': 'application/json' } : {}),
      'X-Vesper-Device': identity.id,
      'X-Vesper-Ts': String(ts),
      'X-Vesper-Nonce': nonce,
      'X-Vesper-Sig': sig,
      ...(o.headers ?? {}),
    },
    ...(method === 'POST' ? { body: raw } : {}),
  });
}

export async function call<T = any>(identity: Identity, method: 'GET' | 'POST', path: string, body?: unknown, o: CallOptions = {}): Promise<ApiResult<T>> {
  const res = await fetchSigned(identity, method, path, body, o);
  let json: any = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: 'bad_response' };
  }
  return { status: res.status, ok: res.ok, json };
}

export function toError(r: ApiResult): ApiError {
  const info = (r.json ?? {}) as Record<string, unknown>;
  return new ApiError(r.status, String(info.error ?? 'error'), info);
}

/** Like `call`, but throws ApiError for non-2xx responses. */
export async function api<T = any>(identity: Identity, method: 'GET' | 'POST', path: string, body?: unknown, o: CallOptions = {}): Promise<T> {
  const r = await call<T>(identity, method, path, body, o);
  if (!r.ok) throw toError(r);
  return r.json;
}

/** Human-readable message for the common failures (never echoes server details). */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'unauthorized':
        return e.info.login ? '需要重新登录。' : '请求被拒绝（认证失败）。';
      case 'forbidden':
        return e.info.pending_approval ? '这台设备还没有被 VM 批准。' : e.info.frozen ? '这个会话已被冻结。' : '没有权限。';
      case 'locked':
        return 'Vesper 已封锁。';
      case 'rate_limited':
        return '请求太频繁，或这个来源已被暂时封锁（15 分钟）。';
      case 'daily_cap':
        return '今天的需求已达上限。';
      case 'expired':
        return '这个任务已过期。';
      case 'weak_password':
        return '密码至少 12 个字符。';
      case 'push_endpoint_not_allowed':
        return '这个推送服务不在允许清单内。';
      case 'setup_complete':
        return '首次设置已经完成过了。';
      case 'setup_not_ready':
        return 'VM 还没有登记（请先在 VM 上执行 vesper init）。';
      case 'not_ready':
        return '还不能执行这一步（前面的步骤尚未完成）。';
      case 'not_found':
        return '找不到这笔资料。';
      case 'conflict':
        return '状态已经改变，请重新整理。';
      case 'payload_too_large':
        return '内容太长。';
      case 'bad_request':
        return '请求格式不正确。';
      default:
        return `操作失败（${e.code}）。`;
    }
  }
  return '网络错误，请稍后再试。';
}
