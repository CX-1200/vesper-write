# §18 安全需求清单

Build Spec §18 的每一项，以及它目前的证据。

- ✅ **已验证**：有自动测试（`npm test`、浏览器端到端测试），或是可以直接检查的设定档。
- 🔲 **需要你确认**：只能在你的 Vercel、GitHub 或 VM 上确认的事；做完请在方框里打勾。

测试名称可以在 `tests/` 里直接搜索。

| # | 需求 | 状态 | 证据 |
|---|---|---|---|
| 1 | 代码和设定里没有 Anthropic API key，也没有调用 Messages API | ✅ | `§18: no Anthropic API key usage and no Messages API calls anywhere in the code`（扫描整个 repo 的程序码）；Claude Code 子进程的环境变量是白名单式的，只有 `CLAUDE_CODE_OAUTH_TOKEN`（`claude environment is minimal…`） |
| 2 | Vercel 数据库里找不到 ticket 明文、偏好或模板 | ✅ 🔲 | `acceptance 3: the Vercel database holds only ciphertext and metadata`；浏览器端到端测试直接读 SQLite 档案确认找不到需求原文。**你在 D1 上的确认**：vm-setup/09 第 6 节第 3 项 |
| 3 | secret 只在 Vercel Sensitive env var 或 VM systemd credential；没有 `NEXT_PUBLIC_` | ✅ 🔲 | `§18: no NEXT_PUBLIC_ variables…`；worker 只从 `$CREDENTIALS_DIRECTORY` 读 token（`worker/src/config.ts`）。**你要确认**：Vercel 上每个变量都标成 Sensitive（README 第 4 节） |
| 4 | `.env*` 在 `.gitignore`；`.env.example` 只有名称；`~/vesper-content/` 不在 repo | ✅ | 同上那个测试检查 `.gitignore` 和 `.env.example`；repo 里只有 `vm-setup/content-example/`（范例），你真正的内容在 VM 上，有防推送的 pre-push hook（vm-setup/07） |
| 5 | 提醒你开启 GitHub secret scanning、push protection、Dependabot | ✅ 🔲 | README「GitHub 设定提醒」。**你要做**：到 repo 的 Settings 开启 |
| 6 | 每个 API route 都要求认证（§7 的例外除外）并有速率限制 | ✅ | `§7: every endpoint except the listed exceptions rejects requests without a session/signature`、`every app/api route file has a matching entry in the test router`、`rate limit: more than 120 requests per minute…`、`R3: 5 auth failures in 10 minutes block the source…` |
| 7 | 设备和 worker 的每个请求都有签名验证和防重放 | ✅ | `device signatures: missing, wrong key, wrong path, stale timestamp and replayed nonce are all refused`、`R7: a worker request with the right token but a wrong VM signature → LOCKDOWN`、`request signature fails when any signed component changes`、`isFresh enforces the ±60 s window` |
| 8 | VM 只信任 `trusted-devices.json`；设备只信任配对时确认的 VM 公钥 | ✅ | VM：`acceptance 4b: a ticket from a registered but NOT VM-approved device triggers R8`、`trust list: fingerprints are recomputed on load…`；设备：PWA 把 VM 公钥存在 IndexedDB，之后验证批准与输出签名都只用它（`web/client/identity.ts`、`tickets.ts`），首页会比对 Vercel 回报的公钥并在不同时警告；浏览器端到端测试确认设备显示的 VM 指纹是自己从公钥算出来的 |
| 9 | AAD 绑定：把密文搬到别的 ticket、改类型或目标都会解密失败 | ✅ | `AAD binding: moving ciphertext to another ticket, type, target, device or ts fails`、`output AAD binding: recipient device and processed_at are bound`、`swapping the ciphertext of two tickets in the DB is detected` |
| 10 | 加密与签名有 test vectors；web 和 worker 能互相解密对方的封包 | ✅ | RFC 9180 官方向量（`RFC 9180 vector: …` 三个测试）；自己的参考向量 `tests/fixtures/vesper-vectors.json`（`vectors: …` 六个测试）；`round trip: device → encrypted ticket → VM → encrypted prompt → device`；浏览器端到端测试由真的浏览器加密、真的 worker 解密，反之亦然 |
| 11 | Cookie 为 HttpOnly、Secure、SameSite=Strict | ✅ | `login: password + TOTP + device signature` 逐字检查 `Set-Cookie`（`__Host-vesper_sid=…; Path=/; HttpOnly; Secure; SameSite=Strict`） |
| 12 | 严格 CSP：不载入第三方 script，不用 inline script（nonce 或 hash） | ✅ | `web/proxy.ts`：每个请求新的 nonce、`script-src 'self' 'nonce-…' 'strict-dynamic'`、没有 `unsafe-inline`；浏览器端到端测试检查标头、每个 `<script>` 都带 nonce、没有 inline style，而且整个流程中浏览器**没有回报任何 CSP 违规** |
| 13 | 日志不记录 request body、ticket 内容或任何 secret（Vercel 和 VM） | ✅ 🔲 | `§18: logging calls never print request bodies, tokens or decrypted content`（扫描所有 log 呼叫）；Vercel 端出错只记录错误类别名称（`web/lib/app.ts`）；`ClaudeCodeProcessor: content only via stdin, token only via env…`。**你在 VM 上的确认**：vm-setup/08 第 5 节用 `grep -f` 检查两个 token 没有出现在 journald |
| 14 | 推送通知不包含任何内容 | ✅ | `notify texts are the fixed §13 strings and sw.js uses the same table`；推送只送 `{k, n}`（种类与数量），文字由 service worker 依固定表格显示 |
| 15 | setup、recovery、break-glass、kill、worker token 都只存哈希 | ✅ | `§18: tokens, keys, the password and the TOTP secret are never stored in plaintext; token hashes are argon2id`（把整个数据库倒出来找明文）；`argon2id: the platform implementation reproduces the RFC 9106 §5.3 test vector` |
| 16 | kill token 只能把状态设为 KILLED | ✅ | `kill token can only set KILLED and nothing else` |
| 17 | 系统状态不是 NORMAL、或本地锁存在时，worker 不调用 Claude Code | ✅ | `acceptance 7: kill switch → worker latches; flipping the DB back to NORMAL does not resume processing`、`worker: local latch wins even if Vercel reports NORMAL`；浏览器端到端测试也做了一次 |
| 18 | Claude Code 不开放任何工具；内容经 stdin；token 不在命令列参数或日志 | ✅ | `claude -p arguments: model, no tools, no MCP, no persistence, JSON output; no content in argv`、`ClaudeCodeProcessor: content only via stdin, token only via env, empty cwd…`（假的 `claude` 记录它实际收到的 argv 和环境变量）。参数名称的查证见 docs/verification.md 第 2 项 |
| 19 | systemd 沙箱有效（`systemd-analyze security vesper-worker`，记录分数） | ✅ 🔲 | 开发环境用 systemd 255 离线估算：**1.1（OK）**，没开的项目和理由见 vm-setup/08 第 3 节。**你在 VM 上的分数**：`______`（日期：`______`） |
| 20 | lint L1–L7 都有单元测试，包含中英文绕过尝试 | ✅ | `tests/core/lint.test.ts`：每条规则都有「应该标记」（含全形字、零宽字元、字母拆开、leet、同形字如西里尔字母、繁简体等绕过写法）和「不应该标记」的测试，另有效能测试 |
| 21 | 状态机每条转换都有单元测试，包含「可疑设备自己确认本人」必须失败、「本地锁存在时 Vercel 回报 NORMAL 也不处理」 | ✅ | `system: the suspicious device cannot confirm itself (must fail)`、`worker: local latch wins even if Vercel reports NORMAL`，以及 `tests/core/state-machines.test.ts` 其余每一条 ticket / 系统 / worker 转换 |

## 你的确认清单

- [ ] Vercel 的每个环境变量都是 Sensitive（#3）
- [ ] GitHub：secret scanning、push protection、Dependabot 已开启（#5）
- [ ] D1 里只看得到密文与元数据（#2，vm-setup/09 验收 3）
- [ ] VM 的 journald 里找不到两个 token（#13，vm-setup/08 第 5 节）
- [ ] `systemd-analyze security vesper-worker` 的分数已填在上表（#19）
- [ ] `sudo bash /opt/vesper/vm-setup/scripts/check-vm.sh` 全部 PASS
