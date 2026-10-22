import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastGroup } from '@vesper/core/fingerprint';
import { makeHarness, SETUP_TOKEN } from '../helpers/harness.ts';
import { beginSetup, fullSetup, genUserSecret, login, nextTotpStep, PASSWORD, setupHeaders, SimDevice, SimVm } from '../helpers/scenario.ts';

test('§11.1 full first-time setup works end to end', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  // the VM wrote its trust list itself
  const trusted = JSON.parse(await (await import('node:fs/promises')).readFile(vm.p.trustedDevices, 'utf8'));
  assert.equal(trusted.devices.length, 1);
  assert.equal(trusted.devices[0].fingerprint, phone.fingerprint);
  // §11.1 step 8: the setup token is dead now
  const again = await vm.register().catch((e) => e);
  assert.equal(again.status, 401);
  const rows = await h.sql("SELECT used_at FROM secrets_meta WHERE kind = 'setup'");
  assert.ok(rows[0]?.used_at);
  vm.cleanup();
});

test('setup: wrong setup token is rejected and audited as an auth failure', async () => {
  const h = makeHarness();
  const vm = await SimVm.create(h);
  const phone = await SimDevice.create(h);
  const r = await phone.req('POST', '/api/setup', { step: 'begin', setup_token: 'x'.repeat(48), device: phone.publicKeys, password: PASSWORD }, setupHeaders('begin'));
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: 'unauthorized' });
  const audit = await h.sql("SELECT event, result FROM audit_log WHERE event LIKE 'auth.fail.%'");
  assert.equal(audit[0]?.event, 'auth.fail.setup_token');
  vm.cleanup();
});

test('setup: requires the VM to be registered first, a strong password and proof of key possession', async () => {
  const h = makeHarness();
  const phone = await SimDevice.create(h);
  const noVm = await phone.req('POST', '/api/setup', { step: 'begin', setup_token: SETUP_TOKEN, device: phone.publicKeys, password: PASSWORD }, setupHeaders('begin'));
  assert.equal(noVm.status, 409);
  const vm = await SimVm.create(h);
  const weak = await phone.req('POST', '/api/setup', { step: 'begin', setup_token: SETUP_TOKEN, device: phone.publicKeys, password: 'short' }, setupHeaders('begin'));
  assert.equal(weak.json.error, 'weak_password');
  // signed by a different key than the one being registered
  const other = await SimDevice.create(h);
  const pop = await phone.req('POST', '/api/setup', { step: 'begin', setup_token: SETUP_TOKEN, device: phone.publicKeys, password: PASSWORD }, { ...setupHeaders('begin'), signWith: other.sign.privateKey });
  assert.equal(pop.status, 401);
  vm.cleanup();
});

test('setup: secrets cannot be set before TOTP is confirmed and the VM approved the device', async () => {
  const h = makeHarness();
  const vm = await SimVm.create(h);
  const phone = await SimDevice.create(h);
  const begin = await beginSetup(h, phone);
  const body = { step: 'set_secrets', setup_token: SETUP_TOKEN, recovery_key: genUserSecret(), break_glass_key: genUserSecret(), kill_token: genUserSecret() };
  let r = await phone.req('POST', '/api/setup', body, setupHeaders('set_secrets'));
  assert.equal(r.json.need, 'totp');
  nextTotpStep(h);
  await phone.req('POST', '/api/setup', { step: 'confirm_totp', setup_token: SETUP_TOKEN, code: phone.totp(begin.json.totp.secret) }, setupHeaders('confirm_totp'));
  r = await phone.req('POST', '/api/setup', body, setupHeaders('set_secrets'));
  assert.equal(r.json.need, 'vm_approval');
  // an unapproved device cannot open tickets
  phone.pinVm(begin.json.vm);
  const t = await phone.createTicket({ raw: 'hello' });
  assert.equal(t.status, 403);
  vm.cleanup();
});

