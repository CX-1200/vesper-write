'use client';

// First-time setup (§11.1). The setup token lives only in this page's memory.

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { CONFIG } from '@vesper/core/config';
import { call, describeError, toError, type ApiResult } from '../../client/api.ts';
import { idbPut } from '../../client/idb.ts';
import { createIdentity, forgetDevice, getPinnedVm, loadIdentity, persistIdentity, requestPersistentStorage, STORAGE_ERROR, type Identity } from '../../client/identity.ts';
import { Pairing, type VmKeys } from '../../client/pairing.tsx';
import { defaultDeviceName, groupSecret, isIos, isStandalone } from '../../client/platform.ts';
import { NewSecrets } from '../../client/secrets-ui.tsx';
import { approvalValid, Page, type Me } from '../../client/ui.tsx';

type Step =
  | { s: 'loading' }
  | { s: 'already' }
  | { s: 'locked' }
  | { s: 'error'; message: string }
  | { s: 'intro'; identity: Identity | null; sessionLost?: boolean }
  | { s: 'resume'; identity: Identity; me: Me }
  | { s: 'totp'; identity: Identity; secret: string; vm: VmKeys }
  | { s: 'pair'; identity: Identity; vm: VmKeys }
  | { s: 'secrets'; identity: Identity }
  | { s: 'done' };

const PROGRESS: Record<Step['s'], number> = { loading: 0, already: 5, locked: 0, error: 0, intro: 1, resume: 2, totp: 2, pair: 3, secrets: 4, done: 5 };

function setupError(r: ApiResult): string {
  const e = toError(r);
  if (r.status === 401) return 'Setup token 不正确。（10 分钟内失败 5 次，这个来源会被封锁 15 分钟）';
  if (e.code === 'setup_complete') return '首次设置已经完成。要加入这台设备，请改用 recovery key 登记。';
  if (e.code === 'setup_not_ready') return 'VM 还没登记：请先在 VM 上执行 vesper init。';
  if (e.code === 'conflict') return '已经有设备被 VM 批准了。请先登录，再回到这一页继续。';
  if (e.code === 'not_ready') return e.info.need === 'vm_approval' ? 'VM 还没批准这台设备。' : 'TOTP 还没确认。';
  return describeError(e);
}

export default function SetupPage() {
  const [step, setStep] = useState<Step>({ s: 'loading' });
  const [token, setToken] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const identity = await loadIdentity();
        if (!identity) return setStep({ s: 'intro', identity: null });
        const r = await call<Me>(identity, 'GET', '/api/devices/me');
        if (r.status === 423) return setStep({ s: 'locked' });
        if (r.status === 401) return setStep({ s: 'intro', identity, sessionLost: true });
        if (!r.ok) return setStep({ s: 'error', message: describeError(toError(r)) });
        const me = r.json;
        if (me.setup_complete) return setStep({ s: 'already' });
        // The TOTP secret is shown only once; if it was never confirmed, start over.
        if (!me.totp_confirmed) return setStep({ s: 'intro', identity });
        setStep({ s: 'resume', identity, me });
      } catch {
        setStep({ s: 'error', message: '无法读取本机密钥，或连接失败。' });
      }
    })();
  }, []);

  return (
    <Page title="首次设置" nav={false}>
      <div className="steps" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={PROGRESS[step.s] >= n ? 'done' : ''} />
        ))}
      </div>
      <Body step={step} setStep={setStep} token={token} setToken={setToken} />
    </Page>
  );
}

