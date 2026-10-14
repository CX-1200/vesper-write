'use client';

// Login (OD2): password + TOTP, or an optional passkey. Both are always
// combined with this device's signature, so a password alone is useless on
// any other device.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { call, describeError, toError, type ApiResult } from '../../client/api.ts';
import { loadIdentity, type Identity } from '../../client/identity.ts';
import { safeNext } from '../../client/platform.ts';
import { Fingerprint, Page } from '../../client/ui.tsx';

function loginError(r: ApiResult): string {
  if (r.status === 401) return '密码或验证码不正确。（10 分钟内失败 5 次，这个来源会被封锁 15 分钟）';
  if (r.status === 423) return 'Vesper 已封锁，暂时不能登录。';
  return describeError(toError(r));
}

export default function LoginPage() {
  const router = useRouter();
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [passkeyOk, setPasskeyOk] = useState(false);

  useEffect(() => {
    loadIdentity()
      .then(setIdentity)
      .catch(() => setIdentity(null));
    setPasskeyOk(browserSupportsWebAuthn());
  }, []);

  function done() {
    router.replace(safeNext(new URLSearchParams(location.search).get('next')));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!identity) return;
    setError('');
    if (!password || !/^\d{6}$/.test(totp.trim())) return setError('请输入密码和 6 位数的验证码。');
    setBusy(true);
    try {
      const r = await call(identity, 'POST', '/api/auth/login', { device_id: identity.id, password, totp: totp.trim() });
      if (!r.ok) return setError(loginError(r));
      setPassword('');
      done();
    } catch {
      setError('网络错误，请稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  async function passkey() {
    if (!identity) return;
    setError('');
    setBusy(true);
    try {
      const headers = { 'x-vesper-passkey-purpose': 'login' };
      const o = await call(identity, 'POST', '/api/auth/passkey/options', { device_id: identity.id }, { headers });
      if (!o.ok) return setError(o.json?.need === 'passkey' ? '这台设备还没有登记 passkey（可在「设置」登记）。' : loginError(o));
      let response;
      try {
        response = await startAuthentication({ optionsJSON: o.json.options });
      } catch {
        return setError('passkey 验证已取消或失败。');
      }
      const v = await call(identity, 'POST', '/api/auth/passkey/verify', { device_id: identity.id, response }, { headers });
      if (!v.ok) return setError(loginError(v));
      done();
    } catch {
      setError('网络错误，请稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  if (identity === undefined) {
    return (
      <Page title="登录" nav={false}>
        <p className="muted">载入中…</p>
      </Page>
    );
  }
  if (identity === null) {
    return (
      <Page title="登录" nav={false}>
        <section className="card">
          <h2>这台设备没有 Vesper 的密钥</h2>
          <p>只有登记过的设备才能登录。</p>
          <div className="actions">
            <Link className="button" href="/setup">
              首次设置
            </Link>
            <Link className="button secondary" href="/enroll">
              用 recovery key 登记
            </Link>
          </div>
        </section>
      </Page>
    );
  }
  return (
    <Page title="登录" nav={false}>
      <section className="card">
        <h2>{identity.name}</h2>
        <Fingerprint label="本设备指纹" value={identity.fingerprint} />
        <form onSubmit={submit}>
          <label htmlFor="pw">密码</label>
          <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <label htmlFor="totp">验证器显示的 6 位数</label>
          <input id="totp" className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} />
          {error ? <p className="error">{error}</p> : null}
          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? '登录中…' : '登录'}
            </button>
            {passkeyOk ? (
              <button type="button" className="secondary" disabled={busy} onClick={passkey}>
                用 passkey 登录
              </button>
            ) : null}
          </div>
        </form>
      </section>
      <p className="small muted center">
        紧急封锁：<Link href="/kill">/kill</Link>
      </p>
    </Page>
  );
}
