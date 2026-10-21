'use client';

// Devices (§11.2, §11.3). Revoking here ends the device's sessions on Vercel
// right away; the VM (the trust root) must also be told with
// `vesper device revoke`, otherwise it keeps encrypting outputs for it.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, call, describeError, toError } from '../../client/api.ts';
import type { Identity } from '../../client/identity.ts';
import { Fingerprint, Gated, Page, time, useVesper } from '../../client/ui.tsx';
import { DEVICE_NAME_MAX } from '@vesper/core/schemas';

interface Device {
  id: string;
  name: string;
  fingerprint: string;
  enrolled_at: number;
  enrolled_via: string;
  vm_approved_at: number | null;
  revoked_at: number | null;
  last_seen_at: number | null;
  has_passkey: boolean;
  is_me: boolean;
}

export default function DevicesPage() {
  const [gate] = useVesper();
  return (
    <Page title="设备">
      <Gated gate={gate}>{(g) => <Devices identity={g.identity} vmFingerprint={g.vm.fingerprint} />}</Gated>
    </Page>
  );
}

function Devices({ identity, vmFingerprint }: { identity: Identity; vmFingerprint: string }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<Device | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(() => {
    api<{ devices: Device[] }>(identity, 'GET', '/api/devices')
      .then((r) => setDevices(r.devices))
      .catch((e) => setError(describeError(e)));
  }, [identity]);

  useEffect(load, [load]);

  async function revoke(d: Device) {
    setError('');
    const r = await call(identity, 'POST', `/api/devices/${d.id}/revoke`, {});
    setConfirming(null);
    if (!r.ok) return setError(describeError(toError(r)));
    setRevoked(d);
    load();
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    setError('');
    const r = await call(identity, 'POST', `/api/devices/${renaming.id}/rename`, { name: renaming.name.trim() });
    if (!r.ok) return setError(describeError(toError(r)));
    setRenaming(null);
    load();
  }

  return (
    <>
      {revoked ? (
        <section className="banner warn">
          <h2>还差一步：在 VM 上撤销</h2>
          <p>Vercel 已撤销「{revoked.name}」的会话。VM 是信任根，请在 VM 终端也执行：</p>
          <pre className="mono">sudo -u vesper -i vesper device revoke {revoked.id}</pre>
          <p>之后 VM 才不会再为它加密任何内容。</p>
        </section>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <section className="card">
        <h2>已登记的设备</h2>
        {!devices ? (
          <p className="muted">载入中…</p>
        ) : (
          <ul className="list">
            {devices.map((d) => (
              <li key={d.id}>
                <div className="row spread">
                  <strong>
                    {d.name}
                    {d.is_me ? '（这台）' : ''}
                  </strong>
                  {d.revoked_at ? (
                    <span className="badge status-failed">已撤销</span>
                  ) : d.vm_approved_at ? (
                    <span className="badge status-used">VM 已批准</span>
                  ) : (
                    <span className="badge status-pending">等待 VM 批准</span>
                  )}
                </div>
                <Fingerprint label="设备指纹" value={d.fingerprint} />
                <dl className="kv small">
                  <dt>ID</dt>
                  <dd className="mono">{d.id}</dd>
                  <dt>登记</dt>
                  <dd>
                    {time(d.enrolled_at)}（{d.enrolled_via === 'setup' ? '首次设置' : 'recovery key'}）
                  </dd>
                  <dt>最后活动</dt>
                  <dd>{time(d.last_seen_at)}</dd>
                  {d.revoked_at ? (
                    <>
                      <dt>撤销</dt>
                      <dd>{time(d.revoked_at)}</dd>
                    </>
                  ) : null}
                  <dt>Passkey</dt>
                  <dd>{d.has_passkey ? '有' : '无'}</dd>
                </dl>
                {!d.revoked_at ? (
                  renaming?.id === d.id ? (
                    <form className="actions" onSubmit={rename}>
                      <label htmlFor={`name-${d.id}`} className="small">
                        新名称
                      </label>
                      <input
                        id={`name-${d.id}`}
                        value={renaming.name}
                        maxLength={DEVICE_NAME_MAX}
                        autoFocus
                        onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                      />
                      <button type="submit" disabled={!renaming.name.trim()}>
                        保存
                      </button>
                      <button type="button" className="secondary" onClick={() => setRenaming(null)}>
                        取消
                      </button>
                    </form>
                  ) : (
                    <div className="actions">
                      <button className="secondary" onClick={() => setRenaming({ id: d.id, name: d.name })}>
                        更改名称
                      </button>
                    </div>
                  )
                ) : null}
                {!d.revoked_at && !d.is_me ? (
                  confirming === d.id ? (
                    <div className="banner danger">
                      <p>撤销「{d.name}」？它的会话会立刻失效，排队中的任务会标为失败。</p>
                      <div className="actions">
                        <button className="danger" onClick={() => revoke(d)}>
                          确定撤销
                        </button>
                        <button className="secondary" onClick={() => setConfirming(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="actions">
                      <button className="secondary" onClick={() => setConfirming(d.id)}>
                        撤销这台设备
                      </button>
                    </div>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2>配对时确认的 VM 指纹</h2>
        <Fingerprint label="VM 指纹（存在这台设备上）" value={vmFingerprint} />
      </section>
      <section className="card">
        <h2>新增设备</h2>
        <p>在新设备上打开这个网站的 /enroll，输入 recovery key。所有设备都会收到警报（R2），然后在 VM 终端比对指纹并批准。</p>
        <p className="small muted">设备遗失时：先在这里撤销，再在 VM 终端执行 vesper device revoke。</p>
        <p className="small muted">更改名称只影响这里的显示；VM 终端的 vesper device list 仍显示批准时的名称。</p>
      </section>
    </>
  );
}
