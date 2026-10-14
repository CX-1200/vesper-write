import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { lastGroup } from '@vesper/core/fingerprint';
import { generateSigningKeyPair } from '@vesper/core/keys';
import { CONFIG } from '@vesper/core/config';
import { makeHarness } from '../helpers/harness.ts';
import { fullSetup, genUserSecret, login, SimDevice } from '../helpers/scenario.ts';
import { ProcessorError } from '../../worker/src/processor.ts';

const SECRET_TEXT = '帮我写一封请假邮件给 Alice，理由是看牙医';

async function allText(h: ReturnType<typeof makeHarness>): Promise<string> {
  const tables = (await h.sql("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => String(r.name));
  let out = '';
  for (const t of tables) out += JSON.stringify(await h.sql(`SELECT * FROM ${t}`));
  return out;
}

test('round trip: device → encrypted ticket → VM → encrypted prompt → device (signature verified)', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  await phone.req('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });
  const t = await phone.createTicket({ raw: SECRET_TEXT, type: 'writing', target: 'claude_ai' });
  assert.equal(t.status, 201, JSON.stringify(t.json));

  const r = await vm.poll();
  assert.equal(r.kind, 'processed');
  assert.equal(vm.processor.calls[0]?.rawInput, SECRET_TEXT);
  assert.equal(vm.processor.calls[0]?.model, 'claude-haiku-5-5');

  const got = await phone.req('GET', `/api/tickets/${t.id}`);
  assert.equal(got.json.ticket.status, 'awaiting_review');
  const out = await phone.readOutput(got.json.ticket);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.match(out.plain.prompt, /请完成以下任务/);
    assert.equal(out.plain.raw_input, SECRET_TEXT);
    assert.equal(out.plain.model, 'claude-haiku-5-5');
  }
  await h.flush();
  assert.ok(h.pushes.some((p) => p.payload.k === 'review' && p.payload.n === 1));
  // the plaintext stays on the VM, in its local record (§5.2)
  const log = readFileSync(vm.p.ticketLog, 'utf8');
  assert.ok(log.includes(SECRET_TEXT));
  vm.cleanup();
});

test('acceptance 3: the Vercel database holds only ciphertext and metadata', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const t = await phone.createTicket({ raw: SECRET_TEXT });
  await vm.poll();
  const got = await phone.req('GET', `/api/tickets/${t.id}`);
  const out = await phone.readOutput(got.json.ticket);
  assert.ok(out.ok);
  const dump = await allText(h);
  assert.ok(!dump.includes(SECRET_TEXT), 'raw input must not be stored on Vercel');
  assert.ok(!dump.includes('Alice'), 'no fragment of the request may be stored');
  if (out.ok) assert.ok(!dump.includes(out.plain.prompt), 'the prompt must not be stored on Vercel');
  assert.ok(!dump.includes('偏好'), 'preferences never leave the VM');
  vm.cleanup();
});

