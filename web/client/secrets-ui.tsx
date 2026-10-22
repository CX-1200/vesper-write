'use client';

// Shows newly generated user secrets exactly once and makes the user prove
// they saved them (last group of each) before the hashes are sent.

import { useState, type FormEvent, type ReactNode } from 'react';
import { formatSecretInput, generateUserSecret } from './secrets.ts';

export type SecretKind = 'recovery_key' | 'break_glass_key' | 'kill_token';

const INFO: Record<SecretKind, { title: string; text: string }> = {
  recovery_key: {
    title: 'Recovery key',
    text: '登记新设备时使用。只能用一次，用过之后要立刻换新。存进密码管理器，或抄在纸上。',
  },
  break_glass_key: {
    title: 'Break-glass key',
    text: '系统被封锁后，在 VM 终端解锁时使用（v2 的 vesper unlock）。离线保存（例如纸本），不要存在这台设备上。',
  },
  kill_token: {
    title: 'Kill token',
    text: '紧急时在任何浏览器打开 /kill 输入它，会立刻封锁整个系统。它只能封锁，不能做其他事。存在紧急时拿得到的地方。',
  },
};

function lastGroup(secret: string): string {
  return secret.split('-').pop() ?? '';
}

export function NewSecrets({
  kinds,
  submitLabel,
  extra,
  onSubmit,
}: {
  kinds: SecretKind[];
  submitLabel: string;
  /** extra form fields rendered above the submit button (e.g. a TOTP code input) */
  extra?: ReactNode;
  onSubmit: (values: Partial<Record<SecretKind, string>>) => Promise<string | null>;
}) {
  const [values] = useState(() => Object.fromEntries(kinds.map((k) => [k, generateUserSecret()])) as Partial<Record<SecretKind, string>>);
  const [typed, setTyped] = useState<Partial<Record<SecretKind, string>>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const allTyped = kinds.every((k) => (typed[k] ?? '').trim().toUpperCase() === lastGroup(values[k]!));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!allTyped || !saved) return;
    setBusy(true);
    setError('');
    const err = await onSubmit(values);
    setBusy(false);
    if (err) setError(err);
  }

  return (
    <form onSubmit={submit}>
      <p>下面的内容只会显示这一次。服务器只保存它们的哈希，无法帮你找回。</p>
      <p className="small muted">只会出现大写字母 A–Z 和数字 2–7，<strong>没有数字 0、1、8、9</strong>：看起来像 0 的是字母 O，像 1 的是字母 I。抄写时请照这个规则；输入时打成 0 或 1 也会自动换成 O 和 I。</p>
      {kinds.map((k) => (
        <div key={k}>
          <h3>{INFO[k].title}</h3>
          <p className="small muted">{INFO[k].text}</p>
          <div className="secret-box">{values[k]}</div>
        </div>
      ))}
      <fieldset>
        <legend>确认已存好</legend>
        {kinds.map((k) => (
          <div key={k}>
            <label htmlFor={`confirm-${k}`}>{INFO[k].title} 的最后 4 个字符</label>
            <input
              id={`confirm-${k}`}
              className="code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={4}
              value={typed[k] ?? ''}
              onChange={(e) => setTyped({ ...typed, [k]: formatSecretInput(e.target.value) })}
            />
            {(typed[k] ?? '').length === 4 && typed[k] !== lastGroup(values[k]!) ? (
              <p className="small error">和上面「{INFO[k].title}」的最后 4 个字符不一样，请再对照一次。</p>
            ) : null}
          </div>
        ))}
        <label className="inline">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>我已经把上面每一组都存好了</span>
        </label>
      </fieldset>
      {extra}
      {error ? <p className="error">{error}</p> : null}
      {!allTyped || !saved ? <p className="small muted">填对每一组的最后 4 个字符并打勾后，才能按下面的按钮。</p> : null}
      <div className="actions">
        <button type="submit" disabled={!allTyped || !saved || busy}>
          {busy ? '处理中…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
