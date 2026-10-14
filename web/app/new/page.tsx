'use client';

// New ticket. The text is encrypted on this device with the pinned VM key
// (HPKE, AAD = ticket id | type | target | device | ts) before it leaves the
// page; Vercel only ever receives the envelope. Nothing is saved as a draft.

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { CONFIG } from '@vesper/core/config';
import type { Target } from '@vesper/core/envelope';
import { api, call, describeError, toError } from '../../client/api.ts';
import type { Identity, PinnedVm } from '../../client/identity.ts';
import { TARGET_LABEL } from '../../client/labels.ts';
import { buildTicket } from '../../client/tickets.ts';
import { Gated, Page, useVesper } from '../../client/ui.tsx';

export default function NewTicketPage() {
  const [gate] = useVesper();
  return (
    <Page title="新需求">
      <Gated gate={gate}>{(g) => <NewTicket identity={g.identity} vm={g.vm} />}</Gated>
    </Page>
  );
}

function NewTicket({ identity, vm }: { identity: Identity; vm: PinnedVm }) {
  const router = useRouter();
  const [types, setTypes] = useState<{ key: string; label: string }[]>([]);
  const [maxChars, setMaxChars] = useState<number>(CONFIG.maxRawInputChars);
  const [type, setType] = useState('general');
  const [target, setTarget] = useState<Target>('claude_ai');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api(identity, 'GET', '/api/config')
      .then((c) => {
        setTypes(c.ticket_types);
        setMaxChars(c.max_raw_input_chars);
        if (c.ticket_types.length && !c.ticket_types.some((t: { key: string }) => t.key === 'general')) setType(c.ticket_types[0].key);
      })
      .catch((e) => setError(describeError(e)));
  }, [identity]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const raw = text.trim();
    if (!raw) return setError('请输入需求内容。');
    if (raw.length > maxChars) return setError(`内容太长（上限 ${maxChars} 字）。`);
    setBusy(true);
    try {
      const t = await buildTicket(identity, vm, { type, target, raw });
      // Send exactly the canonical body that is signed; ts in the body must equal the signed timestamp.
      const r = await call(identity, 'POST', '/api/tickets', undefined, { raw: t.body, ts: t.ts });
      if (!r.ok) {
        const err = toError(r);
        return setError(err.code === 'locked' ? 'Vesper 已封锁，不能开新任务。' : describeError(err));
      }
      setText('');
      router.push('/');
    } catch {
      setError('网络错误，请稍后再试。内容还在上面，没有送出。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <form onSubmit={submit}>
        <label htmlFor="type">类型</label>
        <select id="type" value={type} onChange={(e) => setType(e.target.value)}>
          {types.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <fieldset>
          <legend>prompt 要贴到哪里</legend>
          {(['claude_ai', 'claude_code'] as const).map((v) => (
            <label key={v} className="inline">
              <input type="radio" name="target" value={v} checked={target === v} onChange={() => setTarget(v)} />
              <span>
                {TARGET_LABEL[v]}
                {v === 'claude_code' ? '（会在有 shell 权限的环境执行，审阅时要特别小心）' : ''}
              </span>
            </label>
          ))}
        </fieldset>
        <label htmlFor="text">需求</label>
        <textarea
          id="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={maxChars}
          autoComplete="off"
          placeholder="用自己的话写下需求。可以用键盘上的麦克风听写。"
        />
        <p className="hint">
          {text.length} / {maxChars} 字。内容会先在这台设备上用 VM 公钥加密，Vercel 只看得到密文。
        </p>
        {error ? <p className="error">{error}</p> : null}
        <div className="actions">
          <button type="submit" disabled={busy || !text.trim()}>
            {busy ? '加密并送出中…' : '加密并送出'}
          </button>
        </div>
      </form>
    </section>
  );
}
