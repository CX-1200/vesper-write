'use client';

// Settings: push notifications (§13), optional passkey (OD2), replacing the
// user secrets, this device's keys, logout.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { api, call, describeError, toError } from '../../client/api.ts';
import { forgetDevice, requestPersistentStorage, type Identity, type PinnedVm } from '../../client/identity.ts';
import { isIos, isStandalone } from '../../client/platform.ts';
import { urlBase64ToUint8Array } from '../../client/secrets.ts';
import { NewSecrets, type SecretKind } from '../../client/secrets-ui.tsx';
import { Fingerprint, Gated, Page, useVesper } from '../../client/ui.tsx';

export default function SettingsPage() {
  const [gate] = useVesper();
  return (
    <Page title="设置">
      <Gated gate={gate}>
        {(g) => (
          <>
            <Push identity={g.identity} />
            <Passkey identity={g.identity} />
            <Rotate identity={g.identity} recoveryUsed={g.me.recovery_key_used} />
            <ThisDevice identity={g.identity} vm={g.vm} />
            <Session identity={g.identity} />
          </>
        )}
      </Gated>
    </Page>
  );
}

function Push({ identity }: { identity: Identity }) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [iosBrowser, setIosBrowser] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    setIos(isIos());
    setIosBrowser(isIos() && !isStandalone());
    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return setStatus('unsupported');
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager.getSubscription();
      setStatus(sub && Notification.permission === 'granted' ? 'on' : Notification.permission === 'denied' ? 'denied' : 'off');
    })().catch(() => setStatus('off'));
  }, []);

  async function enable() {
    setError('');
    setBusy(true);
    try {
      const cfg = await api(identity, 'GET', '/api/config');
      if (!cfg.vapid_public_key) return setError('服务器还没有设定 VAPID 密钥（VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）。');
      if ((await Notification.requestPermission()) !== 'granted') {
        setStatus('denied');
        return setError('没有取得通知权限。');
      }
      const reg = await navigator.serviceWorker.ready;
      const key = urlBase64ToUint8Array(cfg.vapid_public_key);
      let sub = await reg.pushManager.getSubscription();
      const current = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      if (sub && (!current || current.length !== key.length || current.some((b, i) => b !== key[i]))) {
        // The server key changed: the old subscription would be rejected by the push service.
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const j = sub.toJSON();
      await api(identity, 'POST', '/api/push/subscribe', { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } });
      setStatus('on');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>推送通知</h2>
      <p className="small muted">通知只会有固定的几句话（例如「有 1 个任务待审阅」），不会包含任何任务内容。</p>
      {iosBrowser ? (
        <p className="banner warn">iOS 需要先「添加到主屏幕」（Safari 的分享按钮 → 添加到主屏幕），再从主屏幕打开 Vesper，才能收到推送。</p>
      ) : null}
      {status === 'unsupported' ? (
        <p>这个浏览器不支持推送通知。{ios ? '（iOS 需要 16.4 以上，并且要从主屏幕打开。）' : ''}</p>
      ) : status === 'on' ? (
        <p className="banner ok">这台设备已开启推送。</p>
      ) : status === 'denied' ? (
        <p>通知权限被拒绝了。请到系统设定里允许 Vesper 发送通知，再回来按下面的按钮。</p>
      ) : null}
      {status !== 'unsupported' ? (
        <div className="actions">
          <button disabled={busy} onClick={enable}>
            {status === 'on' ? '重新登记推送' : '开启推送'}
          </button>
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

function Passkey({ identity }: { identity: Identity }) {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => setSupported(browserSupportsWebAuthn()), []);

  async function register() {
    setError('');
    setMsg('');
    setBusy(true);
    try {
      const headers = { 'x-vesper-passkey-purpose': 'register' };
      const o = await api(identity, 'POST', '/api/auth/passkey/options', {}, { headers });
      let response;
      try {
        response = await startRegistration({ optionsJSON: o.options });
      } catch {
        return setError('passkey 登记已取消或失败。');
      }
      await api(identity, 'POST', '/api/auth/passkey/verify', { response }, { headers });
      setMsg('passkey 已登记。之后在这台设备上可以用 passkey 代替「密码 + TOTP」登录。');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Passkey（可选）</h2>
      <p className="small muted">passkey 只能代替「密码 + TOTP」，不能代替这台设备的签名：别的设备就算拿到 passkey 也登录不了。</p>
      {supported ? (
        <div className="actions">
          <button className="secondary" disabled={busy} onClick={register}>
            登记 passkey
          </button>
        </div>
      ) : (
        <p>这个浏览器不支持 passkey。</p>
      )}
      {msg ? <p className="banner ok">{msg}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

const KIND_LABEL: Record<SecretKind, string> = { recovery_key: 'Recovery key', break_glass_key: 'Break-glass key', kill_token: 'Kill token' };

function Rotate({ identity, recoveryUsed }: { identity: Identity; recoveryUsed: boolean }) {
  const [kinds, setKinds] = useState<SecretKind[]>(recoveryUsed ? ['recovery_key'] : []);
  const [started, setStarted] = useState(false);
  const [totp, setTotp] = useState('');
  const [done, setDone] = useState('');

  const toggle = (k: SecretKind) => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);

  return (
    <section className="card">
      <h2>更换 recovery key / break-glass key / kill token</h2>
      {recoveryUsed ? <p className="banner warn">Recovery key 已经用过，请换一组新的。</p> : null}
      {done ? <p className="banner ok">{done}</p> : null}
      {!started ? (
        <>
          {(Object.keys(KIND_LABEL) as SecretKind[]).map((k) => (
            <label key={k} className="inline">
              <input type="checkbox" checked={kinds.includes(k)} onChange={() => toggle(k)} />
              <span>{KIND_LABEL[k]}</span>
            </label>
          ))}
          <div className="actions">
            <button
              className="secondary"
              disabled={!kinds.length}
              onClick={() => {
                setDone('');
                setStarted(true);
              }}
            >
              产生新的
            </button>
          </div>
        </>
      ) : (
        <NewSecrets
          key={kinds.join(',')}
          kinds={kinds}
          submitLabel="保存（旧的立即失效）"
          extra={
            <>
              <label htmlFor="rotate-totp">验证器显示的 6 位数</label>
              <input id="rotate-totp" className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} />
            </>
          }
          onSubmit={async (v) => {
            if (!/^\d{6}$/.test(totp.trim())) return '请输入 6 位数的 TOTP。';
            const r = await call(identity, 'POST', '/api/secrets/rotate', { totp: totp.trim(), ...v });
            if (!r.ok) return r.status === 401 ? 'TOTP 不正确。' : describeError(toError(r));
            setTotp('');
            setStarted(false);
            setKinds([]);
            setDone('已更换。旧的那几组已经失效。');
            return null;
          }}
        />
      )}
    </section>
  );
}

function ThisDevice({ identity, vm }: { identity: Identity; vm: PinnedVm }) {
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    navigator.storage
      ?.persisted?.()
      .then(setPersisted)
      .catch(() => setPersisted(null));
  }, []);
  return (
    <section className="card">
      <h2>这台设备</h2>
      <Fingerprint label="本设备指纹" value={identity.fingerprint} />
      <Fingerprint label="配对时确认的 VM 指纹" value={vm.fingerprint} />
      <p className="small">
        私钥存在这个浏览器的 IndexedDB，设定为不可导出：网页程序可以用它签名和解密，但读不出私钥本身。
        {persisted === true ? '存储已设为持久。' : persisted === false ? '存储还不是持久的，浏览器在空间不足时可能清除它。' : ''}
      </p>
      {persisted === false ? (
        <div className="actions">
          <button className="secondary" onClick={async () => setPersisted(await requestPersistentStorage())}>
            要求持久存储
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Session({ identity }: { identity: Identity }) {
  const [forget, setForget] = useState(false);
  const [error, setError] = useState('');

  async function logout() {
    setError('');
    const r = await call(identity, 'POST', '/api/auth/logout', {}).catch(() => null);
    if (r && !r.ok && r.status !== 401) return setError(describeError(toError(r)));
    location.href = '/login';
  }

  async function wipe() {
    await call(identity, 'POST', '/api/auth/logout', {}).catch(() => null);
    await forgetDevice();
    location.href = '/';
  }

  return (
    <section className="card">
      <h2>会话</h2>
      <div className="actions">
        <button className="secondary" onClick={logout}>
          登出
        </button>
        <Link className="button secondary" href="/kill">
          紧急封锁（kill switch）
        </Link>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <h3>清除这台设备的密钥</h3>
      <p className="small muted">清除后这台设备就无法再登录，要用 recovery key 重新登记。请先在另一台设备的「设备」页和 VM 终端撤销它。</p>
      {forget ? (
        <div className="banner danger">
          <p>确定要清除？这个动作无法复原。</p>
          <div className="actions">
            <button className="danger" onClick={wipe}>
              确定清除
            </button>
            <button className="secondary" onClick={() => setForget(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button className="secondary" onClick={() => setForget(true)}>
            清除密钥…
          </button>
        </div>
      )}
    </section>
  );
}