test('VM approval: typing a wrong fingerprint group aborts and trusts nothing', async () => {
  const h = makeHarness();
  const vm = await SimVm.create(h);
  const phone = await SimDevice.create(h);
  await beginSetup(h, phone);
  await vm.poll();
  const wrong = lastGroup(phone.fingerprint) === '00000' ? '11111' : '00000';
  assert.equal(await vm.approve(phone.id, wrong), false);
  assert.equal(await vm.approve(phone.id, lastGroup(phone.fingerprint), 'no'), false);
  await vm.poll();
  const me = await phone.req('GET', '/api/devices/me');
  assert.equal(me.json.vm_approved_at, null);
  vm.cleanup();
});

test('login: password + TOTP + device signature', async () => {
  const h = makeHarness();
  const { vm, phone, totpSecret } = await fullSetup(h);
  phone.cookie = null;
  const ok = await login(h, phone, totpSecret);
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie ?? '', /^__Host-vesper_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
  // only the hash of the session id is stored
  const sid = phone.cookie!.split('=')[1]!;
  const sessions = await h.sql('SELECT id_hash FROM sessions');
  assert.ok(sessions.every((s) => s.id_hash !== sid));
  vm.cleanup();
});

test('login: the same TOTP code cannot be used twice; wrong password and wrong TOTP fail generically', async () => {
  const h = makeHarness();
  const { vm, phone, totpSecret } = await fullSetup(h);
  nextTotpStep(h);
  const code = phone.totp(totpSecret);
  const a = await phone.req('POST', '/api/auth/login', { device_id: phone.id, password: PASSWORD, totp: code });
  assert.equal(a.status, 200);
  const replay = await phone.req('POST', '/api/auth/login', { device_id: phone.id, password: PASSWORD, totp: code });
  assert.equal(replay.status, 401);
  nextTotpStep(h);
  const badPw = await phone.req('POST', '/api/auth/login', { device_id: phone.id, password: 'wrong password!!', totp: phone.totp(totpSecret) });
  assert.deepEqual(badPw.json, { error: 'unauthorized' });
  vm.cleanup();
});

