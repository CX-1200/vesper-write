import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lastGroup } from '@vesper/core/fingerprint';
import { ContentError, loadPreferences, loadTicketTypes, loadType } from '../../worker/src/content.ts';
import { loadTrusted, saveTrusted, trustDevice, untrustDevice, loadRevoked } from '../../worker/src/trust.ts';
import { latchExists, readLatch, writeLatch } from '../../worker/src/latch.ts';
import { paths } from '../../worker/src/paths.ts';
import { generateVmKeys } from '../../worker/src/keystore.ts';
import { cmdDeviceApprove, cmdInit, cmdStatus } from '../../worker/src/cli-commands.ts';
import { runLoop, deliverDeviceActions } from '../../worker/src/loop.ts';
import { HttpError, NetworkError } from '../../worker/src/api.ts';
import { enqueueDeviceAction, listDeviceActions } from '../../worker/src/outbox.ts';
import { prepareClaudeHome, CLAUDE_SETTINGS } from '../../worker/src/claude-home.ts';
import { makeHarness, SETUP_TOKEN } from '../helpers/harness.ts';
import { SimVm, writeContent } from '../helpers/sim-vm.ts';
import { SimDevice } from '../helpers/sim-device.ts';
import { beginSetup } from '../helpers/scenario.ts';
import * as nodeCrypto from 'node:crypto';

// These tests run the web handlers in-process (makeHarness), which hash
// secrets with crypto.argon2 (Node ≥ 24.7). The worker code itself only needs
// Node 22, so on the VM these few tests are skipped instead of failing.
const WEB_HARNESS = 'argon2' in nodeCrypto ? {} : { skip: 'needs Node ≥ 24.7 (the web harness uses crypto.argon2)' };

function tmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('content: ticket-types.json is validated', () => {
  const dir = tmp('vesper-content-');
  writeContent(dir);
  const types = loadTicketTypes(dir);
  assert.equal(types.general?.model, 'claude-haiku-5-5');
  assert.match(loadPreferences(dir), /偏好/);
  assert.match(loadType(dir, 'coding').template, /coding/);
  assert.throws(() => loadType(dir, 'nope'), (e: any) => e instanceof ContentError && e.code === 'unknown_type');
  const bad = [
    { general: { model: 'Claude Haiku!', template: 't.md', max_output_chars: 1000 } },
    { general: { model: 'claude-haiku-5-5', template: 't.md', max_output_chars: 5 } },
    { 'Bad Key': { model: 'claude-haiku-5-5', template: 't.md', max_output_chars: 1000 } },
    { general: { model: 'claude-haiku-5-5', max_output_chars: 1000 } },
    [],
  ];
  for (const b of bad) {
    writeFileSync(join(dir, 'ticket-types.json'), JSON.stringify(b));
    assert.throws(() => loadTicketTypes(dir), ContentError, JSON.stringify(b));
  }
});

test('content: template paths cannot escape the content directory (.., absolute, symlink)', () => {
  const dir = tmp('vesper-content-');
  writeContent(dir);
  const outside = tmp('vesper-outside-');
  writeFileSync(join(outside, 'secret.md'), 'TOP SECRET');
  symlinkSync(join(outside, 'secret.md'), join(dir, 'templates', 'link.md'));
  for (const template of ['../../etc/passwd', '/etc/passwd', 'templates/link.md', `../${outside.split('/').pop()}/secret.md`]) {
    writeFileSync(join(dir, 'ticket-types.json'), JSON.stringify({ general: { model: 'claude-haiku-5-5', template, max_output_chars: 1000 } }));
    assert.throws(() => loadType(dir, 'general'), (e: any) => e instanceof ContentError && ['bad_template_path', 'content_missing'].includes(e.code), template);
  }
});

test('content: oversized files are refused', () => {
  const dir = tmp('vesper-content-');
  writeContent(dir);
  writeFileSync(join(dir, 'preferences.md'), 'x'.repeat(70 * 1024));
  assert.throws(() => loadPreferences(dir), (e: any) => e.code === 'content_too_large');
});

test('trust list: fingerprints are recomputed on load, so a hand-edited key is rejected', WEB_HARNESS, async () => {
  const p = paths(tmp('vesper-data-'));
  const h = makeHarness();
  const a = await SimDevice.create(h, 'A');
  const b = await SimDevice.create(h, 'B');
  await trustDevice(p, { id: a.id, name: 'A', sign_public_key: a.signJwk, enc_public_key: a.encJwk, approved_at: 1 });
  assert.equal((await loadTrusted(p))[0]?.fingerprint, a.fingerprint);
  // swap in another device's key but keep the old fingerprint
  const list = await loadTrusted(p);
  saveTrusted(p, [{ ...list[0]!, sign_public_key: b.signJwk }]);
  await assert.rejects(loadTrusted(p), /fingerprint mismatch/);
  saveTrusted(p, list);
  await untrustDevice(p, a.id, 5);
  assert.equal((await loadTrusted(p)).length, 0);
  assert.equal(loadRevoked(p)[0]?.id, a.id);
  // files are private
  assert.equal(statSync(p.trustedDevices).mode & 0o777, 0o600);
});

test('latch: idempotent, keeps the first reason', () => {
  const p = paths(tmp('vesper-data-'));
  assert.equal(latchExists(p), false);
  writeLatch(p, 'r8', 100, 'bad_device_signature');
  writeLatch(p, 'server_killed', 200);
  assert.deepEqual(readLatch(p), { reason: 'r8', since: 100, detail: 'bad_device_signature' });
  assert.equal(statSync(p.latch).mode & 0o777, 0o600);
});

