'use client';

// Review (§10, §19 v1 acceptance 2 and 5). The output is shown only if the VM
// signature over ALL output envelopes verifies with the VM key pinned at
// pairing; then this device decrypts its own envelope and runs lint again.
// The marks shown are this device's lint result; a VM/device difference is
// pointed out. Nothing decrypted is stored anywhere.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hasHighSeverity, lintPrompt, LINT_RULES, sameLintResult, type LintHit, type LintRuleId } from '@vesper/core/lint';
import type { OutputPlaintext } from '@vesper/core/schemas';
import { api, call, describeError, toError } from '../../../client/api.ts';
import type { Identity, PinnedVm } from '../../../client/identity.ts';
import { TARGET_LABEL, TICKET_ERROR_LABEL, typeLabel } from '../../../client/labels.ts';
import { openTicketOutput, type OpenResult, type TicketView } from '../../../client/tickets.ts';
import { Gated, Page, StatusBadge, time, useVesper } from '../../../client/ui.tsx';

interface Ticket extends TicketView {
  created_at: number;
  reviewed_at: number | null;
  expires_at: number | null;
  error_code: string | null;
  attempts: number;
}

export default function TicketPage() {
  const [gate] = useVesper();
  const params = useParams<{ id: string }>();
  return (
    <Page title="审阅">
      <Gated gate={gate}>{(g) => <Review key={params.id} id={params.id} identity={g.identity} vm={g.vm} />}</Gated>
    </Page>
  );
}

const SEV_ORDER = { high: 3, medium: 2, low: 1 } as const;

/** Prompt text with every lint hit marked (colour by worst severity) and labelled with its rule ids. */
function Highlighted({ text, hits }: { text: string; hits: LintHit[] }) {
  const spans = hits.filter((h) => h.end > h.start);
  const cuts = new Set<number>([0, text.length]);
  for (const h of spans) {
    cuts.add(h.start);
    cuts.add(h.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: ReactNode[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const seg = text.slice(a, b);
    const covering = spans.filter((h) => h.start <= a && h.end >= b);
    if (!covering.length) {
      out.push(seg);
      continue;
    }
    const worst = covering.reduce((w, h) => (SEV_ORDER[h.severity] > SEV_ORDER[w] ? h.severity : w), covering[0]!.severity);
    const rules = [...new Set(covering.map((h) => h.rule))];
    out.push(
      <mark key={`m${a}`} className={`hit sev-${worst}`} title={rules.join(' ')}>
        {seg}
      </mark>,
    );
    const ending = [...new Set(spans.filter((h) => h.end === b).map((h) => h.rule))];
    if (ending.length) {
      out.push(
        <sup key={`r${b}`} className="rule">
          {ending.join(' ')}
        </sup>,
      );
    }
  }
  return <pre className="prompt-view">{out}</pre>;
}

function LintSummary({ hits }: { hits: LintHit[] }) {
  if (!hits.length) return <p className="muted small">lint 没有标记任何内容。（lint 只是提醒，不代表内容安全。）</p>;
  const counts = new Map<LintRuleId, number>();
  for (const h of hits) counts.set(h.rule, (counts.get(h.rule) ?? 0) + 1);
  const rules = [...counts.keys()].sort();
  return (
    <ul className="lint-list">
      {rules.map((r) => (
        <li key={r}>
          <span className={`badge sev-${LINT_RULES[r].severity === 'high' ? 'high' : LINT_RULES[r].severity}`}>
            {r} · {LINT_RULES[r].severity === 'high' ? '高' : LINT_RULES[r].severity === 'medium' ? '中' : '低'}
          </span>{' '}
          {LINT_RULES[r].title}
          {counts.get(r)! > 1 ? ` ×${counts.get(r)}` : ''}
        </li>
      ))}
    </ul>
  );
}

const OPEN_ERRORS: Record<Exclude<OpenResult, { ok: true }>['reason'], string> = {
  no_output: '',
  bad_signature: 'VM 签名验证失败：输出在 VM 写回之后被改动过。内容不会显示。所有设备都已收到警报。',
  not_for_this_device: '这份输出没有为这台设备加密（这台设备是在任务处理之后才被批准的）。请在开这张任务的设备上审阅。',
  decrypt_failed: '这台设备无法解密这份输出。如果这台设备的密钥曾被重设，请在 VM 上撤销后重新配对。',
  bad_plaintext: '解密后的内容格式不正确，不显示。',
};

function Review({ id, identity, vm }: { id: string; identity: Identity; vm: PinnedVm }) {
  const router = useRouter();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [opened, setOpened] = useState<OpenResult | null>(null);
  const [error, setError] = useState('');
  const reported = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { ticket: t } = await api<{ ticket: Ticket }>(identity, 'GET', `/api/tickets/${encodeURIComponent(id)}`);
        if (cancelled) return;
        setTicket(t);
        const res = await openTicketOutput(identity, vm, t);
        if (cancelled) return;
        setOpened(res);
        if (reported.current) return;
        if (!res.ok && res.reason === 'bad_signature') {
          reported.current = true;
          await call(identity, 'POST', `/api/tickets/${t.id}/reviewed`, { signature_ok: false });
        } else if (res.ok && t.reviewed_at === null) {
          reported.current = true;
          const hits = lintPrompt(res.plain.prompt, { truncated: res.plain.truncated, limits: res.plain.limits });
          const high = [...new Set(hits.filter((h) => h.severity === 'high').map((h) => h.rule))];
          await call(identity, 'POST', `/api/tickets/${t.id}/reviewed`, { signature_ok: true, lint_high: high, mismatch: !sameLintResult(hits, res.plain.lint) });
        }
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, identity, vm]);

  if (error) return <p className="error">{error}</p>;
  if (!ticket || !opened) return <p className="muted">载入并验证中…</p>;

  const header = (
    <section className="card">
      <div className="row spread">
        <strong>
          {typeLabel(ticket.type)} → {TARGET_LABEL[ticket.target] ?? ticket.target}
        </strong>
        <StatusBadge status={ticket.status} />
      </div>
      <div className="small muted">
        开于 {time(ticket.created_at)}
        {ticket.processed_at ? ` · 处理于 ${time(ticket.processed_at)}` : ''}
        {ticket.status === 'awaiting_review' && ticket.expires_at ? ` · ${time(ticket.expires_at)} 过期` : ''}
      </div>
      {ticket.error_code ? <p className="error">失败原因：{TICKET_ERROR_LABEL[ticket.error_code] ?? ticket.error_code}</p> : null}
    </section>
  );

  if (!opened.ok) {
    return (
      <>
        {header}
        {opened.reason === 'no_output' ? (
          <p className="muted">{ticket.status === 'pending' || ticket.status === 'processing' ? 'VM 还没处理这个任务。' : '这个任务没有输出。'}</p>
        ) : (
          <section className="banner danger">
            <p>{OPEN_ERRORS[opened.reason]}</p>
          </section>
        )}
      </>
    );
  }

  return <Opened ticket={ticket} plain={opened.plain} identity={identity} header={header} onDone={() => router.push('/')} />;
}

