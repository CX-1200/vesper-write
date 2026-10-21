'use client';

// Add a device with the recovery key (§11.2). Every registered device gets an
// R2 alert. The new device can do nothing until the VM approves it.

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { call, describeError, toError } from '../../client/api.ts';
import { createIdentity, forgetDevice, loadIdentity, persistIdentity, requestPersistentStorage, STORAGE_ERROR, type Identity } from '../../client/identity.ts';
import { Pairing, type VmKeys } from '../../client/pairing.tsx';
import { defaultDeviceName, isIos, isStandalone } from '../../client/platform.ts';
import { NewSecrets } from '../../client/secrets-ui.tsx';
import { Page, type Me } from '../../client/ui.tsx';
import { SecretInput } from '../../client/secret-input.tsx';

type Step =
  | { s: 'loading' }
  | { s: 'enrolled' }
  | { s: 'stale'; identity: Identity }
  | { s: 'error'; message: string }
  | { s: 'form' }
  | { s: 'pair'; identity: Identity; vm: VmKeys }
  | { s: 'rotate'; identity: Identity }
  | { s: 'done' };

export default function EnrollPage() {
  const [step, setStep] = useState<Step>({ s: 'loading' });

  useEffect(() => {
    (async () => {
      try {
        const identity = await loadIdentity();
        if (!identity) return setStep({ s: 'form' });
        const r = await call<Me>(identity, 'GET', '/api/devices/me');
        if (r.status === 401) return setStep({ s: 'stale', identity });
        if (!r.ok) return setStep({ s: 'error', message: describeError(toError(r)) });
        if (r.json.vm_approved_at) return setStep(r.json.recovery_key_used ? { s: 'rotate', identity } : { s: 'enrolled' });
        const vm = await call(identity, 'GET', '/api/vm');
        if (!vm.ok || !vm.json.registered) return setStep({ s: 'error', message: '无法取得 VM 公钥。' });
        setStep({ s: 'pair', identity, vm: vm.json });
      } catch {
        setStep({ s: 'error', message: '无法读取本机密钥，或连接失败。' });
      }
    })();
  }, []);

  return (
    <Page title="登记新设备" nav={false}>
      <Body step={step} setStep={setStep} />
    </Page>
  );
}

function Body({ step, setStep }: { step: Step; setStep: (s: Step) => void }) {
  switch (step.s) {
    case 'loading':
      return <p className="muted">载入中…</p>;
    case 'error':
      return (
        <section className="banner danger">
          <p>{step.message}</p>
        </section>
      );
    case 'enrolled':
      return (
        <section className="card">
          <h2>这台设备已经登记并获得批准</h2>
          <p>
            <Link className="button" href="/">
              回到首页
            </Link>
          </p>
        </section>
      );
    case 'stale':
      return <Stale identity={step.identity} />;
    case 'form':
      return <EnrollForm setStep={setStep} />;
    case 'pair':
      return <Pairing identity={step.identity} vm={step.vm} onApproved={() => setStep({ s: 'rotate', identity: step.identity })} />;
    case 'rotate':
      return <Rotate identity={step.identity} onDone={() => setStep({ s: 'done' })} />;
    case 'done':
      return (
        <section className="card">
          <h2>完成</h2>
          <p>这台设备已获 VM 批准，新的 recovery key 也已生效。别忘了到「设置」开启推送通知。</p>
          <p>
            <Link className="button" href="/">
              开始使用
            </Link>
          </p>
        </section>
      );
  }
}