function Body({ step, setStep, token, setToken }: { step: Step; setStep: (s: Step) => void; token: string; setToken: (t: string) => void }) {
  switch (step.s) {
    case 'loading':
      return <p className="muted">载入中…</p>;
    case 'locked':
      return (
        <section className="banner danger">
          <p>Vesper 目前是封锁状态，不能进行设置。</p>
        </section>
      );
    case 'error':
      return (
        <section className="banner danger">
          <p>{step.message}</p>
        </section>
      );
    case 'already':
      return (
        <section className="card">
          <h2>这台设备已经完成设置</h2>
          <p>
            <Link className="button" href="/">
              回到首页
            </Link>
          </p>
        </section>
      );
    case 'intro':
      return <Intro step={step} setStep={setStep} token={token} setToken={setToken} />;
    case 'resume':
      return <Resume step={step} setStep={setStep} token={token} setToken={setToken} />;
    case 'totp':
      return <Totp step={step} setStep={setStep} token={token} />;
    case 'pair':
      return <Pairing identity={step.identity} vm={step.vm} onApproved={() => setStep({ s: 'secrets', identity: step.identity })} />;
    case 'secrets':
      return (
        <section className="card">
          <h2>设定三组备用 secret</h2>
          <NewSecrets
            kinds={['recovery_key', 'break_glass_key', 'kill_token']}
            submitLabel="完成设置"
            onSubmit={async (v) => {
              const r = await call(
                step.identity,
                'POST',
                '/api/setup',
                { step: 'set_secrets', setup_token: token.trim(), recovery_key: v.recovery_key, break_glass_key: v.break_glass_key, kill_token: v.kill_token },
                { headers: { 'x-vesper-setup-step': 'set_secrets' } },
              );
              if (!r.ok) return setupError(r);
              await requestPersistentStorage();
              setToken('');
              setStep({ s: 'done' });
              return null;
            }}
          />
        </section>
      );
    case 'done':
      return (
        <section className="card">
          <h2>设置完成</h2>
          <p>接下来：</p>
          <ol>
            <li>到 Vercel 删除 SETUP_TOKEN 这个环境变量（它已经失效，删掉更干净），然后重新部署。</li>
            <li>到「设置」开启推送通知。</li>
            <li>（可选）在「设置」登记 passkey。</li>
            <li>记住紧急封锁的网址：这个网站的 /kill。</li>
          </ol>
          <p>
            <Link className="button" href="/">
              开始使用
            </Link>
          </p>
        </section>
      );
  }
}

