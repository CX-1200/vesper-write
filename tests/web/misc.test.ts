import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHarness } from '../helpers/harness.ts';
import { fullSetup, SimDevice } from '../helpers/scenario.ts';
import { ROUTES } from '../../web/lib/router.ts';
import { loadEnv, EnvError } from '../../web/lib/env.ts';
import { D1RestDb } from '../../web/lib/db/d1.ts';
import { isAllowedPushEndpoint } from '../../web/lib/notify.ts';
import { auditStatement } from '../../web/lib/audit.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', '.git', '.data'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('every app/api route file has a matching entry in the test router (and vice versa)', () => {
  const files = walk(join(ROOT, 'web/app/api')).filter((f) => f.endsWith('route.ts'));
  const fromFiles = new Set<string>();
  for (const f of files) {
    const path = '/' + relative(join(ROOT, 'web/app'), f).replace(/\/route\.ts$/, '');
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/export const (GET|POST) = route/g)) fromFiles.add(`${m[1]} ${path}`);
  }
  const fromRouter = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
  assert.deepEqual([...fromFiles].sort(), [...fromRouter].sort());
});

test('§7: every endpoint except the listed exceptions rejects requests without a session/signature', async () => {
  const h = makeHarness();
  const { vm } = await fullSetup(h);
  const exceptions = new Set(['POST /api/setup', 'POST /api/auth/login', 'POST /api/devices/enroll/start', 'POST /api/kill', 'POST /api/worker/register', 'POST /api/auth/passkey/options', 'POST /api/auth/passkey/verify']);
  for (const r of ROUTES) {
    const key = `${r.method} ${r.path}`;
    const path = r.path.replace('[id]', '6f1c2a4e-3b5d-4c7e-8f90-a1b2c3d4e5f6');
    const res = await h.fetch(path, { method: r.method, headers: { 'x-forwarded-for': `10.9.${ROUTES.indexOf(r)}.1`, 'content-type': 'application/json' }, ...(r.method === 'POST' ? { body: '{}' } : {}) });
    if (exceptions.has(key)) {
      assert.ok([400, 401, 409].includes(res.status), `${key} → ${res.status}`);
    } else {
      assert.equal(res.status, 401, `${key} must require authentication`);
    }
  }
  vm.cleanup();
});

test('audit log: simple view (50 rows, device names) and full view with filters', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  for (let i = 0; i < 5; i++) await phone.createTicket({ raw: `t${i}` });
  const simple = await phone.req('GET', '/api/audit?view=simple');
  assert.equal(simple.status, 200);
  assert.ok(simple.json.rows.length <= 50);
  assert.ok(simple.json.rows.some((r: any) => r.device === 'iPhone'));
  assert.deepEqual(Object.keys(simple.json.rows[0]).sort(), ['device', 'event', 'result', 'time', 'ts']);
  const full = await phone.req('GET', '/api/audit?view=full&event=ticket.&result=ok');
  assert.ok(full.json.rows.length >= 5);
  assert.ok(full.json.rows.every((r: any) => r.event.startsWith('ticket.') && r.result === 'ok'));
  assert.ok('ip' in full.json.rows[0] && 'country' in full.json.rows[0] && 'rule' in full.json.rows[0]);
  vm.cleanup();
});