test('claude home: settings are written and directories are private', () => {
  const p = paths(tmp('vesper-data-'));
  prepareClaudeHome(p);
  const s = JSON.parse(readFileSync(join(p.claudeHome, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s, CLAUDE_SETTINGS);
  assert.equal(statSync(p.claudeCwd).mode & 0o777, 0o700);
});

test('vesper init: generates keys, registers with the setup token, prints the fingerprint; refuses to run twice', WEB_HARNESS, async () => {
  const h = makeHarness();
  const vm = new SimVm(h);
  const { env, output } = vm.cli([SETUP_TOKEN]);
  await cmdInit(env);
  const text = output.join('\n');
  assert.ok(text.includes('登记成功'));
  assert.equal(statSync(vm.p.pendingWorkerToken).mode & 0o777, 0o600);
  assert.equal(statSync(vm.p.signKey).mode & 0o777, 0o600);
  const row = (await h.sql('SELECT fingerprint FROM vm_identity'))[0]!;
  assert.ok(text.includes(String(row.fingerprint).split(' ').join('  ')));
  // a second run with the pending token retries; after the token is installed (file removed) it refuses
  const again = vm.cli([SETUP_TOKEN]);
  await cmdInit(again.env);
  const { rmSync } = await import('node:fs');
  rmSync(vm.p.pendingWorkerToken);
  await assert.rejects(cmdInit(vm.cli([SETUP_TOKEN]).env), /已经有身份密钥/);
  vm.cleanup();
});

test('vesper init: a wrong setup token fails without printing anything secret', WEB_HARNESS, async () => {
  const h = makeHarness();
  const vm = new SimVm(h);
  const { env, output } = vm.cli(['wrong-token-wrong-token-wrong-token-1234']);
  await assert.rejects(cmdInit(env), /登记失败/);
  assert.ok(!output.join('\n').includes(vm.workerToken));
  vm.cleanup();
});

test('vesper device approve: nothing pending → explains; the fingerprint is recomputed locally', WEB_HARNESS, async () => {
  const h = makeHarness();
  const vm = await SimVm.create(h);
  const { env, output } = vm.cli([]);
  assert.equal(await cmdDeviceApprove(env), false);
  assert.ok(output.join('\n').includes('没有待批准的设备'));
  const phone = await SimDevice.create(h);
  await beginSetup(h, phone);
  await vm.poll();
  // if Vercel lied about the keys, the CLI would show a different fingerprint than the phone does:
  const cache = JSON.parse(readFileSync(vm.p.pendingDevices, 'utf8'));
  const other = await SimDevice.create(h, 'evil');
  cache.devices[0].sign_public_key = other.signJwk;
  writeFileSync(vm.p.pendingDevices, JSON.stringify(cache));
  assert.equal(await vm.approve(phone.id, lastGroup(phone.fingerprint)), false, 'typed group from the real phone does not match');
  assert.equal((await loadTrusted(vm.p)).length, 0);
  vm.cleanup();
});

test('vesper status runs and reports the latch', WEB_HARNESS, async () => {
  const h = makeHarness();
  const vm = await SimVm.create(h);
  writeLatch(vm.p, 'r8', h.clock.t, 'decrypt_failed');
  const { env, output } = vm.cli([]);
  await cmdStatus(env);
  assert.ok(output.join('\n').includes('已上锁（r8: decrypt_failed'));
  vm.cleanup();
});

test('device actions: rejected ones (409) are dropped, network failures keep them queued', async () => {
  const p = paths(tmp('vesper-data-'));
  const log: string[] = [];
  enqueueDeviceAction(p, { action: 'revoke', device_id: '0b7e1d2c-9a8f-4e6d-8c5b-4a3f2e1d0c9b', revoked_at: 1, sig: 's' });
  const deps = (deviceAction: () => Promise<unknown>) =>
    ({ paths: p, client: { deviceAction }, log: (e: string) => log.push(e) }) as unknown as Parameters<typeof deliverDeviceActions>[0];
  assert.equal(await deliverDeviceActions(deps(async () => Promise.reject(new NetworkError('x')))), 0);
  assert.equal(listDeviceActions(p).length, 1);
  assert.equal(await deliverDeviceActions(deps(async () => Promise.reject(new HttpError(409, 'conflict')))), 0);
  assert.equal(listDeviceActions(p).length, 0);
  assert.ok(log.includes('device_action_rejected'));
});

test('runLoop backs off exponentially after repeated connection failures and stops on abort', async () => {
  const p = paths(tmp('vesper-data-'));
  const delays: number[] = [];
  const ac = new AbortController();
  let calls = 0;
  const deps = {
    cfg: { contentDir: '/x', claimMax: 2, pollIntervalMs: 30_000 },
    paths: p,
    keys: {} as never,
    client: { pull: async () => { calls++; throw new NetworkError('down'); } } as never,
    processor: {} as never,
    now: () => 0,
    log: () => {},
  };
  await runLoop(deps, {
    signal: ac.signal,
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length >= 8) ac.abort();
    },
  });
  assert.equal(calls, 8);
  assert.deepEqual(delays.slice(0, 4), [30_000, 30_000, 30_000, 30_000]);
  assert.ok(delays[4]! > 30_000 && delays[5]! > delays[4]!, JSON.stringify(delays));
  assert.ok(delays.every((d) => d <= 15 * 60_000));
  assert.ok(!existsSync(p.latch), 'network trouble never latches');
});

test('VM key files: refuse to overwrite an existing identity', async () => {
  const p = paths(tmp('vesper-data-'));
  await generateVmKeys(p);
  await assert.rejects(generateVmKeys(p), /refusing to overwrite/);
});
