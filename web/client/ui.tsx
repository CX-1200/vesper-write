'use client';

// Shared UI: the session gate, navigation, and small display components.
// No inline style attributes anywhere (the CSP forbids them); only classes.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { importVerifyKey } from '@vesper/core/keys';
import { approvalSigningString, verifyString } from '@vesper/core/sign';
import { formatLocal } from '@vesper/core/time';
import { call } from './api.ts';
import { getPinnedVm, loadIdentity, type Identity, type PinnedVm } from './identity.ts';

export interface Me {
  id: string;
  name: string;
  fingerprint: string;
  vm_approved_at: number | null;
  vm_approval_sig: string | null;
  setup_complete: boolean;
  totp_confirmed: boolean;
  recovery_key_used: boolean;
  system_state: string;
}

export type Gate =
  | { status: 'loading' }
  | { status: 'no_identity' }
  | { status: 'login'; identity: Identity }
  | { status: 'locked'; state: string }
  | { status: 'pending'; identity: Identity; vm: PinnedVm | undefined; me: Me }
  | { status: 'error'; message: string }
  | { status: 'ready'; identity: Identity; vm: PinnedVm; me: Me };

/** Verify the VM's signed approval of THIS device with the VM key pinned at pairing. */
export async function approvalValid(identity: Identity, vm: PinnedVm, me: Me): Promise<boolean> {
  if (!me.vm_approved_at || !me.vm_approval_sig) return false;
  return verifyString(
    await importVerifyKey(vm.signJwk),
    approvalSigningString({ deviceId: identity.id, fingerprint: identity.fingerprint, approvedAt: me.vm_approved_at }),
    me.vm_approval_sig,
  );
}

export function useVesper(): [Gate, () => void] {
  const [gate, setGate] = useState<Gate>({ status: 'loading' });
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const identity = await loadIdentity();
        if (!identity) return setGate({ status: 'no_identity' });
        const r = await call<Me>(identity, 'GET', '/api/devices/me');
        if (r.status === 401) return setGate({ status: 'login', identity });
        if (r.status === 423) return setGate({ status: 'locked', state: String((r.json as unknown as { state?: string })?.state ?? 'LOCKDOWN') });
        if (!r.ok) return setGate({ status: 'error', message: `无法读取设备状态（${r.status}）` });
        const vm = await getPinnedVm();
        const me = r.json;
        if (!me.vm_approved_at || !vm) return setGate({ status: 'pending', identity, vm, me });
        if (!(await approvalValid(identity, vm, me))) {
          return setGate({ status: 'error', message: 'VM 对这台设备的批准签名验证失败。不要继续使用，请在 VM 终端检查。' });
        }
        if (!cancelled) setGate({ status: 'ready', identity, vm, me });
      } catch {
        if (!cancelled) setGate({ status: 'error', message: '无法读取本机密钥或连接失败。' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [n]);
  return [gate, reload];
}

/** Renders the right screen for every non-ready state; children only when ready. */
export function Gated({ gate, children }: { gate: Gate; children: (g: Extract<Gate, { status: 'ready' }>) => ReactNode }) {
  switch (gate.status) {
    case 'loading':
      return <p className="muted">载入中…</p>;
    case 'no_identity':
      return (
        <section className="card">
          <h2>这台设备还没有设置</h2>
          <p>第一次使用 Vesper：</p>
          <p>
            <Link className="button" href="/setup">
              首次设置
            </Link>
          </p>
          <p>已经有其他设备在用，要加入这台：</p>
          <p>
            <Link className="button secondary" href="/enroll">
              用 recovery key 登记新设备
            </Link>
          </p>
        </section>
      );
    case 'login':
      return (
        <section className="card">
          <h2>需要登录</h2>
          <p>
            <Link className="button" href="/login">
              登录
            </Link>
          </p>
        </section>
      );
    case 'locked':
      return (
        <section className="banner danger">
          <h2>Vesper 已封锁（{gate.state}）</h2>
          <p>所有会话都已撤销，worker 不会处理任何任务。</p>
          <p>解锁只能在 VM 终端进行（v2：vesper unlock + break-glass key）。</p>
        </section>
      );
    case 'pending':
      return (
        <section className="card">
          <h2>等待 VM 批准</h2>
          <p>这台设备已登记，但 VM 还没有批准它。</p>
          <Fingerprint label="本设备指纹" value={gate.me.fingerprint} />
          <p>
            在 VM 终端执行 <code>sudo -u vesper -i vesper device approve</code>，比对指纹后，输入上面最后一组数字。
          </p>
          <p>
            <Link className="button secondary" href={gate.me.setup_complete ? '/enroll?resume=1' : '/setup?resume=1'}>
              回到配对步骤
            </Link>
          </p>
        </section>
      );
    case 'error':
      return (
        <section className="banner danger">
          <p>{gate.message}</p>
        </section>
      );
    case 'ready':
      return <>{children(gate)}</>;
  }
}

const NAV = [
  ['/', '首页'],
  ['/new', '新需求'],
  ['/devices', '设备'],
  ['/audit', '日志'],
  ['/settings', '设置'],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="主选单">
      {NAV.map(([href, label]) => (
        <Link key={href} href={href} aria-current={path === href ? 'page' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function Fingerprint({ label, value }: { label: string; value: string }) {
  return (
    <div className="fingerprint">
      <div className="fp-label">{label}</div>
      <div className="fp-value" aria-label={label}>
        {value.split(' ').map((g, i) => (
          <span key={i} className={i === 5 ? 'fp-group last' : 'fp-group'}>
            {g}
          </span>
        ))}
      </div>
    </div>
  );
}

export function time(ms: number | null | undefined): string {
  return ms ? formatLocal(ms) : '—';
}

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  processing: '处理中',
  awaiting_review: '待审阅',
  used: '已使用',
  rejected: '已拒绝',
  expired: '已过期',
  failed: '失败',
  stale: '排队超时',
  frozen: '已冻结',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Page({ title, children, nav = true, wide = false }: { title: string; children: ReactNode; nav?: boolean; wide?: boolean }) {
  return (
    <>
      <header className="topbar">
        <h1>{title}</h1>
      </header>
      <div className={wide ? 'content wide' : 'content'}>{children}</div>
      {nav ? <Nav /> : null}
    </>
  );
}
