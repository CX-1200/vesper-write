'use client';

// Home: VM status (§13), system state, recent alerts, the ticket list and the
// once-a-day reminder about expired / stale tickets (§6.1).

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { localDayKey } from '@vesper/core/time';
import { CONFIG } from '@vesper/core/config';
import { api, describeError } from '../client/api.ts';
import { vmKeysChanged, type Identity, type PinnedVm } from '../client/identity.ts';
import { ALERT_REASON_LABEL, RULE_LABEL, STATE_LABEL, TARGET_LABEL, TICKET_ERROR_LABEL, typeLabel } from '../client/labels.ts';
import { Gated, Page, StatusBadge, time, useVesper } from '../client/ui.tsx';

interface TicketMeta {
  id: string;
  type: string;
  target: string;
  device_id: string;
  status: string;
  created_at: number;
  processed_at: number | null;
  expires_at: number | null;
  stale_at: number;
  error_code: string | null;
}

interface VmStatus {
  registered: boolean;
  online?: boolean;
  last_seen_at?: number | null;
  latched?: boolean;
  system_state?: string;
}

interface Alert {
  id: string;
  rule: string;
  severity: string;
  ip: string | null;
  country: string | null;
  created_at: number;
  detail: string | null;
}

interface HomeData {
  vm: VmStatus & { keysChanged: boolean };
  tickets: TicketMeta[];
  today: number;
  alerts: Alert[];
  state: string;
}

const REMINDER_KEY = 'vesper:reminded';

/** §6.1: on the first open of each (Kuala Lumpur) day, mention tickets that expired or went stale since the last reminder. */
function dailyReminder(tickets: TicketMeta[], now: number): { expired: number; stale: number } | null {
  let last: { day: string; at: number } | null = null;
  try {
    last = JSON.parse(localStorage.getItem(REMINDER_KEY) ?? 'null');
  } catch {
    last = null;
  }
  const today = localDayKey(now);
  if (last?.day === today) return null;
  const since = last?.at ?? 0;
  const expired = tickets.filter((t) => t.status === 'expired' && (t.expires_at ?? 0) > since).length;
  const stale = tickets.filter((t) => t.status === 'stale' && t.stale_at > since).length;
  try {
    localStorage.setItem(REMINDER_KEY, JSON.stringify({ day: today, at: now }));
  } catch {
    // private mode: the reminder simply shows again next time
  }
  return expired || stale ? { expired, stale } : null;
}

export default function HomePage() {
  const [gate, reload] = useVesper();
  return (
    <Page title="Vesper">
      <Gated gate={gate}>{(g) => <Home identity={g.identity} vm={g.vm} recoveryUsed={g.me.recovery_key_used} onLocked={reload} />}</Gated>
    </Page>
  );
}

