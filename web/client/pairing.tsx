'use client';

// Pairing (§11.1 steps 3–6): the user compares fingerprints on both screens,
// the device pins the VM public keys it was shown, and then waits for the
// VM-signed approval, which it verifies with the pinned key.

import { useEffect, useRef, useState } from 'react';
import { samePublicJwk, type EcPublicJwk } from '@vesper/core/keys';
import { computeFingerprint } from '@vesper/core/fingerprint';
import { call } from './api.ts';
import { getPinnedVm, pinVm, type Identity, type PinnedVm } from './identity.ts';
import { approvalValid, Fingerprint, type Me } from './ui.tsx';

export interface VmKeys {
  sign_public_key: EcPublicJwk;
  enc_public_key: EcPublicJwk;
  fingerprint: string;
}

const POLL_MS = 3000;

export function Pairing({ identity, vm, onApproved }: { identity: Identity; vm: VmKeys; onApproved: (pinned: PinnedVm) => void }) {
  const [stage, setStage] = useState<'loading' | 'compare' | 'mismatch' | 'waiting' | 'bad_approval' | 'error'>('loading');
  const [localFp, setLocalFp] = useState('');
  const [pinned, setPinned] = useState<PinnedVm | null>(null);
  const [same, setSame] = useState(false);
  const [message, setMessage] = useState('');
  const done = useRef(onApproved);
  useEffect(() => {
    done.current = onApproved;
  });

  // Never display the fingerprint string Vercel sent: recompute it from the keys.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fp = await computeFingerprint(vm.sign_public_key, vm.enc_public_key);
        if (cancelled) return;
        if (fp !== vm.fingerprint) {
          setMessage('Vercel 送来的 VM 指纹和公钥不相符。不要继续，请检查 Vercel 部署。');
          return setStage('error');
        }
        setLocalFp(fp);
        const p = await getPinnedVm();
        if (p && samePublicJwk(p.signJwk, vm.sign_public_key) && samePublicJwk(p.encJwk, vm.enc_public_key)) {
          setPinned(p);
          return setStage('waiting');
        }
        setStage('compare');
      } catch {
        if (!cancelled) {
          setMessage('VM 公钥格式无效。不要继续。');
          setStage('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vm]);

  // Wait for the VM's approval, then verify its signature with the pinned key.
  useEffect(() => {
    if (stage !== 'waiting' || !pinned) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await call<Me>(identity, 'GET', '/api/devices/me');
        if (stopped) return;
        if (r.ok && r.json.vm_approved_at) {
          if (await approvalValid(identity, pinned, r.json)) return done.current(pinned);
          return setStage('bad_approval');
        }
        if (r.status === 401) {
          setMessage('会话已失效，请重新整理页面。');
          return setStage('error');
        }
      } catch {
        // network hiccup: keep polling
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [stage, pinned, identity]);

  async function confirmSame() {
    try {
      setPinned(await pinVm(vm));
      setStage('waiting');
    } catch {
      setMessage('无法保存 VM 公钥。');
      setStage('error');
    }
  }

  switch (stage) {
    case 'loading':
      return <p className="muted">载入中…</p>;
    case 'error':
      return (
        <section className="banner danger">
          <p>{message}</p>
        </section>
      );
    case 'mismatch':
      return (
        <section className="banner danger">
          <h2>指纹不一致：停止</h2>
          <p>这台设备收到的 VM 公钥不是你 VM 上的那一把。可能有人冒充 VM，或者 Vercel 上的资料被改过。不要继续设置。</p>
          <p>请保留现场，检查 Vercel 部署和 VM 的 vesper init 输出。</p>
          <button className="secondary" onClick={() => setStage('compare')}>
            我看错了，重新比对
          </button>
        </section>
      );
    case 'compare':
      return (
        <section className="card">
          <h2>第一步：比对 VM 指纹</h2>
          <p>
            在笔电的 VM 终端执行 <code>sudo -u vesper -i vesper fingerprint</code>（或看 <code>vesper init</code> 的输出），逐组比对下面的 6 组数字：
          </p>
          <Fingerprint label="这台设备收到的 VM 指纹" value={localFp} />
          <label className="inline">
            <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
            <span>6 组数字和 VM 终端显示的完全一致</span>
          </label>
          <div className="actions">
            <button disabled={!same} onClick={confirmSame}>
              一致，保存 VM 公钥
            </button>
            <button className="danger" onClick={() => setStage('mismatch')}>
              不一致
            </button>
          </div>
        </section>
      );
    case 'waiting':
      return (
        <section className="card">
          <h2>第二步：在 VM 上批准这台设备</h2>
          <p>VM 公钥已保存在这台设备上。之后这台设备只信任这一把公钥，不会再从 Vercel 取用。</p>
          <Fingerprint label="本设备指纹" value={identity.fingerprint} />
          <ol>
            <li>
              在 VM 终端执行 <code>sudo -u vesper -i vesper device approve</code>。
            </li>
            <li>终端会显示设备指纹（由 VM 自己计算）。和上面的「本设备指纹」逐组比对。</li>
            <li>一致的话，输入最后一组数字（上面加底线的那组），再输入 yes。</li>
          </ol>
          <p className="hint">worker 每 30 秒更新一次待批准清单。如果终端显示没有待批准的设备，等 30 秒再执行一次。</p>
          <p className="muted">正在等待 VM 批准…（这个页面会自动更新）</p>
        </section>
      );
    case 'bad_approval':
      return (
        <section className="banner danger">
          <h2>批准签名无效</h2>
          <p>Vercel 回报这台设备已被批准，但签名不是由你确认过的 VM 公钥产生的。不要使用这台设备，请在 VM 终端检查（vesper device list）。</p>
        </section>
      );
  }
}