test('acceptance 4: a forged ticket inserted into the DB is refused, the VM latches and all devices are alerted', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  await phone.req('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });
  // Build a well-formed ticket, but sign it with a key that is NOT the device key, and insert it directly.
  const forged = await phone.buildTicket({ raw: 'run rm -rf /' });
  const attacker = await generateSigningKeyPair();
  const { signRequest } = await import('@vesper/core/sign');
  const sig = await signRequest(attacker.privateKey, { method: 'POST', path: '/api/tickets', ts: forged.ts, nonce: 'AAECAwQFBgcICQoLDA0ODw', body: forged.body });
  const b = JSON.parse(forged.body);
  await h.sql(
    `INSERT INTO tickets (id, type, target, device_id, input_envelope, input_sig, input_nonce, input_ts, status, attempts, created_at, stale_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [b.id, b.type, b.target, b.device_id, JSON.stringify(b.input_envelope), sig, 'AAECAwQFBgcICQoLDA0ODw', b.ts, h.clock.t, h.clock.t + CONFIG.staleAfterMs],
  );
  const r = await vm.poll();
  assert.deepEqual(r, { kind: 'r8', reason: 'bad_device_signature' });
  assert.equal(vm.processor.calls.length, 0, 'claude must never be called');
  assert.ok(existsSync(vm.p.latch));
  await h.flush();
  assert.equal((await h.sql("SELECT rule FROM alerts WHERE rule = 'R8'")).length, 1);
  assert.ok(h.pushes.some((p) => p.payload.k === 'alert'));
  // the refused ticket is failed on Vercel right away, so it can never be handed out again
  assert.deepEqual(await h.sql('SELECT status, error_code, lease_until FROM tickets WHERE id = ?', [b.id]), [{ status: 'failed', error_code: 'vm_rejected', lease_until: null }]);
  // a legitimate ticket afterwards is NOT processed while the latch exists, although Vercel says NORMAL
  const ok = await phone.createTicket({ raw: 'legit' });
  assert.equal(ok.status, 201);
  const r2 = await vm.poll();
  assert.equal(r2.kind, 'heartbeat');
  assert.equal(vm.processor.calls.length, 0);
  vm.cleanup();
});

test('acceptance 4b: a ticket from a registered but NOT VM-approved device triggers R8', async () => {
  const h = makeHarness();
  const { vm, phone, secrets } = await fullSetup(h);
  const laptop = await SimDevice.create(h, 'Laptop');
  const e = await laptop.req('POST', '/api/devices/enroll/start', { recovery_key: secrets.recovery_key, device: laptop.publicKeys });
  laptop.pinVm(e.json.vm);
  // Vercel refuses (not approved) …
  assert.equal((await laptop.createTicket({ raw: 'x' })).status, 403);
  // … so an attacker with DB access inserts it directly, correctly signed by the unapproved key.
  const t = await laptop.buildTicket({ raw: 'x' });
  const { signRequest } = await import('@vesper/core/sign');
  const nonce = 'AAECAwQFBgcICQoLDA0OEA';
  const sig = await signRequest(laptop.sign.privateKey, { method: 'POST', path: '/api/tickets', ts: t.ts, nonce, body: t.body });
  const b = JSON.parse(t.body);
  await h.sql(
    `INSERT INTO tickets (id, type, target, device_id, input_envelope, input_sig, input_nonce, input_ts, status, attempts, created_at, stale_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [b.id, b.type, b.target, b.device_id, JSON.stringify(b.input_envelope), sig, nonce, b.ts, h.clock.t, h.clock.t + CONFIG.staleAfterMs],
  );
  const r = await vm.poll();
  assert.deepEqual(r, { kind: 'r8', reason: 'untrusted_device' });
  assert.equal(vm.processor.calls.length, 0);
  void phone;
  vm.cleanup();
});

test('swapping the ciphertext of two tickets in the DB is detected (signature/AAD binding)', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const a = await phone.createTicket({ raw: 'ticket A' });
  const b = await phone.createTicket({ raw: 'ticket B' });
  const rows = await h.sql('SELECT id, input_envelope FROM tickets');
  const envA = rows.find((r) => r.id === a.id)!.input_envelope as string;
  await h.sql('UPDATE tickets SET input_envelope = ? WHERE id = ?', [envA, b.id]);
  const r = await vm.poll();
  // ticket A (untouched) is processed; ticket B now carries A's ciphertext, which no longer matches B's signature
  assert.deepEqual(r, { kind: 'r8', reason: 'bad_device_signature' });
  assert.deepEqual(vm.processor.calls.map((c) => c.rawInput), ['ticket A']);
  vm.cleanup();
});

