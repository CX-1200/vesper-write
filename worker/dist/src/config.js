// Worker configuration. Non-secret settings come from a JSON file
// (/etc/vesper/worker.json, root-owned and read-only for the worker).
// Secrets come only from systemd credentials ($CREDENTIALS_DIRECTORY, §16.3)
// and are never logged.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG } from '@vesper/core/config';
export const DEFAULT_CONFIG_PATH = '/etc/vesper/worker.json';
export class ConfigError extends Error {
}
export function loadConfig(path = process.env.VESPER_CONFIG ?? DEFAULT_CONFIG_PATH) {
    const home = homedir();
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    const cfg = {
        baseUrl: (raw.baseUrl ?? process.env.VESPER_BASE_URL ?? '').replace(/\/$/, ''),
        dataDir: raw.dataDir ?? process.env.VESPER_DATA_DIR ?? join(home, '.local/share/vesper'),
        contentDir: raw.contentDir ?? process.env.VESPER_CONTENT_DIR ?? join(home, 'vesper-content'),
        claudeBin: raw.claudeBin ?? process.env.VESPER_CLAUDE_BIN ?? '/usr/bin/claude',
        pollIntervalMs: raw.pollIntervalMs ?? CONFIG.workerPollIntervalMs,
        claimMax: raw.claimMax ?? CONFIG.workerClaimMax,
        claudeTimeoutMs: raw.claudeTimeoutMs ?? CONFIG.claudeTimeoutMs,
        proxyUrl: raw.proxyUrl ?? process.env.HTTPS_PROXY ?? null,
        minClaudeVersion: raw.minClaudeVersion ?? '2.1.293',
    };
    if (!/^https:\/\/[^/]+$/.test(cfg.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cfg.baseUrl)) {
        throw new ConfigError('baseUrl must be https://<your-vercel-domain> (set it in /etc/vesper/worker.json)');
    }
    if (cfg.claimMax < 1 || cfg.claimMax > 5)
        throw new ConfigError('claimMax must be 1–5');
    if (cfg.pollIntervalMs < 5_000)
        throw new ConfigError('pollIntervalMs must be ≥ 5000');
    return cfg;
}
/** Read a systemd credential (LoadCredential=name:/path). Falls back to an explicit file for development. */
export function readCredential(name) {
    const dir = process.env.CREDENTIALS_DIRECTORY;
    const candidates = [dir ? join(dir, name) : null, process.env[`VESPER_${name.toUpperCase().replace(/-/g, '_')}_FILE`] ?? null];
    for (const p of candidates) {
        if (p && existsSync(p)) {
            const v = readFileSync(p, 'utf8').trim();
            if (v)
                return v;
        }
    }
    return null;
}
