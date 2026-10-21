// Prepares the sandboxed HOME used by the claude child process: an empty
// working directory and a settings file that keeps Claude Code quiet and
// stateless (§9.3: cleanupPeriodDays short; no hooks, memory or connectors).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, writeJsonAtomic } from "./fsutil.js";
export const CLAUDE_SETTINGS = {
    // minimum allowed value (0 fails validation); transcripts are not written anyway (--no-session-persistence)
    cleanupPeriodDays: 1,
    disableAllHooks: true,
    autoMemoryEnabled: false,
    disableClaudeAiConnectors: true,
};
export function prepareClaudeHome(p) {
    ensureDir(p.claudeHome);
    ensureDir(join(p.claudeHome, '.claude'));
    ensureDir(p.claudeCwd);
    const settingsPath = join(p.claudeHome, '.claude', 'settings.json');
    const wanted = JSON.stringify(CLAUDE_SETTINGS, null, 2) + '\n';
    if (!existsSync(settingsPath) || readFileSync(settingsPath, 'utf8') !== wanted)
        writeJsonAtomic(settingsPath, CLAUDE_SETTINGS);
}
/** The working directory must stay empty: anything in it (.claude/, .mcp.json, CLAUDE.md) would be loaded by claude -p. */
export function claudeCwdIsEmpty(p) {
    return readdirSync(p.claudeCwd).length === 0;
}