function Intro({ step, setStep, token, setToken }: { step: Extract<Step, { s: 'intro' }>; setStep: (s: Step) => void; token: string; setToken: (t: string) => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [iosBrowser, setIosBrowser] = useState(false);

  useEffect(() => {
    setName(step.identity?.name || defaultDeviceName());
    setIosBrowser(isIos() && !isStandalone());
  }, [step.identity]);

  async function begin(e: FormEvent) {
    e.preventDefault();
    setError('');
    const deviceName = name.trim();
    if (token.trim().length < 32) return setError('Setup token 至少 32 个字符。');
    if (!deviceName) return setError('请输入设备名称。');
    if (password.length < CONFIG.passwordMinLength) return setError(`密码至少 ${CONFIG.passwordMinLength} 个字符。`);
    if (password !== password2) return setError('两次输入的密码不一样。');
    setBusy(true);
    try {
      let identity = step.identity;
      if (!identity) {
        identity = await createIdentity(deviceName);
        try {
          await persistIdentity(identity);
        } catch {
          await forgetDevice().catch(() => {});
          return setError(STORAGE_ERROR);
        }
      } else if (identity.name !== deviceName) {
        await idbPut('device:name', deviceName);
        identity = { ...identity, name: deviceName };
      }
      const r = await call(
        identity,
        'POST',
        '/api/setup',
        {
          step: 'begin',
          setup_token: token.trim(),
          password,
          device: { id: identity.id, name: deviceName, sign_public_key: identity.signJwk, enc_public_key: identity.encJwk },
        },
        { headers: { 'x-vesper-setup-step': 'begin' } },
      );
      if (!r.ok) return setError(setupError(r));
      setPassword('');
      setPassword2('');
      setStep({ s: 'totp', identity, secret: r.json.totp.secret, vm: r.json.vm });
    } catch {
      setError('网络错误，请稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>开始设置</h2>
      {iosBrowser ? (
        <div className="banner warn">
          <p>
            你正在 Safari 里开启。iPhone 请先按「分享 → 添加到主屏幕」，再从主屏幕的 Vesper 图示打开，然后才开始设置：主屏幕 App 的存储和 Safari 是分开的，在这里产生的密钥，主屏幕 App 用不到。
          </p>
        </div>
      ) : null}
      {step.sessionLost ? (
        <div className="banner info">
          <p>这台设备之前开始过设置，但会话已过期。</p>
          <p>
            如果还没有任何设备被 VM 批准，可以直接重新开始（会产生新的 TOTP 密钥，旧的那组请从验证器删除）。如果这台设备已被 VM 批准，请先<Link href="/login?next=/setup">登录</Link>再回来继续。
          </p>
        </div>
      ) : null}
      <p className="small muted">
        这一步会在这台设备上产生两把不可导出的密钥（签名用、加密用），只有公钥会送到服务器。
      </p>
      <form onSubmit={begin}>
        <label htmlFor="token">Setup token（你在 Vercel 设定的 SETUP_TOKEN）</label>
        <input id="token" type="password" className="secret" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        <label htmlFor="name">设备名称</label>
        <input id="name" type="text" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="pw">登录密码（至少 {CONFIG.passwordMinLength} 个字符）</label>
        <input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label htmlFor="pw2">再输入一次</label>
        <input id="pw2" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
        {error ? <p className="error">{error}</p> : null}
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? '处理中…' : '下一步'}
          </button>
        </div>
      </form>
    </section>
  );
}

function Totp({ step, setStep, token }: { step: Extract<Step, { s: 'totp' }>; setStep: (s: Step) => void; token: string }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!/^\d{6}$/.test(code.trim())) return setError('请输入 6 位数字。');
    setBusy(true);
    try {
      const r = await call(step.identity, 'POST', '/api/setup', { step: 'confirm_totp', setup_token: token.trim(), code: code.trim() }, { headers: { 'x-vesper-setup-step': 'confirm_totp' } });
      if (!r.ok) return setError(r.status === 401 ? '验证码不正确，请等下一组数字再试。' : setupError(r));
      setStep({ s: 'pair', identity: step.identity, vm: step.vm });
    } catch {
      setError('网络错误，请稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>绑定 TOTP 验证器</h2>
      <p>
        请在<strong>另一台设备</strong>上的验证器 App（另一支手机、平板，或密码管理器的 TOTP 功能）新增账号，手动输入下面的密钥。
      </p>
      <p className="small muted">不要把 TOTP 放在这台设备上：这台设备遗失时，密码和 TOTP 才不会一起落入别人手里。这组密钥只显示这一次。</p>
      <div className="secret-box">{groupSecret(step.secret)}</div>
      <dl className="kv small">
        <dt>发行者</dt>
        <dd>Vesper</dd>
        <dt>类型</dt>
        <dd>基于时间（TOTP）</dd>
        <dt>设定</dt>
        <dd>6 位数、30 秒、SHA-1（大多数 App 的默认值）</dd>
      </dl>
      <form onSubmit={confirm}>
        <label htmlFor="code">验证器现在显示的 6 位数</label>
        <input id="code" className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
        {error ? <p className="error">{error}</p> : null}
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? '确认中…' : '确认'}
          </button>
        </div>
      </form>
    </section>
  );
}

function Resume({ step, setStep, token, setToken }: { step: Extract<Step, { s: 'resume' }>; setStep: (s: Step) => void; token: string; setToken: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (token.trim().length < 32) return setError('Setup token 至少 32 个字符。');
    setBusy(true);
    try {
      if (!step.me.vm_approved_at) {
        const r = await call(step.identity, 'GET', '/api/vm');
        if (!r.ok) return setError(setupError(r));
        if (!r.json.registered) return setError('VM 还没登记：请先在 VM 上执行 vesper init。');
        return setStep({ s: 'pair', identity: step.identity, vm: r.json });
      }
      const pinned = await getPinnedVm();
      if (!pinned || !(await approvalValid(step.identity, pinned, step.me))) {
        return setError('这台设备没有可以验证 VM 批准签名的 VM 公钥。请在 VM 上撤销这台设备，清除这台设备的资料后重新设置。');
      }
      setStep({ s: 'secrets', identity: step.identity });
    } catch {
      setError('网络错误，请稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>继续首次设置</h2>
      <p>这台设备已经开始设置，TOTP 也已确认。请再输入一次 setup token 以继续。</p>
      <form onSubmit={go}>
        <label htmlFor="token">Setup token</label>
        <input id="token" type="password" className="secret" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        {error ? <p className="error">{error}</p> : null}
        <div className="actions">
          <button type="submit" disabled={busy}>
            继续
          </button>
        </div>
      </form>
    </section>
  );
}
