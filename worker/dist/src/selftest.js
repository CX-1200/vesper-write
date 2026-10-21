// vesper-selftest.service: runs ONE harmless request through exactly the same
// processor, sandbox and credentials as the worker, to verify on the VM that
// the token works, the model is available on the plan, and the CLI flags are
// accepted by the installed Claude Code version (docs/verification.md 1, 2, 4).
import { fileURLToPath } from 'node:url';
import { CONFIG } from '@vesper/core/config';
import { buildProcessorAndClient, checkClaudeVersion, log } from "./main.js";
import { loadTicketTypes } from "./content.js";
async function selftest() {
    const { cfg, processor } = await buildProcessorAndClient();
    checkClaudeVersion(cfg.claudeBin, cfg.minClaudeVersion);
    let model = 'claude-haiku-5-5';
    try {
        const types = loadTicketTypes(cfg.contentDir);
        model = Object.values(types)[0]?.model ?? model;
    }
    catch {
        log('selftest_content_unreadable');
    }
    try {
        const r = await processor.generate({
            rawInput: '这是 Vesper 的自检，请只回答 OK。',
            type: 'selftest',
            target: 'claude_ai',
            preferences: '（自检，无偏好）',
            template: '只输出两个英文字母 OK，不要输出其他任何内容。',
            model,
            maxChars: 200,
        });
        log('selftest_ok', { model, ms: r.meta.durationMs, answer_is_ok: /^ok\b/i.test(r.prompt.trim()), chars: r.prompt.length });
        return 0;
    }
    catch (e) {
        log('selftest_failed', { model, code: e.code ?? 'error', timeout_ms: CONFIG.claudeTimeoutMs });
        return 1;
    }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    selftest().then((code) => process.exit(code));
}
