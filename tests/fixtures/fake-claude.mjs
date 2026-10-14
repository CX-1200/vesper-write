// Stand-in for the `claude` binary in tests. Records what it received and
// answers like `claude -p --output-format json`. Behaviour is chosen by a
// file "fake-mode" in $HOME (the worker gives claude a clean environment).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME ?? '/nonexistent';
const mode = existsSync(join(home, 'fake-mode')) ? readFileSync(join(home, 'fake-mode'), 'utf8').trim() : 'ok';
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  writeFileSync(
    join(home, 'fake-last-call.json'),
    JSON.stringify({
      argv: process.argv.slice(2),
      envKeys: Object.keys(process.env).sort(),
      tokenSet: token.length > 0,
      tokenInArgv: token.length > 0 && process.argv.some((a) => a.includes(token)),
      stdin,
      cwd: process.cwd(),
      env: { HTTPS_PROXY: process.env.HTTPS_PROXY ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null },
    }),
  );
  if (mode === 'timeout') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'exit') {
    process.stderr.write('something went wrong\n');
    process.exit(3);
  }
  if (mode === 'error') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Login expired' }) + '\n');
    return;
  }
  if (mode === 'garbage') {
    process.stdout.write('not json at all\n');
    return;
  }
  if (mode === 'long') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'x'.repeat(5000) }) + '\n');
    return;
  }
  const m = /<user_request>\n([\s\S]*)\n<\/user_request>/.exec(stdin);
  process.stdout.write('[debug] starting\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `PROMPT[${m ? m[1] : 'none'}]`, session_id: 's', total_cost_usd: 0 }) + '\n');
});
