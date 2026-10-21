// The VM runs the compiled JavaScript in worker/dist and packages/core/dist
// with Ubuntu's Node, which cannot run TypeScript. These tests check that the
// committed dist/ is exactly what the sources compile to, and that it runs
// with TypeScript support switched off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

test('committed dist/ matches a fresh compile of the sources (run `npm run build:worker` if this fails)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vesper-dist-'));
  try {
    for (const [project, committed] of [
      ['packages/core/tsconfig.build.json', 'packages/core/dist'],
      ['worker/tsconfig.build.json', 'worker/dist'],
    ] as const) {
      const out = join(tmp, committed);
      execFileSync(process.execPath, [tsc, '-p', join(repo, project), '--outDir', out], { cwd: repo });
      const want = files(out);
      assert.deepEqual(files(join(repo, committed)), want, `${committed}: file list differs`);
      for (const f of want) assert.equal(readFileSync(join(repo, committed, f), 'utf8'), readFileSync(join(out, f), 'utf8'), `${committed}/${f} is stale`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('compiled worker runs with TypeScript support switched off (like Ubuntu\'s Node)', () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--no-experimental-strip-types', '--conditions=vesper-js', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  const help = run([join(repo, 'worker/dist/cli/vesper.js'), 'help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /vesper init/);

  const tmp = mkdtempSync(join(tmpdir(), 'vesper-dist-run-'));
  try {
    const content = join(tmp, 'content');
    cpSync(join(repo, 'vm-setup/content-example'), content, { recursive: true });
    chmodSync(content, 0o755);
    const cfg = join(tmp, 'worker.json');
    writeFileSync(cfg, JSON.stringify({ baseUrl: 'https://vesper.example.vercel.app', dataDir: join(tmp, 'data'), contentDir: content }));
    const check = run([join(repo, 'worker/dist/cli/vesper.js'), 'content', 'check'], { VESPER_CONFIG: cfg });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /内容检查通过/);
    // the service entry points load completely (no .ts anywhere in the graph)
    const load = run(['-e', `Promise.all([import(${JSON.stringify(join(repo, 'worker/dist/src/main.js'))}), import(${JSON.stringify(join(repo, 'worker/dist/src/selftest.js'))})]).then(([m]) => console.log(m.SYSTEM_PROMPT_FILE))`]);
    assert.equal(load.status, 0, load.stderr);
    assert.match(load.stdout.trim(), /worker\/assets\/system-prompt\.md$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
