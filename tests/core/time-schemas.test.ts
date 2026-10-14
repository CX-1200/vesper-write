import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocal, isInactiveHour, localDayKey, localDayStart, tzOffsetMs } from '@vesper/core/time';
import { canonicalTicketBody, parseTicketCreateBody, parseOutputPlaintext, ValidationError } from '@vesper/core/schemas';
import { notifyText, NOTIFY_KINDS } from '@vesper/core/notify-texts';
import { readFileSync } from 'node:fs';

test('time: Asia/Kuala_Lumpur is UTC+8 and day boundaries are local', () => {
  const ms = Date.UTC(2026, 9, 13, 16, 30); // 2026-10-14 00:30 in KL
  assert.equal(tzOffsetMs(ms), 8 * 3600_000);
  assert.equal(localDayKey(ms), '2026-10-14');
  assert.equal(localDayStart(ms), Date.UTC(2026, 9, 13, 16, 0));
  assert.equal(formatLocal(ms), '2026-10-14 00:30');
  assert.equal(localDayKey(Date.UTC(2026, 9, 13, 15, 59)), '2026-10-13');
});

test('time: inactive hours are 00:00–07:00 local', () => {
  assert.equal(isInactiveHour(Date.UTC(2026, 9, 13, 16, 0)), true); // 00:00 KL
  assert.equal(isInactiveHour(Date.UTC(2026, 9, 13, 22, 59)), true); // 06:59 KL
  assert.equal(isInactiveHour(Date.UTC(2026, 9, 13, 23, 0)), false); // 07:00 KL
  assert.equal(isInactiveHour(Date.UTC(2026, 9, 14, 15, 59)), false); // 23:59 KL
});

const V = JSON.parse(readFileSync(new URL('../fixtures/vesper-vectors.json', import.meta.url), 'utf8'));

test('schemas: ticket body must be canonical and exactly reconstructible', () => {
  const body = parseTicketCreateBody(V.input.body);
  assert.equal(canonicalTicketBody(body), V.input.body);
  const reordered = JSON.stringify({ ...JSON.parse(V.input.body) });
  // JSON.stringify keeps insertion order which is already sorted here; force a non-canonical order:
  const o = JSON.parse(V.input.body);
  const nonCanonical = JSON.stringify({ type: o.type, id: o.id, target: o.target, device_id: o.device_id, ts: o.ts, input_envelope: o.input_envelope });
  assert.throws(() => parseTicketCreateBody(nonCanonical), ValidationError);
  assert.throws(() => parseTicketCreateBody(reordered.replace('"ts":', '"ts": ')), ValidationError);
  const extra = JSON.parse(V.input.body);
  extra.zzz = 1;
  assert.throws(() => parseTicketCreateBody(JSON.stringify(extra)), ValidationError);
  const badTarget = { ...JSON.parse(V.input.body), target: 'shell' };
  assert.throws(() => parseTicketCreateBody(JSON.stringify(badTarget)), ValidationError);
  const badType = { ...JSON.parse(V.input.body), type: 'Bad|Type' };
  assert.throws(() => parseTicketCreateBody(JSON.stringify(badType)), ValidationError);
});

test('schemas: output plaintext validation', () => {
  assert.deepEqual(parseOutputPlaintext(V.output.plaintext).model, 'claude-haiku-5-5');
  assert.throws(() => parseOutputPlaintext({ ...V.output.plaintext, extra: 1 }), ValidationError);
  assert.throws(() => parseOutputPlaintext({ ...V.output.plaintext, lint: [{ rule: 'L0', start: 0, end: 1 }] }), ValidationError);
  assert.throws(() => parseOutputPlaintext({ ...V.output.plaintext, truncated: 'no' }), ValidationError);
});

test('notify texts are the fixed §13 strings and sw.js uses the same table', () => {
  assert.equal(notifyText('review', 1), '有 1 个任务待审阅');
  assert.equal(notifyText('alert'), '安全警报，请在另一台设备上查看');
  assert.equal(notifyText('locked'), 'Vesper 已封锁');
  assert.equal(notifyText('expired', 3), '有 3 个任务已过期');
  assert.equal(notifyText('stale', 2), '有 2 个任务排队超时');
  assert.equal(notifyText('proposal'), '有新的蒸馏提议');
  const sw = readFileSync(new URL('../../web/public/sw.js', import.meta.url), 'utf8');
  for (const k of NOTIFY_KINDS) {
    const sample = notifyText(k, 7);
    const swText = sample.replace('7', '${n}');
    assert.ok(sw.includes(k === 'alert' || k === 'locked' || k === 'proposal' ? sample : swText), `sw.js must contain text for ${k}`);
  }
});