test('acceptance 5: an output altered in the DB fails verification on the device and raises an alert', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const t = await phone.createTicket({ raw: SECRET_TEXT });
  const t2 = await phone.createTicket({ raw: 'another one' });
  await vm.poll();
  // (a) tamper with the envelope
  const row = (await h.sql('SELECT output_envelopes FROM tickets WHERE id = ?', [t.id]))[0]!;
  const envs = JSON.parse(String(row.output_envelopes));
  const ct: string = envs[phone.id].ct;
  envs[phone.id].ct = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
  await h.sql('UPDATE tickets SET output_envelopes = ? WHERE id = ?', [JSON.stringify(envs), t.id]);
  const got = await phone.req('GET', `/api/tickets/${t.id}`);
  const res = await phone.readOutput(got.json.ticket);
  assert.deepEqual(res, { ok: false, reason: 'bad_signature' });
  // (b) move a valid signed output from one ticket to another
  const other = (await h.sql('SELECT output_envelopes, output_sig FROM tickets WHERE id = ?', [t2.id]))[0]!;
  const fresh = await phone.createTicket({ raw: 'third' });
  await h.sql("UPDATE tickets SET status = 'awaiting_review', processed_at = ?, expires_at = ?, output_envelopes = ?, output_sig = ? WHERE id = ?", [
    h.clock.t,
    h.clock.t + 3600_000,
    String(other.output_envelopes),
    String(other.output_sig),
    fresh.id,
  ]);
  const moved = await phone.req('GET', `/api/tickets/${fresh.id}`);
  assert.deepEqual(await phone.readOutput(moved.json.ticket), { ok: false, reason: 'bad_signature' });
  // the review page reports it → alert
  await phone.req('POST', `/api/tickets/${t.id}/reviewed`, { signature_ok: false });
  await h.flush();
  assert.equal((await h.sql("SELECT rule FROM alerts WHERE rule = 'tamper'")).length, 1);
  vm.cleanup();
});

