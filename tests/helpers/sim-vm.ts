// The VM side for integration tests: the REAL worker modules (keys, trust
// list, latch, outbox, VercelClient, pollOnce, CLI approve/revoke) running in a
// temp directory, with a fake Processor instead of claude.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { b64urlEncode } from '@vesper/core/encoding';
import { paths, type Paths } from '../../worker/src/paths.ts';
import { generateVmKeys, type VmKeys } from '../../worker/src/keystore.ts';
import { registerVm, VercelClient } from '../../worker/src/api.ts';
import { pollOnce, type WorkerDeps } from '../../worker/src/loop.ts';
import { truncate, type GenerateInput, type Processor } from '../../worker/src/processor.ts';
import { cmdDeviceApprove, cmdDeviceRevoke, type CliEnv } from '../../worker/src/cli-commands.ts';
import { SETUP_TOKEN, type Harness } from './harness.ts';

export class FakeProcessor implements Processor {
  calls: GenerateInput[] = [];
  impl: ((i: GenerateInput) => string) | null = null;
  fail: Error | null = null;
  async generate(i: GenerateInput) {
    this.calls.push(i);
    if (this.fail) throw this.fail;
    const prompt = this.impl ? this.impl(i) : `你是一位细心的助理。请完成以下任务：${i.rawInput}`;
    const t = truncate(prompt, i.maxChars);
    return { prompt: t.text, meta: { model: i.model, truncated: t.truncated, durationMs: 3 } };
  }
}

export function writeContent(dir: string): void {
  mkdirSync(join(dir, 'templates'), { recursive: true });
  writeFileSync(join(dir, 'preferences.md'), '# 偏好\n- 用简体中文\n- 简洁\n');
  for (const t of ['general', 'coding', 'writing', 'research']) writeFileSync(join(dir, 'templates', `${t}.md`), `# ${t} 模板\n把需求整理成清楚的 prompt。\n`);
  writeFileSync(
    join(dir, 'ticket-types.json'),
    JSON.stringify({
      general: { model: 'claude-haiku-5-5', template: 'templates/general.md', max_output_chars: 6000, typical_chars: 2500 },
      coding: { model: 'claude-haiku-5-5', template: 'templates/coding.md', max_output_chars: 8000 },
      writing: { model: 'claude-haiku-5-5', template: 'templates/writing.md', max_output_chars: 4000 },
      research: { model: 'claude-haiku-5-5', template: 'templates/research.md', max_output_chars: 6000 },
    }),
  );
}

export class SimVm {
  dir: string;
  contentDir: string;
  p: Paths;
  h: Harness;
  keys!: VmKeys;
  workerToken = b64urlEncode(new Uint8Array(randomBytes(32)));
  processor = new FakeProcessor();
  events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  ip = '203.0.113.20';

  constructor(h: Harness) {
    this.h = h;
    this.dir = mkdtempSync(join(tmpdir(), 'vesper-vm-'));
    this.contentDir = join(this.dir, 'content');
    this.p = paths(join(this.dir, 'data'));
    writeContent(this.contentDir);
  }

  static async create(h: Harness, opts: { register?: boolean } = {}): Promise<SimVm> {
    const vm = new SimVm(h);
    vm.keys = await generateVmKeys(vm.p);
    if (opts.register !== false) await vm.register();
    return vm;
  }

  /** fetch as seen from the VM (its own source IP) */
  fetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('x-forwarded-for', this.ip);
    return this.h.fetch(input, { ...init, headers });
  };

  async register(setupToken = SETUP_TOKEN) {
    return registerVm({
      baseUrl: '',
      setupToken,
      workerToken: this.workerToken,
      vmSignKey: this.keys.signPrivate,
      signPublicJwk: this.keys.signPublicJwk,
      encPublicJwk: this.keys.encPublicJwk,
      fetchImpl: this.fetch,
      now: () => this.h.clock.t,
    });
  }

  client(signKey: CryptoKey = this.keys.signPrivate, token = this.workerToken): VercelClient {
    return new VercelClient({ baseUrl: '', workerToken: token, vmSignKey: signKey, fetchImpl: this.fetch, now: () => this.h.clock.t });
  }

  deps(): WorkerDeps {
    return {
      cfg: { contentDir: this.contentDir, claimMax: 2, pollIntervalMs: 30_000 },
      paths: this.p,
      keys: this.keys,
      client: this.client(),
      processor: this.processor,
      now: () => this.h.clock.t,
      log: (event, fields = {}) => this.events.push({ event, fields }),
    };
  }

  poll() {
    return pollOnce(this.deps());
  }

  cli(answers: string[]): { env: CliEnv; output: string[] } {
    const output: string[] = [];
    const queue = [...answers];
    return {
      output,
      env: {
        io: { out: (l = '') => output.push(l), ask: async () => queue.shift() ?? '' },
        paths: this.p,
        baseUrl: '',
        now: () => this.h.clock.t,
        fetchImpl: this.fetch,
      },
    };
  }

  /** `vesper device approve`, typing the last group the device shows, then "yes". */
  async approve(deviceId: string, typedLastGroup: string, confirm = 'yes'): Promise<boolean> {
    const { env } = this.cli([typedLastGroup, confirm]);
    return cmdDeviceApprove(env, deviceId);
  }

  async revoke(deviceId: string): Promise<boolean> {
    const { env } = this.cli(['yes']);
    return cmdDeviceRevoke(env, deviceId);
  }

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