function Stale({ identity }: { identity: Identity }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="card">
      <h2>这台设备上有旧的密钥</h2>
      <p>这台设备之前登记过（{identity.name}），但现在没有有效的会话。</p>
      <p>
        如果它还能用，请直接<Link href="/login">登录</Link>。
      </p>
      <p>
        如果它已经在 VM 上被撤销，或要重新配对（§11.5）：先在 VM 终端执行 <code>sudo -u vesper -i vesper device revoke {identity.id}</code>，再清除这台设备上的旧密钥，然后重新登记。
      </p>
      <label className="inline">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        <span>我已在 VM 上撤销这台设备的旧记录</span>
      </label>
      <div className="actions">
        <button
          className="danger"
          disabled={!confirm}
          onClick={async () => {
            await forgetDevice();
            location.reload();
          }}
        >
          清除旧密钥
        </button>
      </div>
    </section>
  );
}

function EnrollForm({ setStep }: { setStep: (s: Step) => void }) {
  const [recovery, setRecovery] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [iosBrowser, setIosBrowser] = useState(false);

  useEffect(() => {
    setName(defaultDeviceName());
    setIosBrowser(isIos() && !isStandalone());
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const deviceName = name.trim();
    if (!deviceName) return setError('请输入设备名称。');
    if (recovery.replace(/[\s-]/g, '').length !== 32) return setError('Recovery key 应该是 32 个字符（8 组 × 4）。');
    setBusy(true);
    try {
      const identity = await createIdentity(deviceName);
      try {
        await persistIdentity(identity);
      } catch {
        await forgetDevice().catch(() => {});
        return setError(STORAGE_ERROR);
      }
      const r = await call(identity, 'POST', '/api/devices/enroll/start', {
        recovery_key: recovery,
        device: { id: identity.id, name: deviceName, sign_public_key: identity.signJwk, enc_public_key: identity.encJwk },
      });
      if (!r.ok) {
        // The device was not registered: drop the unused keys so a retry starts clean.
        await forgetDevice().catch(() => {});
        if (r.status === 401) return setError('Recovery key 不正确，或已经用过。（10 分钟内失败 5 次，这个来源会被封锁 15 分钟）');
        return setError(describeError(toError(r)));
      }
      setRecovery('');
      await requestPersistentStorage();
      setStep({ s: 'pair', identity, vm: r.json.vm });
    } catch {
      setError('网络错误，请稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>用 recovery key 登记这台设备</h2>
      {iosBrowser ? (
        <div className="banner warn">
          <p>iPhone 请先「添加到主屏幕」，再从主屏幕的 Vesper 图示打开这一页：主屏幕 App 的存储和 Safari 是分开的。</p>
        </div>
      ) : null}
      <p className="small muted">
        送出后，所有已登记的设备都会收到安全警报（R2）——这是正常的，表示有人在登记新设备。如果你没有在登记设备却收到这个警报，就要提高警觉。
      </p>
      <form onSubmit={submit}>
        <label htmlFor="rk">Recovery key</label>
        <SecretInput id="rk" value={recovery} onChange={setRecovery} />
        <label htmlFor="name">设备名称</label>
        <input id="name" type="text" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        {error ? <p className="error">{error}</p> : null}
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? '处理中…' : '登记'}
          </button>
        </div>
      </form>
    </section>
  );
}

function Rotate({ identity, onDone }: { identity: Identity; onDone: () => void }) {
  const [totp, setTotp] = useState('');
  return (
    <section className="card">
      <h2>换一组新的 recovery key</h2>
      <p>刚才用过的 recovery key 已经失效（只能用一次）。请现在设定新的一组。</p>
      <NewSecrets
        kinds={['recovery_key']}
        submitLabel="保存新的 recovery key"
        extra={
          <>
            <label htmlFor="totp">验证器显示的 6 位数</label>
            <input id="totp" className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} />
          </>
        }
        onSubmit={async (v) => {
          if (!/^\d{6}$/.test(totp.trim())) return '请输入 6 位数的 TOTP。';
          const r = await call(identity, 'POST', '/api/secrets/rotate', { totp: totp.trim(), recovery_key: v.recovery_key });
          if (!r.ok) return r.status === 401 ? 'TOTP 不正确。' : describeError(toError(r));
          onDone();
          return null;
        }}
      />
    </section>
  );
}