test('acceptance 7: kill switch → worker latches; flipping the DB back to NORMAL does not resume processing', async () => {
  const h = makeHarness();
  const { vm, phone, secrets, totpSecret } = await fullSetup(h);
  await phone.req('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });
  const stranger = await SimDevice.create(h, 'any browser', '203.0.113.5');
  const wrong = await stranger.req('POST', '/api/kill', { kill_token: genUserSecret() }, { noSig: true });
  assert.equal(wrong.status, 401);
  const kill = await stranger.req('POST', '/api/kill', { kill_token: secrets.kill_token }, { noSig: true });
  assert.equal(kill.status, 200);
  assert.equal(kill.json.state, 'KILLED');
  await h.flush();
  assert.ok(h.pushes.some((p) => p.payload.k === 'locked'));
  // all sessions are gone; device endpoints report the lock
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM sessions'))[0]!.n, 0);
  assert.equal((await phone.req('GET', '/api/tickets')).status, 423);
  // the worker learns the state and writes its local latch
  const r = await vm.poll();
  assert.equal(r.kind, 'latched');
  assert.ok(existsSync(vm.p.latch));
  // someone with DB access flips the state back to NORMAL …
  await h.sql("UPDATE system_state SET state = 'NORMAL', trigger_rule = NULL WHERE id = 1");
  phone.cookie = null;
  assert.equal((await login(h, phone, totpSecret)).status, 200);
  assert.equal((await phone.createTicket({ raw: 'after the kill' })).status, 201);
  // … but the VM keeps its latch and processes nothing
  const r2 = await vm.poll();
  assert.equal(r2.kind, 'heartbeat');
  assert.equal(vm.processor.calls.length, 0);
  assert.equal((await h.sql("SELECT status FROM tickets WHERE status = 'pending'")).length, 1);
  vm.cleanup();
});

test('kill token can only set KILLED and nothing else', async () => {
  const h = makeHarness();
  const { vm, phone, secrets } = await fullSetup(h);
  // the kill token is not a recovery key, not a login credential
  const laptop = await SimDevice.create(h, 'Laptop');
  assert.equal((await laptop.req('POST', '/api/devices/enroll/start', { recovery_key: secrets.kill_token, device: laptop.publicKeys })).status, 401);
  const k = await phone.req('POST', '/api/kill', { kill_token: secrets.kill_token }, { noSig: true });
  assert.equal(k.json.state, 'KILLED');
  const k2 = await phone.req('POST', '/api/kill', { kill_token: secrets.kill_token }, { noSig: true });
  assert.equal(k2.json.state, 'KILLED');
  vm.cleanup();
});

test('acceptance 8: tickets queue while the VM is off; after OD7 (72 h) they become stale', async () => {
  const h = makeHarness();
  const { vm, phone, totpSecret } = await fullSetup(h);
  await phone.req('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });
  const early = await phone.createTicket({ raw: 'made while the PC was off' });
  h.clock.advance(10 * 3600_000); // VM off for 10 hours
  phone.cookie = null;
  assert.equal((await login(h, phone, totpSecret)).status, 200);
  const r = await vm.poll();
  assert.equal(r.kind, 'processed');
  assert.equal((await phone.req('GET', `/api/tickets/${early.id}`)).json.ticket.status, 'awaiting_review');

  const late = await phone.createTicket({ raw: 'will go stale' });
  h.clock.advance(CONFIG.staleAfterMs + 1);
  phone.cookie = null;
  assert.equal((await login(h, phone, totpSecret)).status, 200);
  const list = await phone.req('GET', '/api/tickets');
  assert.equal(list.json.tickets.find((t: any) => t.id === late.id).status, 'stale');
  await h.flush();
  assert.ok(h.pushes.some((p) => p.payload.k === 'stale' && p.payload.n === 1));
  // a stale ticket is never handed to the worker
  const r2 = await vm.poll();
  assert.equal(r2.kind === 'processed' ? r2.processed : 0, 0);
  vm.cleanup();
});

test('awaiting_review expires after 12 h; used and rejected work before that', async () => {
  const h = makeHarness();
  const { vm, phone, totpSecret } = await fullSetup(h);
  const a = await phone.createTicket({ raw: 'a' });
  const b = await phone.createTicket({ raw: 'b' });
  await vm.poll();
  const c = await phone.createTicket({ raw: 'c' });
  await vm.poll();
  assert.equal((await phone.req('POST', `/api/tickets/${a.id}/used`, { lint_high: ['L2', 'L1', 'bogus'] })).status, 200);
  assert.equal((await phone.req('POST', `/api/tickets/${b.id}/reject`, {})).status, 200);
  assert.equal((await phone.req('POST', `/api/tickets/${a.id}/reject`, {})).status, 409);
  const lintAudit = await h.sql("SELECT detail FROM audit_log WHERE event = 'lint.high'");
  assert.deepEqual(JSON.parse(String(lintAudit[0]!.detail)).rules, ['L2']); // high-severity rule ids only
  h.clock.advance(CONFIG.reviewWindowMs + 1);
  phone.cookie = null;
  await login(h, phone, totpSecret);
  const used = await phone.req('POST', `/api/tickets/${c.id}/used`, {});
  assert.equal(used.json.error, 'expired');
  assert.equal((await phone.req('GET', `/api/tickets/${c.id}`)).json.ticket.status, 'expired');
  vm.cleanup();
});

test('lease: a ticket claimed by a worker that dies goes back to pending after 5 minutes', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const t = await phone.createTicket({ raw: 'x' });
  const claimed = await vm.client().pull(1, false); // claim without processing (worker crashed)
  assert.equal(claimed.tickets.length, 1);
  assert.equal((await h.sql('SELECT status FROM tickets WHERE id = ?', [t.id]))[0]!.status, 'processing');
  h.clock.advance(CONFIG.leaseMs + 1);
  const r = await vm.poll();
  assert.equal(r.kind, 'processed');
  const row = (await h.sql('SELECT status, attempts FROM tickets WHERE id = ?', [t.id]))[0]!;
  assert.equal(row.status, 'awaiting_review');
  assert.equal(row.attempts, 2);
  vm.cleanup();
});

test('three failed attempts → failed; failures are reported with a code and no content', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const t = await phone.createTicket({ raw: 'will fail' });
  vm.processor.fail = new ProcessorError('claude_timeout', 'timeout');
  for (let i = 0; i < 3; i++) {
    const r = await vm.poll();
    assert.equal(r.kind, 'processed');
    h.clock.advance(31_000);
  }
  const row = (await h.sql('SELECT status, attempts, error_code FROM tickets WHERE id = ?', [t.id]))[0]!;
  assert.deepEqual({ ...row }, { status: 'failed', attempts: 3, error_code: 'claude_timeout' });
  vm.cleanup();
});