function Opened({ ticket, plain, identity, header, onDone }: { ticket: Ticket; plain: OutputPlaintext; identity: Identity; header: ReactNode; onDone: () => void }) {
  const [armed, setArmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const hits = useMemo(() => lintPrompt(plain.prompt, { truncated: plain.truncated, limits: plain.limits }), [plain]);
  const mismatch = !sameLintResult(hits, plain.lint);
  const high = hasHighSeverity(hits);
  const isCode = ticket.target === 'claude_code';
  const needsExtraConfirm = isCode && high;
  const open = ticket.status === 'awaiting_review';

  async function copy() {
    if (needsExtraConfirm && !armed) return setArmed(true);
    setArmed(false);
    try {
      await navigator.clipboard.writeText(plain.prompt);
      setCopied(true);
      setNotice(open ? '已复制。贴到 Claude 执行后，回来按「已使用」。' : '已复制。');
    } catch {
      setNotice('无法自动复制，请长按上面的 prompt 手动复制。');
    }
  }

  async function finish(outcome: 'used' | 'reject') {
    setBusy(true);
    try {
      const r = await call(identity, 'POST', `/api/tickets/${ticket.id}/${outcome}`, {});
      if (!r.ok) {
        const e = toError(r);
        setNotice(e.code === 'expired' ? '这个任务已过期，不能再变更状态。' : describeError(e));
        return;
      }
      onDone();
    } catch {
      setNotice('网络错误，请稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {isCode ? (
        <div className="banner danger sticky" role="alert">
          <strong>这段 prompt 会在有 shell 权限的环境执行</strong>
        </div>
      ) : null}
      {header}

      <section className="card">
        <h2>你的原始需求</h2>
        <pre>{plain.raw_input}</pre>
      </section>

      <section className="card">
        <div className="row spread">
          <h2>Prompt</h2>
          <span className="small muted">{plain.model}</span>
        </div>
        {plain.truncated ? <p className="banner warn">输出超过这个类型的长度上限（{plain.limits.max_chars} 字），已被截断。</p> : null}
        <Highlighted text={plain.prompt} hits={hits} />
      </section>

      <section className="card">
        <h2>Lint 标记（本设备的结果）</h2>
        {mismatch ? <p className="banner warn">VM 端的 lint 结果和这台设备的不一致。以这台设备的结果为准；不一致本身也值得留意。</p> : null}
        <LintSummary hits={hits} />
      </section>

      <section className="card">
        {armed ? (
          <div className="banner danger">
            <p>这段 prompt 有高严重度的 lint 标记，而且会在有 shell 权限的环境执行。确定已经逐一看过上面标红的地方了吗？</p>
            <div className="actions">
              <button className="danger" onClick={copy}>
                确定，复制
              </button>
              <button className="secondary" onClick={() => setArmed(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <button className="block" onClick={copy}>
            {copied ? '再复制一次' : '复制 prompt'}
          </button>
        )}
        {notice ? <p className="small">{notice}</p> : null}
        {open ? (
          <div className="actions">
            <button className="secondary" disabled={busy} onClick={() => finish('used')}>
              已使用
            </button>
            <button className="secondary" disabled={busy} onClick={() => finish('reject')}>
              拒绝
            </button>
          </div>
        ) : (
          <p className="small muted">这个任务的状态已经是「{ticket.status}」，不能再变更。</p>
        )}
        <p className="small">
          <Link href="/">回到首页</Link>
        </p>
      </section>
    </>
  );
}