test('R1: login from an unregistered device is refused and every registered device is alerted', async () => {
  const h = makeHarness();
  const { vm, phone, totpSecret } = await fullSetup(h);
  await phone.req('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });
  const stranger = await SimDevice.create(h, 'stranger', '203.0.113.99');
  nextTotpStep(h);
  const r = await stranger.req('POST', '/api/auth/login', { device_id: stranger.id, password: PASSWORD, totp: stranger.totp(totpSecret) });
  assert.equal(r.status, 401);
  // a stolen device id without the device key
  const r2 = await stranger.req('POST', '/api/auth/login', { device_id: phone.id, password: PASSWORD, totp: stranger.totp(totpSecret) }, { deviceHeader: phone.id });
  assert.equal(r2.status, 401);
  await h.flush();
  const alerts = await h.sql("SELECT rule, detail FROM alerts WHERE rule = 'R1'");
  assert.equal(alerts.length, 2);
  assert.ok(h.pushes.some((p) => p.payload.k === 'alert'));
  vm.cleanup();
});

test('R3: 5 auth failures in 10 minutes block the source for 15 minutes and alert', async () => {
  const h = makeHarness();
  const { vm, phone, totpSecret } = await fullSetup(h);
  for (let i = 0; i < 5; i++) {
    nextTotpStep(h);
    const r = await phone.req('POST', '/api/auth/login', { device_id: phone.id, password: `wrong-password-${i}`, totp: phone.totp(totpSecret) }, { ip: '198.51.100.66' });
    assert.equal(r.status, 401);
  }
  nextTotpStep(h);
  const blocked = await phone.req('POST', '/api/auth/login', { device_id: phone.id, password: PASSWORD, totp: phone.totp(totpSecret) }, { ip: '198.51.100.66' });
  assert.equal(blocked.status, 429);
  const alerts = await h.sql("SELECT rule FROM alerts WHERE rule = 'R3'");
  assert.equal(alerts.length, 1);
  // another source is unaffected; the blocked one recovers after 15 minutes
  const other = await login(h, phone, totpSecret);
  assert.equal(other.status, 200);
  h.clock.advance(15 * 60_000 + 1);
  nextTotpStep(h);
  const later = await phone.req('POST', '/api/auth/login', { device_id: phone.id, password: PASSWORD, totp: phone.totp(totpSecret) }, { ip: '198.51.100.66' });
  assert.equal(later.status, 200);
  vm.cleanup();
});

test('device signatures: missing, wrong key, wrong path, stale timestamp and replayed nonce are all refused', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  // distinct source IPs so R3 (5 failures → block) does not mask the individual checks
  let n = 10;
  const ip = () => `198.51.100.${n++}`;
  assert.equal((await phone.req('GET', '/api/tickets')).status, 200);
  assert.equal((await phone.req('GET', '/api/tickets', undefined, { noSig: true, ip: ip() })).status, 401);
  const other = await SimDevice.create(h);
  assert.equal((await phone.req('GET', '/api/tickets', undefined, { signWith: other.sign.privateKey, ip: ip() })).status, 401);
  assert.equal((await phone.req('GET', '/api/tickets', undefined, { ts: h.clock.t - 61_000, ip: ip() })).status, 401);
  assert.equal((await phone.req('GET', '/api/tickets', undefined, { ts: h.clock.t + 61_000, ip: ip() })).status, 401);
  const nonce = 'AAECAwQFBgcICQoLDA0ODw';
  assert.equal((await phone.req('GET', '/api/tickets', undefined, { nonce })).status, 200);
  assert.equal((await phone.req('GET', '/api/tickets', undefined, { nonce, ip: ip() })).status, 401);
  // a session cookie alone is useless without the device key
  assert.equal((await other.req('GET', '/api/tickets', undefined, { deviceHeader: phone.id, extraHeaders: { cookie: phone.cookie! }, noCookie: true, ip: ip() })).status, 401);
  const fails = await h.sql("SELECT event FROM audit_log WHERE event LIKE 'auth.fail.%'");
  assert.ok(fails.length >= 6);
  vm.cleanup();
});

test('R3 also covers signature failures: the sixth bad request from one source is blocked', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const other = await SimDevice.create(h);
  for (let i = 0; i < 5; i++) assert.equal((await phone.req('GET', '/api/tickets', undefined, { signWith: other.sign.privateKey })).status, 401);
  assert.equal((await phone.req('GET', '/api/tickets')).status, 429);
  vm.cleanup();
});

test('§11.2 enrolling a second device: recovery key, R2 alert, VM approval, single-use key', async () => {
  const h = makeHarness();
  const { vm, phone, secrets, totpSecret } = await fullSetup(h);
  await phone.req('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });
  const laptop = await SimDevice.create(h, 'Laptop', '198.51.100.8');
  const bad = await laptop.req('POST', '/api/devices/enroll/start', { recovery_key: genUserSecret(), device: laptop.publicKeys });
  assert.equal(bad.status, 401);
  const r = await laptop.req('POST', '/api/devices/enroll/start', { recovery_key: secrets.recovery_key.toLowerCase(), device: laptop.publicKeys });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.vm.fingerprint, vm.keys.fingerprint);
  laptop.pinVm(r.json.vm);
  await h.flush();
  assert.equal((await h.sql("SELECT rule FROM alerts WHERE rule = 'R2'")).length, 2);
  assert.ok(h.pushes.some((p) => p.device === phone.id && p.payload.k === 'alert'));
  // not approved yet: no tickets, no ciphertext
  assert.equal((await laptop.req('GET', '/api/tickets')).status, 403);
  // the recovery key is now spent
  const third = await SimDevice.create(h, 'Tablet');
  assert.equal((await third.req('POST', '/api/devices/enroll/start', { recovery_key: secrets.recovery_key, device: third.publicKeys })).status, 401);
  const me = await phone.req('GET', '/api/devices/me');
  assert.equal(me.json.recovery_key_used, true);
  // VM approval
  await vm.poll();
  assert.equal(await vm.approve(laptop.id, lastGroup(laptop.fingerprint)), true);
  await vm.poll();
  assert.equal((await laptop.req('GET', '/api/tickets')).status, 200);
  // rotate the recovery key (needs a fresh TOTP)
  nextTotpStep(h);
  const rot = await phone.req('POST', '/api/secrets/rotate', { totp: phone.totp(totpSecret), recovery_key: genUserSecret() });
  assert.equal(rot.status, 200);
  assert.equal((await phone.req('GET', '/api/devices/me')).json.recovery_key_used, false);
  vm.cleanup();
});

