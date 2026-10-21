'use client';

// Kill switch (§7 exception): only the kill token, no session, no device key,
// so it works from any browser. It can only move the system to KILLED.

import { useState, type FormEvent } from 'react';
import { Page } from '../../client/ui.tsx';
import { SecretInput } from '../../client/secret-input.tsx';

export default function KillPage() {
  const [token, setToken] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (token.replace(/[\s-]/g, '').length !== 32) return setError('Kill token 应该是 32 个字符（8 组 × 4）。');
    if (!armed) return setArmed(true);
    setBusy(true);
    try {
      const res = await fetch('/api/kill', {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kill_token: token }),
      });
      if (res.ok) {
        setToken('');
        return setDone(true);
      }
      setArmed(false);
      setError(res.status === 429 ? '请求太频繁，或这个来源已被暂时封锁。' : 'Kill token 不正确。');
    } catch {
      setError('网络错误，请再试一次。');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Page title="Kill switch" nav={false}>
        <section className="banner danger">
          <h2>Vesper 已封锁（KILLED）</h2>
          <p>所有会话都已撤销。VM 的 worker 下一次连接时会在本地上锁，不再处理任何任务。</p>
          <p>v1 的恢复方式请看 vm-setup/README.md 的「v1 手动恢复」；v2 会改成在 VM 终端用 break-glass key 解锁。</p>
        </section>
      </Page>
    );
  }

  return (
    <Page title="Kill switch" nav={false}>
      <section className="card">
        <h2>紧急封锁</h2>
        <p>输入 kill token，立刻把整个系统设为 KILLED：撤销所有会话，VM 停止处理任务。</p>
        <p className="small muted">这个页面不需要登录，任何浏览器都能用。kill token 只能封锁，不能做其他事。</p>
        <form onSubmit={submit}>
          <label htmlFor="kt">Kill token</label>
          <SecretInput
          id="kt"
          value={token}
          onChange={(v) => {
            setToken(v);
            setArmed(false);
          }}
        />
          {armed ? <p className="banner danger">确定要封锁整个系统吗？再按一次下面的按钮确认。</p> : null}
          {error ? <p className="error">{error}</p> : null}
          <div className="actions">
            <button type="submit" className="danger" disabled={busy}>
              {busy ? '送出中…' : armed ? '确定封锁' : '封锁'}
            </button>
          </div>
        </form>
      </section>
    </Page>
  );
}