test('R7: a worker request with the right token but a wrong VM signature → LOCKDOWN', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const thiefKey = await generateSigningKeyPair();
  const thief = vm.client(thiefKey.privateKey);
  await assert.rejects(thief.pull(2, false), (e: any) => e.status === 401);
  assert.equal((await h.sql('SELECT state, trigger_rule FROM system_state'))[0]!.state, 'LOCKDOWN');
  assert.equal((await h.sql("SELECT rule FROM alerts WHERE rule = 'R7'")).length, 1);
  assert.equal((await phone.req('GET', '/api/tickets')).status, 423);
  // the real worker now only receives the state and latches
  const r = await vm.poll();
  assert.equal(r.kind, 'latched');
  vm.cleanup();
});

test('a wrong worker token is an ordinary auth failure (no LOCKDOWN — otherwise anyone could lock the system)', async () => {
  const h = makeHarness();
  const { vm } = await fullSetup(h);
  const bad = vm.client(vm.keys.signPrivate, 'x'.repeat(43));
  await assert.rejects(bad.pull(2, false), (e: any) => e.status === 401);
  assert.equal((await h.sql('SELECT state FROM system_state'))[0]!.state, 'NORMAL');
  assert.equal((await h.sql("SELECT event FROM audit_log WHERE event = 'auth.fail.worker_token'")).length, 1);
  vm.cleanup();
});

test('R7: a change of the worker IP only raises an alert', async () => {
  const h = makeHarness();
  const { vm } = await fullSetup(h);
  vm.ip = '203.0.113.77';
  const r = await vm.poll();
  assert.equal(r.kind, 'processed');
  assert.equal((await h.sql("SELECT rule FROM alerts WHERE rule = 'R7_ip'")).length, 1);
  assert.equal((await h.sql('SELECT state FROM system_state'))[0]!.state, 'NORMAL');
  vm.cleanup();
});

test('ticket creation rules: canonical body, matching signer and ts, known type, daily cap (OD6)', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const t = await phone.buildTicket({ raw: 'x' });
  const o = JSON.parse(t.body);
  const nonCanonical = JSON.stringify({ type: o.type, ...o });
  assert.equal((await phone.req('POST', '/api/tickets', undefined, { raw: nonCanonical + ' ', ts: t.ts })).status, 400);
  assert.equal((await phone.req('POST', '/api/tickets', undefined, { raw: t.body, ts: t.ts + 1 })).status, 400);
  const unknown = await phone.buildTicket({ raw: 'x', type: 'shell' });
  assert.equal((await phone.req('POST', '/api/tickets', undefined, { raw: unknown.body, ts: unknown.ts })).status, 400);
  // daily cap
  for (let i = 0; i < CONFIG.dailyTicketCap; i++) assert.equal((await phone.createTicket({ raw: `n${i}` })).status, 201, `ticket ${i}`);
  const over = await phone.createTicket({ raw: 'one too many' });
  assert.equal(over.status, 429);
  assert.equal(over.json.error, 'daily_cap');
  vm.cleanup();
});

test('a device revoked on the VM while its ticket is queued: the VM skips it without R8', async () => {
  const h = makeHarness();
  const { vm, phone, secrets } = await fullSetup(h);
  const laptop = await SimDevice.create(h, 'Laptop');
  const e = await laptop.req('POST', '/api/devices/enroll/start', { recovery_key: secrets.recovery_key, device: laptop.publicKeys });
  laptop.pinVm(e.json.vm);
  await vm.poll();
  await vm.approve(laptop.id, lastGroup(laptop.fingerprint));
  await vm.poll();
  const t = await laptop.createTicket({ raw: 'queued' });
  assert.equal(t.status, 201);
  // revoke locally; the worker has NOT yet delivered it, and Vercel still hands out the ticket
  const { untrustDevice } = await import('../../worker/src/trust.ts');
  await untrustDevice(vm.p, laptop.id, h.clock.t);
  const r = await vm.poll();
  assert.equal(r.kind, 'processed');
  assert.ok(!existsSync(vm.p.latch));
  assert.equal((await h.sql('SELECT error_code FROM tickets WHERE id = ?', [t.id]))[0]!.error_code, 'device_revoked');
  void phone;
  vm.cleanup();
});
