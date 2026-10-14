// `vesper` command. Installed as /usr/local/bin/vesper (a small wrapper that
// runs this file with Node and NODE_USE_ENV_PROXY=1). Run it as the vesper
// user, e.g. `sudo -u vesper -i vesper status`.

import { createInterface } from 'node:readline';
import { loadConfig } from '../src/config.ts';
import { paths } from '../src/paths.ts';
import {
  CliError,
  cmdDeviceApprove,
  cmdDeviceList,
  cmdDeviceRevoke,
  cmdFingerprint,
  cmdInit,
  cmdLatch,
  cmdStatus,
  type CliEnv,
  type CliIo,
} from '../src/cli-commands.ts';

function askVisible(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

/** Reads a line without echoing it (for the setup token). */
function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  if (!stdin.isTTY) return askVisible('');
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new CliError('已取消。'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

const io: CliIo = {
  out: (line = '') => process.stdout.write(line + '\n'),
  ask: (q, opts) => (opts?.hidden ? askHidden(q) : askVisible(q)),
};

const HELP = `用法：
  vesper init                    产生 VM 密钥并向 Vercel 登记（只做一次）
  vesper fingerprint             显示 VM 指纹
  vesper status                  显示本地锁、连接与设备概况
  vesper device list             列出可信、已撤销与待批准的设备
  vesper device approve [ID]     比对指纹后批准一台设备
  vesper device revoke <ID>      撤销一台设备
  vesper latch                   显示本地锁状态`;

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, arg] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.out(HELP);
    return 0;
  }
  const cfg = loadConfig();
  const env: CliEnv = { io, paths: paths(cfg.dataDir), baseUrl: cfg.baseUrl, now: Date.now };
  switch (cmd) {
    case 'init':
      await cmdInit(env);
      return 0;
    case 'fingerprint':
      await cmdFingerprint(env);
      return 0;
    case 'status':
      await cmdStatus(env);
      return 0;
    case 'latch':
      await cmdLatch(env);
      return 0;
    case 'device':
      if (sub === 'list') await cmdDeviceList(env);
      else if (sub === 'approve') return (await cmdDeviceApprove(env, arg)) ? 0 : 1;
      else if (sub === 'revoke') return (await cmdDeviceRevoke(env, arg)) ? 0 : 1;
      else {
        io.out(HELP);
        return 2;
      }
      return 0;
    default:
      io.out(HELP);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof CliError ? e.message : `错误：${(e as Error)?.message ?? e}`}\n`);
    process.exit(1);
  },
);