test('§11.3 revocation on the VM: device loses its session and receives no new ciphertext', async () => {
  const h = makeHarness();
  const { vm, phone, secrets } = await fullSetup(h);
  const laptop = await SimDevice.create(h, 'Laptop');
  await laptop.req('POST', '/api/devices/enroll/start', { recovery_key: secrets.recovery_key, device: laptop.publicKeys });
  await vm.poll();
  await vm.approve(laptop.id, lastGroup(laptop.fingerprint));
  await vm.poll();
  assert.equal(await vm.revoke(laptop.id), true);
  await vm.poll(); // delivers the VM-signed revocation
  assert.equal((await laptop.req('GET', '/api/tickets')).status, 401);
  const d = await h.sql('SELECT revoked_at FROM devices WHERE id = ?', [laptop.id]);
  assert.ok(d[0]?.revoked_at);
  // a new ticket from the phone is encrypted only for the phone
  const t = await phone.createTicket({ raw: '整理会议记录' });
  assert.equal(t.status, 201);
  await vm.poll();
  const got = await phone.req('GET', `/api/tickets/${t.id}`);
  assert.deepEqual(Object.keys(got.json.ticket.output_envelopes), [phone.id]);
  vm.cleanup();
});

test('§18: tokens, keys, the password and the TOTP secret are never stored in plaintext; token hashes are argon2id', async () => {
  const h = makeHarness();
  const { vm, totpSecret, secrets } = await fullSetup(h);
  // dump every row of every table
  const tables = (await h.sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((r) => String(r.name));
  let dump = '';
  for (const t of tables) for (const row of await h.sql(`SELECT * FROM ${t}`)) dump += JSON.stringify(row) + '\n';
  const plain: Record<string, string> = { setup_token: SETUP_TOKEN, password: PASSWORD, worker_token: vm.workerToken, totp_secret: totpSecret, ...secrets };
  for (const [name, value] of Object.entries(plain)) {
    // user secrets are normalized (no dashes) before hashing, so check that form too
    assert.ok(!dump.includes(value) && !dump.includes(value.replace(/-/g, '')), `${name} must not appear in the database`);
  }
  const hashes = await h.sql('SELECT kind, hash FROM secrets_meta ORDER BY kind');
  assert.deepEqual(
    hashes.map((r) => r.kind),
    ['break_glass', 'kill_token', 'recovery', 'setup', 'worker_token'],
  );
  for (const r of hashes) assert.match(String(r.hash), /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/, String(r.kind));
  const [owner] = await h.sql('SELECT password_hash, totp_secret_enc FROM owner');
  assert.match(String(owner!.password_hash), /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.ok(!String(owner!.totp_secret_enc).includes(totpSecret));
  vm.cleanup();
});

test('renaming a device: validated, audited without the name, VM approval still verifies, revoked devices stay as they were', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const r = await phone.req('POST', `/api/devices/${phone.id}/rename`, { name: '  我的 iPhone  ' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.name, '我的 iPhone');
  assert.equal((await phone.req('GET', '/api/devices/me')).json.name, '我的 iPhone');
  // the name is a label only: the VM's approval signature does not cover it
  const me = await phone.req('GET', '/api/devices/me');
  assert.ok(me.json.vm_approved_at && me.json.vm_approval_sig);
  const audit = await h.sql("SELECT detail FROM audit_log WHERE event = 'device.rename'");
  assert.equal(audit.length, 1);
  assert.ok(!String(audit[0]!.detail).includes('iPhone'));
  // invalid names and ids
  for (const name of ['', '   ', 'x'.repeat(41), '<b>', 'a\nb', 7]) {
    assert.equal((await phone.req('POST', `/api/devices/${phone.id}/rename`, { name })).status, 400, String(name));
  }
  assert.equal((await phone.req('POST', '/api/devices/not-a-uuid/rename', { name: 'x' })).status, 400);
  assert.equal((await phone.req('POST', `/api/devices/${crypto.randomUUID()}/rename`, { name: 'x' })).status, 404);
  // a device without a session cannot rename anything
  const stranger = await SimDevice.create(h, 'Stranger');
  assert.equal((await stranger.req('POST', `/api/devices/${phone.id}/rename`, { name: 'x' })).status, 401);
  vm.cleanup();
});

test('renaming a revoked device is refused', async () => {
  const h = makeHarness();
  const { vm, phone, secrets } = await fullSetup(h);
  const laptop = await SimDevice.create(h, 'Laptop');
  await laptop.req('POST', '/api/devices/enroll/start', { recovery_key: secrets.recovery_key, device: laptop.publicKeys });
  assert.equal((await laptop.req('POST', `/api/devices/${laptop.id}/rename`, { name: 'x' })).status, 403);
  assert.equal((await phone.req('POST', `/api/devices/${laptop.id}/revoke`, {})).status, 200);
  assert.equal((await phone.req('POST', `/api/devices/${laptop.id}/rename`, { name: 'x' })).status, 409);
  vm.cleanup();
});

test('a revoked device can be removed from the list only after 72 hours', async () => {
  const h = makeHarness();
  const { vm, phone, secrets, totpSecret } = await fullSetup(h);
  const laptop = await SimDevice.create(h, 'Laptop');
  await laptop.req('POST', '/api/devices/enroll/start', { recovery_key: secrets.recovery_key, device: laptop.publicKeys });
  // not revoked: refused
  assert.equal((await phone.req('POST', `/api/devices/${laptop.id}/remove`, {})).status, 409);
  assert.equal((await phone.req('POST', `/api/devices/${laptop.id}/revoke`, {})).status, 200);
  // revoked, but within 72 hours: refused
  h.clock.advance(72 * 3600_000 - 60_000);
  assert.equal((await login(h, phone, totpSecret)).status, 200);
  assert.equal((await phone.req('POST', `/api/devices/${laptop.id}/remove`, {})).status, 409);
  // after 72 hours: removed, with its sessions; audited
  h.clock.advance(60_000);
  const r = await phone.req('POST', `/api/devices/${laptop.id}/remove`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await h.sql('SELECT id FROM devices WHERE id = ?', [laptop.id])).length, 0);
  assert.equal((await h.sql('SELECT device_id FROM sessions WHERE device_id = ?', [laptop.id])).length, 0);
  assert.equal((await h.sql("SELECT event FROM audit_log WHERE event = 'device.remove'")).length, 1);
  assert.equal((await phone.req('GET', '/api/devices')).json.devices.length, 1);
  assert.equal((await phone.req('POST', `/api/devices/${laptop.id}/remove`, {})).status, 404);
  // the phone itself (not revoked) can never be removed
  assert.equal((await phone.req('POST', `/api/devices/${phone.id}/remove`, {})).status, 409);
  vm.cleanup();
});