test('audit CSV export escapes quotes and neutralizes spreadsheet formulas', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  await h.ctx.db.batch([auditStatement(h.ctx, { event: 'test.csv', actor: '=HYPERLINK("http://evil")', result: 'info', detail: { note: 'a,"b"' } })]);
  const res = await h.fetch('/api/audit?view=full&format=csv', { method: 'GET', headers: await signedHeaders(phone, 'GET', '/api/audit?view=full&format=csv') });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  const csv = await res.text();
  assert.ok(csv.startsWith('id,time,event,result,device,ip,country,rule,detail\r\n'));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`), 'formula is prefixed with a quote and quotes are doubled');
  vm.cleanup();
});

async function signedHeaders(d: SimDevice, method: string, path: string): Promise<Record<string, string>> {
  const { signRequest } = await import('@vesper/core/sign');
  const { randomNonce } = await import('@vesper/core/encoding');
  const ts = d.h.clock.t;
  const nonce = randomNonce();
  return {
    'x-forwarded-for': d.ip,
    'x-vesper-device': d.id,
    'x-vesper-ts': String(ts),
    'x-vesper-nonce': nonce,
    'x-vesper-sig': await signRequest(d.sign.privateKey, { method, path, ts, nonce, body: '' }),
    cookie: d.cookie!,
  };
}

test('audit log is append-only at the database level and holds metadata only', async () => {
  const h = makeHarness();
  const { vm } = await fullSetup(h);
  await assert.rejects(h.sql("UPDATE audit_log SET result = 'ok'"), /append-only/);
  await h.ctx.db.batch([auditStatement(h.ctx, { event: 'test.detail', actor: 'x', result: 'info', detail: { body: 'x'.repeat(1000), nested: { a: 1 } as never } })]);
  const row = (await h.sql("SELECT detail FROM audit_log WHERE event = 'test.detail'"))[0]!;
  const d = JSON.parse(String(row.detail));
  assert.equal(d.body.length, 120);
  assert.equal(d.nested, undefined);
  vm.cleanup();
});

test('push: only known push services are accepted as subscription endpoints (no SSRF)', async () => {
  assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/QK'), true);
  assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
  assert.equal(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
  for (const bad of ['http://web.push.apple.com/x', 'https://evil.example/x', 'https://web.push.apple.com.evil.example/x', 'https://user:pw@web.push.apple.com/x', 'https://169.254.169.254/latest', 'https://web.push.apple.com:8443/x']) {
    assert.equal(isAllowedPushEndpoint(bad), false, bad);
  }
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const r = await phone.req('POST', '/api/push/subscribe', { endpoint: 'https://evil.example/hook', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });
  assert.equal(r.json.error, 'push_endpoint_not_allowed');
  vm.cleanup();
});

test('rate limit: more than 120 requests per minute from one IP are refused', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  h.clock.advance(60_000 - (h.clock.t % 60_000)); // start of a fresh window
  let last = 0;
  for (let i = 0; i < 121; i++) last = (await phone.req('GET', '/api/config')).status;
  assert.equal(last, 429);
  h.clock.advance(60_000);
  assert.equal((await phone.req('GET', '/api/config')).status, 200);
  vm.cleanup();
});

test('config and logout', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  const c = await phone.req('GET', '/api/config');
  assert.equal(c.json.vapid_public_key, 'test-public');
  assert.ok(c.json.ticket_types.some((t: any) => t.key === 'general' && t.label === '一般'));
  const out = await phone.req('POST', '/api/auth/logout', {});
  assert.equal(out.status, 200);
  assert.match(out.setCookie ?? '', /Max-Age=0/);
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM sessions'))[0]!.n, 0);
  vm.cleanup();
});

test('GET /api/vm reports online status from the last worker pull', async () => {
  const h = makeHarness();
  const { vm, phone } = await fullSetup(h);
  let r = await phone.req('GET', '/api/vm');
  assert.equal(r.json.online, true);
  assert.equal(r.json.fingerprint, vm.keys.fingerprint);
  h.clock.advance(10 * 60_000);
  r = await phone.req('GET', '/api/vm');
  assert.equal(r.json.online, false);
  assert.ok(r.json.last_seen_at < h.clock.t);
  vm.cleanup();
});

test('D1 REST adapter: request format, string parameters, batch, and no token in errors', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const token = 'cf-api-token-TEST-ONLY-0123456789';
  const fake: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    const body = JSON.parse(String(init!.body));
    const n = body.batch ? body.batch.length : 1;
    return new Response(JSON.stringify({ success: true, result: Array.from({ length: n }, () => ({ success: true, results: [{ x: 1 }], meta: { changes: 1 } })) }), { status: 200 });
  };
  const db = new D1RestDb({ accountId: '0123456789abcdef0123456789abcdef', databaseId: '01234567-89ab-cdef-0123-456789abcdef', apiToken: token, fetchImpl: fake });
  const r = await db.batch([{ sql: 'SELECT ?', params: [5] }]);
  assert.deepEqual(r, [{ rows: [{ x: 1 }], changes: 1 }]);
  assert.equal(calls[0]!.url, 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/d1/database/01234567-89ab-cdef-0123-456789abcdef/query');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { sql: 'SELECT ?', params: ['5'] });
  await db.batch([{ sql: 'A' }, { sql: 'B', params: ['x'] }]);
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { batch: [{ sql: 'A', params: [] }, { sql: 'B', params: ['x'] }] });
  await assert.rejects(db.batch([{ sql: 'X', params: [null as never] }]), /strings or integers/);
  const failing = new D1RestDb({ accountId: '0123456789abcdef0123456789abcdef', databaseId: '01234567-89ab-cdef-0123-456789abcdef', apiToken: token, fetchImpl: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: 'no such table' }] }), { status: 400 }) });
  await assert.rejects(failing.batch([{ sql: 'X' }]), (e: Error) => !e.message.includes(token) && e.message.includes('no such table'));
});

test('env: missing or weak settings fail with the variable NAME only', () => {
  const base = { APP_ORIGIN: 'https://v.example', TOTP_ENC_KEY: 'A'.repeat(43), DB_DRIVER: 'sqlite', NODE_ENV: 'development' };
  assert.equal(loadEnv(base).appOrigin, 'https://v.example');
  assert.throws(() => loadEnv({ ...base, APP_ORIGIN: undefined }), /APP_ORIGIN/);
  assert.throws(() => loadEnv({ ...base, TOTP_ENC_KEY: 'short' }), EnvError);
  const weak = 'weak-setup-token';
  assert.throws(() => loadEnv({ ...base, SETUP_TOKEN: weak }), (e: Error) => /SETUP_TOKEN/.test(e.message) && !e.message.includes(weak));
  assert.throws(() => loadEnv({ ...base, NODE_ENV: 'production' }), /sqlite is for local development/);
  assert.throws(() => loadEnv({ ...base, DB_DRIVER: 'd1' }), /D1_ACCOUNT_ID/);
});

// ---- §18 static checks over the source tree -------------------------------------

const SOURCES = walk(ROOT).filter((f) => /\.(ts|tsx|js|mjs|json|sql|service|sh)$/.test(f) && !f.includes('/tests/fixtures/') && !f.endsWith('package-lock.json'));

test('§18: no Anthropic API key usage and no Messages API calls anywhere in the code', () => {
  for (const f of SOURCES) {
    if (f.includes('/tests/')) continue;
    const s = readFileSync(f, 'utf8');
    assert.ok(!/ANTHROPIC_API_KEY|x-api-key|\/v1\/messages|@anthropic-ai\/sdk/i.test(s), relative(ROOT, f));
  }
});

test('§18: no NEXT_PUBLIC_ variables; .env files are git-ignored; .env.example has names only', () => {
  for (const f of SOURCES) {
    if (f.includes('/tests/')) continue;
    assert.ok(!readFileSync(f, 'utf8').includes('NEXT_PUBLIC_'), relative(ROOT, f));
  }
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.ok(/^\.env$/m.test(gi) && /^\.env\.\*$/m.test(gi) && /^!\.env\.example$/m.test(gi));
  const ex = readFileSync(join(ROOT, '.env.example'), 'utf8');
  for (const line of ex.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    assert.match(line, /^[A-Z0-9_]+=$/, `.env.example must contain names only: ${line}`);
  }
});

test('§18: logging calls never print request bodies, tokens or decrypted content', () => {
  for (const f of SOURCES) {
    if (f.includes('/tests/') || !/\.(ts|tsx)$/.test(f)) continue;
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/console\.(log|error|warn|info)\(([^;]*)\)/g)) {
      assert.ok(!/body|token|secret|password|raw_input|rawInput|prompt|plain/i.test(m[2]!), `${relative(ROOT, f)}: ${m[0]}`);
    }
  }
});
