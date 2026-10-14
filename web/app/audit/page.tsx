'use client';

// Audit log (§14). Simple view for phones (last 50), full view for computers
// with filters, IP / country / rule columns and CSV export. The log is
// append-only: there is no API to edit or delete entries.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { localDayStart } from '@vesper/core/time';
import { api, describeError, fetchSigned } from '../../client/api.ts';
import type { Identity } from '../../client/identity.ts';
import { eventLabel, RESULT_LABEL, RULE_LABEL } from '../../client/labels.ts';
import { Gated, Page, useVesper } from '../../client/ui.tsx';

interface SimpleRow {
  ts: number;
  time: string;
  event: string;
  result: string;
  device: string;
}

interface FullRow extends SimpleRow {
  id: string;
  actor: string;
  ip: string | null;
  country: string | null;
  rule: string | null;
  detail: Record<string, unknown>;
}

interface Filters {
  event: string;
  result: string;
  from: string;
  to: string;
  q: string;
}

const EMPTY: Filters = { event: '', result: '', from: '', to: '', q: '' };
const DAY_MS = 24 * 3600_000;

/** Turn the filter form into query parameters (dates are Kuala Lumpur days). */
function query(f: Filters): string {
  const p = new URLSearchParams({ view: 'full' });
  if (f.event.trim()) p.set('event', f.event.trim());
  if (f.result) p.set('result', f.result);
  if (f.q.trim()) p.set('q', f.q.trim());
  const day = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? localDayStart(Date.parse(`${s}T12:00:00Z`)) : null);
  const from = day(f.from);
  const to = day(f.to);
  if (from !== null) p.set('from', String(from));
  if (to !== null) p.set('to', String(to + DAY_MS - 1));
  return p.toString();
}

export default function AuditPage() {
  const [gate] = useVesper();
  const [view, setView] = useState<'simple' | 'full'>('simple');
  useEffect(() => {
    // Computers default to the full view.
    if (window.matchMedia?.('(min-width: 900px)').matches) setView('full');
  }, []);
  return (
    <Page title="审计日志" wide={view === 'full'}>
      <Gated gate={gate}>
        {(g) => (
          <>
            <div className="tabs">
              <button aria-pressed={view === 'simple'} onClick={() => setView('simple')}>
                简易
              </button>
              <button aria-pressed={view === 'full'} onClick={() => setView('full')}>
                完整
              </button>
            </div>
            {view === 'simple' ? <Simple identity={g.identity} /> : <Full identity={g.identity} />}
          </>
        )}
      </Gated>
    </Page>
  );
}

function Simple({ identity }: { identity: Identity }) {
  const [rows, setRows] = useState<SimpleRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ rows: SimpleRow[] }>(identity, 'GET', '/api/audit?view=simple')
      .then((r) => setRows(r.rows))
      .catch((e) => setError(describeError(e)));
  }, [identity]);
  if (error) return <p className="error">{error}</p>;
  if (!rows) return <p className="muted">载入中…</p>;
  return (
    <section className="card">
      <ul className="list">
        {rows.map((r, i) => (
          <li key={`${r.ts}-${i}`}>
            <div className="row spread">
              <span>{eventLabel(r.event)}</span>
              <span className={r.result === 'fail' ? 'badge sev-high' : 'badge'}>{RESULT_LABEL[r.result] ?? r.result}</span>
            </div>
            <div className="small muted">
              {r.time} · {r.device}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Full({ identity }: { identity: Identity }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<FullRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setRows(null);
    api<{ rows: FullRow[] }>(identity, 'GET', `/api/audit?${query(applied)}`)
      .then((r) => setRows(r.rows))
      .catch((e) => setError(describeError(e)));
  }, [identity, applied]);
  useEffect(load, [load]);

  function apply(e: FormEvent) {
    e.preventDefault();
    setError('');
    setApplied(filters);
  }

  async function exportCsv() {
    setError('');
    try {
      const res = await fetchSigned(identity, 'GET', `/api/audit?${query(applied)}&format=csv&limit=1000`);
      if (!res.ok) return setError(`导出失败（${res.status}）`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vesper-audit.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError('导出失败。');
    }
  }

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <>
      <section className="card">
        <form onSubmit={apply}>
          <div className="filters">
            <div>
              <label htmlFor="f-event">事件（前缀，例如 auth.fail）</label>
              <input id="f-event" type="search" value={filters.event} onChange={set('event')} />
            </div>
            <div>
              <label htmlFor="f-result">结果</label>
              <select id="f-result" value={filters.result} onChange={set('result')}>
                <option value="">全部</option>
                <option value="ok">成功</option>
                <option value="fail">失败</option>
                <option value="info">信息</option>
              </select>
            </div>
            <div>
              <label htmlFor="f-q">搜索（事件、IP、设备 ID、详情）</label>
              <input id="f-q" type="search" value={filters.q} onChange={set('q')} />
            </div>
            <div>
              <label htmlFor="f-from">从（日期）</label>
              <input id="f-from" type="date" value={filters.from} onChange={set('from')} />
            </div>
            <div>
              <label htmlFor="f-to">到（日期）</label>
              <input id="f-to" type="date" value={filters.to} onChange={set('to')} />
            </div>
          </div>
          <div className="actions">
            <button type="submit">筛选</button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setFilters(EMPTY);
                setApplied(EMPTY);
              }}
            >
              清除
            </button>
            <button type="button" className="secondary" onClick={exportCsv}>
              导出 CSV
            </button>
          </div>
        </form>
        <p className="hint">时间以吉隆坡时间（UTC+8）显示。</p>
      </section>
      {error ? <p className="error">{error}</p> : null}
      <section className="card">
        {!rows ? (
          <p className="muted">载入中…</p>
        ) : rows.length === 0 ? (
          <p className="muted">没有符合的记录。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>事件</th>
                  <th>结果</th>
                  <th>设备</th>
                  <th>IP</th>
                  <th>国家</th>
                  <th>规则</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`result-${r.result}`}>
                    <td className="nowrap">{r.time}</td>
                    <td title={r.event}>{eventLabel(r.event)}</td>
                    <td>{RESULT_LABEL[r.result] ?? r.result}</td>
                    <td>{r.device}</td>
                    <td className="mono">{r.ip ?? ''}</td>
                    <td>{r.country ?? ''}</td>
                    <td title={r.rule ? (RULE_LABEL[r.rule] ?? '') : ''}>{r.rule ?? ''}</td>
                    <td className="detail">{Object.keys(r.detail).length ? JSON.stringify(r.detail) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
