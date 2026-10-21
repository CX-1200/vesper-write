// Entry point for vesper-worker.service (systemd). Logs are single-line JSON
// on stdout (journald) and never contain request content or secrets.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, readCredential } from "./config.js";
import { paths } from "./paths.js";
import { loadVmKeys } from "./keystore.js";
import { VercelClient } from "./api.js";
import { ClaudeCodeProcessor, parseClaudeVersion, versionAtLeast } from "./processor.js";
import { claudeCwdIsEmpty, prepareClaudeHome } from "./claude-home.js";
import { ensureDir, permissionProblem } from "./fsutil.js";
import { runLoop } from "./loop.js";
export const log = (event, fields = {}) => {
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');
};
// worker/src/main.ts → ../assets; compiled worker/dist/src/main.js → ../../assets
export const SYSTEM_PROMPT_FILE = [new URL('../assets/system-prompt.md', import.meta.url), new URL('../../assets/system-prompt.md', import.meta.url)]
    .map((u) => fileURLToPath(u))
    .find((p) => existsSync(p)) ?? fileURLToPath(new URL('../assets/system-prompt.md', import.meta.url));
export async function buildProcessorAndClient() {
    const cfg = loadConfig();
    const p = paths(cfg.dataDir);
    ensureDir(p.stateDir);
    ensureDir(p.logDir);
    for (const f of [p.keysDir, p.signKey, p.encKey, p.trustedDevices, p.ticketLog]) {
        const problem = permissionProblem(f);
        if (problem)
            throw new Error(problem);
    }
    const keys = await loadVmKeys(p);
    const workerToken = readCredential('worker-token');
    const oauthToken = readCredential('claude-oauth-token');
    if (!workerToken)
        throw new Error('worker token credential missing (LoadCredential=worker-token:…)');
    if (!oauthToken)
        throw new Error('Claude Code token credential missing (LoadCredential=claude-oauth-token:…)');
    prepareClaudeHome(p);
    if (!claudeCwdIsEmpty(p))
        throw new Error(`${p.claudeCwd} must be empty`);
    const processor = new ClaudeCodeProcessor({
        claudeBin: cfg.claudeBin,
        oauthToken,
        home: p.claudeHome,
        cwd: p.claudeCwd,
        timeoutMs: cfg.claudeTimeoutMs,
        proxyUrl: cfg.proxyUrl,
        systemPromptFile: SYSTEM_PROMPT_FILE,
    });
    const client = new VercelClient({ baseUrl: cfg.baseUrl, workerToken, vmSignKey: keys.signPrivate });
    return { cfg, p, keys, processor, client };
}
export function checkClaudeVersion(claudeBin, min) {
    try {
        const out = execFileSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 15_000, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent' } });
        const v = parseClaudeVersion(out);
        if (!v)
            log('claude_version_unknown');
        else if (!versionAtLeast(v, min))
            log('claude_version_too_old', { have: v, need: min });
        else
            log('claude_version_ok', { version: v });
    }
    catch {
        log('claude_not_runnable', { bin: claudeBin });
    }
}
async function main() {
    const { cfg, p, keys, processor, client } = await buildProcessorAndClient();
    checkClaudeVersion(cfg.claudeBin, cfg.minClaudeVersion);
    log('worker_start', { vm_fingerprint: keys.fingerprint, base_url: cfg.baseUrl, poll_ms: cfg.pollIntervalMs });
    const ac = new AbortController();
    process.on('SIGTERM', () => ac.abort());
    process.on('SIGINT', () => ac.abort());
    await runLoop({ cfg, paths: p, keys, client, processor, now: Date.now, log }, { signal: ac.signal });
    log('worker_stop');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((e) => {
        log('worker_fatal', { error: e?.message?.slice(0, 200) ?? 'unknown' });
        process.exit(1);
    });
}