function Home({ identity, vm, recoveryUsed, onLocked }: { identity: Identity; vm: PinnedVm; recoveryUsed: boolean; onLocked: () => void }) {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState('');
  const [reminder, setReminder] = useState<{ expired: number; stale: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [vmStatus, list, alerts] = await Promise.all([api(identity, 'GET', '/api/vm'), api(identity, 'GET', '/api/tickets'), api(identity, 'GET', '/api/alerts')]);
      const keysChanged = vmStatus.registered ? vmKeysChanged(vm, vmStatus) : true;
      setData({
        vm: { ...vmStatus, keysChanged },
        tickets: list.tickets,
        today: list.today,
        alerts: alerts.alerts,
        state: alerts.system_state?.state ?? 'NORMAL',
      });
      setReminder((r) => r ?? dailyReminder(list.tickets, list.server_time ?? Date.now()));
      setError('');
    } catch (e) {
      if ((e as { status?: number }).status === 423 || (e as { status?: number }).status === 401) return onLocked();
      setError(describeError(e));
    }
  }, [identity, vm, onLocked]);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 30_000);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">载入中…</p>;

  const review = data.tickets.filter((t) => t.status === 'awaiting_review');
  const others = data.tickets.filter((t) => t.status !== 'awaiting_review');

  return (
    <>
      {data.vm.keysChanged ? (
        <section className="banner danger">
          <h2>VM 公钥和配对时不同</h2>
          <p>Vercel 现在回报的 VM 公钥，不是这台设备配对时确认过的那一把。这台设备会继续只用配对时的公钥，不会改用新的。</p>
          <p>如果你没有重装 VM，可能有人在冒充 VM。请在 VM 终端执行 vesper fingerprint 检查。</p>
        </section>
      ) : null}
      {data.state !== 'NORMAL' ? (
        <section className="banner danger">
          <p>系统状态：{STATE_LABEL[data.state] ?? data.state}</p>
        </section>
      ) : null}
      {recoveryUsed ? (
        <section className="banner warn">
          <p>
            Recovery key 已经用过，现在没有可用的 recovery key。请到<Link href="/settings">设置</Link>换一组新的。
          </p>
        </section>
      ) : null}
      {reminder ? (
        <section className="banner warn">
          <p>
            {reminder.expired ? `有 ${reminder.expired} 个任务已过期。` : ''}
            {reminder.stale ? `有 ${reminder.stale} 个任务排队超时（VM 太久没有上线）。` : ''}
          </p>
          <button className="link" onClick={() => setReminder(null)}>
            知道了
          </button>
        </section>
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      <section className="card">
        <div className="row spread">
          <h2>VM</h2>
          {data.vm.online ? <span className="badge online">在线</span> : <span className="badge offline">离线</span>}
        </div>
        <p className="small">
          {data.vm.online ? '正在运作。' : `最后在线：${time(data.vm.last_seen_at)}。电脑开机后，排队中的任务会自动处理。`}
        </p>
        {data.vm.latched ? <p className="error">VM 已本地上锁（R8 或封锁），不会处理任何任务，只能在 VM 终端处理。</p> : null}
        <p className="small muted">
          今天已开 {data.today} / {CONFIG.dailyTicketCap} 个任务
        </p>
      </section>

      {data.alerts.length ? (
        <section className="card">
          <h2>最近 7 天的安全警报</h2>
          <ul className="list">
            {data.alerts.slice(0, 10).map((a) => (
              <li key={a.id}>
                <div className="row spread">
                  <strong>
                    {a.rule} · {RULE_LABEL[a.rule] ?? a.rule}
                  </strong>
                  <span className={`badge sev-${a.severity === 'high' ? 'high' : 'medium'}`}>{a.severity === 'high' ? '高' : '中'}</span>
                </div>
                <div className="small muted">
                  {time(a.created_at)}
                  {a.detail ? ` · ${ALERT_REASON_LABEL[a.detail] ?? a.detail}` : ''}
                  {a.ip ? ` · ${a.ip}` : ''}
                  {a.country ? ` (${a.country})` : ''}
                </div>
              </li>
            ))}
          </ul>
          <p className="small">
            <Link href="/audit">查看完整日志</Link>
          </p>
        </section>
      ) : null}

      <section className="card">
        <div className="row spread">
          <h2>待审阅</h2>
          <Link className="button" href="/new">
            新需求
          </Link>
        </div>
        {review.length ? <TicketList tickets={review} /> : <p className="muted">目前没有。</p>}
      </section>

      <section className="card">
        <h2>其他任务</h2>
        {others.length ? <TicketList tickets={others} /> : <p className="muted">还没有任务。</p>}
      </section>
    </>
  );
}

function TicketList({ tickets }: { tickets: TicketMeta[] }) {
  return (
    <ul className="list">
      {tickets.map((t) => (
        <li key={t.id}>
          <Link className="item" href={`/t/${t.id}`}>
            <div className="row spread">
              <span>
                {typeLabel(t.type)} → {TARGET_LABEL[t.target] ?? t.target}
              </span>
              <StatusBadge status={t.status} />
            </div>
            <div className="small muted">
              开于 {time(t.created_at)}
              {t.status === 'awaiting_review' && t.expires_at ? ` · ${time(t.expires_at)} 过期` : ''}
              {t.error_code ? ` · ${TICKET_ERROR_LABEL[t.error_code] ?? t.error_code}` : ''}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
