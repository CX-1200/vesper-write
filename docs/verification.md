# §21 查证结果

查证日期：2026-10-14。每一项都写了**结论**、**状态**、**来源**和**对设计的影响**。

状态的意思：

- ✅ **已确认**：在官方文件里找到明确的文字。
- 🟡 **部分确认**：找到了一部分，或者只看到搜索结果里的官方文件摘录（这个开发环境连不上该网站，没办法打开原页）。请你自己再点进去看一次。
- ❓ **我不确定**：官方文件里找不到。设计上做了防护，并会在 VM 上用自检程序实测。

> 这个开发环境连不上 `vercel.com`、`developers.cloudflare.com`、`developer.mozilla.org` 和 `support.claude.com`。这几个网站的结论来自搜索引擎对官方页面的摘录，所以标成 🟡。浏览器支持度改用 MDN 官方的 `@mdn/browser-compat-data`（npm 套件 v8.1.5）直接查询。

---

## 1. Pro 计划能否在 Claude Code 用 Haiku 5.5、model ID、最低 CLI 版本

| 子项 | 结论 | 状态 |
|---|---|---|
| model ID | `claude-haiku-5-5`（官方文件原文：「Its model ID is `claude-haiku-5-5`.」）；别名 `haiku` 在 Anthropic API 上也指向 Haiku 5.5 | ✅ |
| 最低版本 | 「Use v2.1.293 or later with Haiku 5.5.」；版本历史表：v2.1.293 起 `haiku` 指向 Haiku 5.5 | ✅ |
| Pro 能不能用 | 文件里**没有**「哪个计划能用哪个模型」的对照表。只写了 Pro/Max/Team/Enterprise 的默认模型是 Opus 5.5 | ❓ 我不确定 |

- 来源：<https://code.claude.com/docs/en/model-config>
- 对设计的影响：模型由 VM 上的 `ticket-types.json` 决定（§2），默认 `claude-haiku-5-5`。VM 上的自检服务 `vesper-selftest.service` 会用你的 token 真正跑一次，如果 Pro 不能用 Haiku 5.5，自检会失败并告诉你。另外 apt 的 `stable` 频道大约落后一周，若版本低于 2.1.293，要改用 `latest` 频道（见 vm-setup）。

## 2. `claude -p` 的参数

| 需求 | 参数 | 状态 |
|---|---|---|
| 指定模型 | `--model <别名或完整 model ID>` | ✅ |
| 关闭所有内建工具 | `--tools ""`（原文：「Use `""` to disable all」）。注意：这个参数**不影响 MCP 工具** | ✅ |
| 不载入任何 MCP server | `--strict-mcp-config` 且不给 `--mcp-config`；另设 `ENABLE_CLAUDEAI_MCP_SERVERS=false` 与 settings 的 `disableClaudeAiConnectors: true`（关掉 claude.ai connectors） | ✅ |
| 从 stdin 读内容 | 文件原文：「Non-interactive mode reads stdin」，示例 `cat file \| claude -p "query"`；stdin 上限 10MB | ✅ |
| 输出格式 | `--output-format json`，文字结果在 `result` 字段；还有 `text`、`stream-json` | ✅ |
| 失败判断 | 成功 exit 0、失败非 0；**但**「执行中发生的失败（例如没有认证）会以 result 的形式印在 stdout」 | ✅ |
| 不写 transcript | `--no-session-persistence`（只限 print mode） | ✅ |
| 关闭 skills / slash commands | `--disable-slash-commands` | ✅ |
| 取代系统提示 | `--system-prompt-file <路径>`；文件说明非程序码用途的 pipeline 适合用取代 | ✅ |
| `--bare` 能不能用 | **不能**：「Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`」 | ✅ |
| 不受工作目录影响 | 文件警告：不加 `--bare` 时，`-p` 会执行该目录 `.claude/settings.json` 的 hooks、连 `.mcp.json` 的 server。所以 worker 在一个**空的专用目录**执行 claude | ✅ |

- 来源：<https://code.claude.com/docs/en/cli-reference>、<https://code.claude.com/docs/en/headless>
- 对设计的影响：worker 的调用方式（`worker/src/processor.ts`）：

  ```
  claude -p "<固定的一句说明>" --model <model> --tools "" --strict-mcp-config
         --disable-slash-commands --no-session-persistence --permission-mode dontAsk
         --output-format json --system-prompt-file <worker 附带的静态文件>
  ```

  偏好、模板和你的需求全部经 stdin 传入，不出现在命令行参数（`ps` 看不到）。因为失败时也可能 exit 0 并把错误印成 result，worker 会同时检查 exit code、JSON 的 `is_error` 和 `subtype`。

## 3. `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` 的有效期与撤销

| 子项 | 结论 | 状态 |
|---|---|---|
| 有效期 | 一年（「generate a one-year OAuth token」） | ✅ |
| 需要的计划 | Pro、Max、Team 或 Enterprise | ✅ |
| 权限范围 | 「It can only make model requests」（不能开 Remote Control，也不能取 claude.ai connectors） | ✅ |
| 保存 | 只印在终端，不会自动存到任何地方 | ✅ |
| 撤销 | Claude Code 文件没有写。Anthropic 帮助中心（搜索摘录）说：在 claude.ai 的 **Settings > Claude Code** 可以看到授权 token，按垃圾桶图示即可移除。社群回报有人移除后 token 仍可用一段时间 | 🟡 / ❓ |

- 来源：<https://code.claude.com/docs/en/authentication>、<https://code.claude.com/docs/en/env-vars>、<https://support.claude.com/en/articles/10310342-how-do-i-log-out-of-all-active-sessions>（搜索摘录）
- 对设计的影响：token 放在 `/etc/vesper/claude-oauth-token`（root、0600），经 systemd `LoadCredential=` 交给 worker，worker 只把它放进 claude 子进程的环境变量。vm-setup 会提醒你：一年后要换；若怀疑外泄，到 Settings > Claude Code 删除，并用 VM 自检确认旧 token 已失效。

## 4. `cleanupPeriodDays`；`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 是否影响 `-p`

| 子项 | 结论 | 状态 |
|---|---|---|
| `cleanupPeriodDays` 怎么设 | 写在 settings.json（任何一层设定档都可）；整数天数，**最小 1**，默认 30，设 0 会验证失败 | ✅ |
| 它删什么 | `~/.claude/projects/` 下的明文 transcript 等资料 | ✅ |
| 完全不写 transcript | `--no-session-persistence`（-p 专用）或 `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` | ✅ |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 关掉什么 | 自动更新、telemetry、错误回报、`/feedback`、release notes、可用性检查、feature flag 读取等。清单里**没有**模型请求 | ✅ |
| 会不会影响 `-p` | 文件没有特别针对 `-p` 说明；描述适用于所有模式，且列出的项目都不是模型请求 | ❓ 没有明文保证，自检实测 |

- 来源：<https://code.claude.com/docs/en/settings-reference>、<https://code.claude.com/docs/en/claude-directory>、<https://code.claude.com/docs/en/data-usage>、<https://code.claude.com/docs/en/env-vars>
- 对设计的影响：worker 在 claude 的设定目录写入 `{"cleanupPeriodDays": 1, "disableAllHooks": true, "autoMemoryEnabled": false, "disableClaudeAiConnectors": true}`，同时加 `--no-session-persistence` 和 `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`，双重保证不留 transcript。

## 5. Claude Code 运行时实际需要连的网域

官方「Network access requirements」表（节录与本系统有关的）：

| 网域 | 用途 | Vesper 需要吗 |
|---|---|---|
| `api.anthropic.com` | Claude API 请求、feature flag、telemetry | **需要** |
| `claude.ai` | claude.ai 帐号认证 | **需要**（Build Spec 白名单已列） |
| `platform.claude.com` | Console 认证；**claude.ai 帐号的 OAuth token 交换、更新、撤销也走这里** | **需要**（Build Spec 白名单已列） |
| `claude.com` | 登入时浏览器打开的页面（浏览器端，不是 VM） | VM 不需要 |
| `downloads.claude.ai` | 安装、更新、apt 仓库 | 只在你手动更新时暂时开放 |
| `mcp-proxy.anthropic.com` | claude.ai connectors | 不需要（已关闭） |
| `http-intake.logs.us5.datadoghq.com`、`browser-intake-us5-datadoghq.com` | 可选的 telemetry 与错误回报 | 不需要（已用环境变量关闭） |
| `registry.npmjs.org` | npm 安装 | 只在安装 worker 依赖时暂时开放 |

- 来源：<https://code.claude.com/docs/en/network-config>
- 结论：✅ Build Spec §16.4 的白名单（`api.anthropic.com`、`platform.claude.com`、`claude.ai` 加你的 Vercel 网域）与官方文件一致。

## 6. Consumer Terms 对用订阅跑 `claude -p` 的规定（只引用原文，不做法律判断）

- **适用哪份条款**：Claude Code 文件写明 Free、Pro、Max 用户适用 [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)。✅
- **Consumer Terms（2025-10-08 生效）第 3 节第 7 点**，列为不可以做的事：「Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.」✅
- **Claude Code 的 Legal and compliance 页**：「OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.」以及「Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.」✅
- **Claude Code 的 Authentication 页**介绍 `claude setup-token` 时写：「For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token」，并说明这个 token 需要 Pro/Max/Team/Enterprise 计划。✅
- 来源：<https://www.anthropic.com/legal/consumer-terms>、<https://code.claude.com/docs/en/legal-and-compliance>、<https://code.claude.com/docs/en/authentication>
- 另外一点（资料保留）：Pro/Max 帐号如果开启「允许用资料改进模型」，资料保留 5 年；关闭则 30 天。你的偏好和需求都会送进模型，建议到 <https://claude.ai/settings/data-privacy-controls> 确认这个设定。✅（来源：<https://code.claude.com/docs/en/data-usage>）

以上只是原文。条款怎么适用于你的用法，请你自己判断。

## 7. HPKE 的 JS 实现：成熟度与维护状况

| 套件 | 状况 |
|---|---|
| **`hpke`**（panva，**选用**） | v1.1.7（2026-09-05）；v1.0.0 于 2025-12 发布，2026 年几乎每月都有更新；**零依赖**；支持 DHKEM(P-256, HKDF-SHA256)、HKDF-SHA256、AES-256-GCM（Node、浏览器都可）；README 写明用规格的 test vectors 测试；**私钥默认 non-extractable**；作者也是 `jose` 套件的维护者 |
| `@hpke/core`（dajiaji） | v1.9.0（2026-03）；自 2022 年就存在，支持同样的套件；依赖 `@hpke/common`；README 写明通过 RFC 9180 test vectors，并写明「has not been formally audited」 |

- 两者我都没找到正式的第三方安全审计。❓
- 对设计的影响：选 `hpke`。我们自己也加了测试：用 RFC 9180 官方 test vector 的密钥与密文，确认解密结果和 RFC 一致；web 与 worker 互相解密对方的封包（见 `tests/core/`）。
- 来源：<https://github.com/panva/hpke>、<https://github.com/dajiaji/hpke-js>、npm registry

## 8. iOS Safari PWA：WebCrypto ECDH/ECDSA P-256、IndexedDB 存 CryptoKey、存储被清除的条件

| 子项 | 结论 | 状态 |
|---|---|---|
| WebCrypto 基本支持 | MDN 兼容资料：iOS Safari 的 `SubtleCrypto.generateKey/sign/importKey/exportKey` 自 iOS 7、`deriveBits` 自 iOS 11、`CryptoKey` 自 iOS 9 | ✅ |
| 把 CryptoKey 存进 IndexedDB | 规范允许 CryptoKey 结构化复制，但 **CryptoKeyPair 不行**（WebKit bug 164868 维护者明确说明）。iOS 现况：找不到官方的现行确认 | ❓ 我不确定 |
| Home Screen 上的 web app 会不会被 7 天规则清掉 | WebKit 官方：「The first-party domain of Home Screen web applications is exempt from ITP's 7-day cap on all script-writeable storage」 | ✅ |
| 其他清除条件 | Safari 17 起每个 origin 的配额依磁盘大小计算，存储模式是 persistent 的 origin 不会被自动清除；`navigator.storage.persist()` 自 iOS 15.2 可用。你从主屏幕删掉 App、或在设定里清除网站资料，资料一定会消失 | ✅ / 🟡（最后一句是一般常识，没找到官方原文） |
| 主屏幕 App 和 Safari 的存储是否共用 | **不共用**。WebKit bug 181849（2018 年提出，至今仍是 NEW）重现了「Safari 存的值，在主屏幕 App 读到 null，反之亦然」；2022 年一位 WebKit 工程师留言说这是刻意的设计。WebKit 对 7 天上限的说明也写：加到主屏幕的 web app 不属于 Safari，有自己的使用天数计数。另有开发者回报，主屏幕 App 实际上仍遇过 7 天清除（2022 年，iOS 15.3） | 🟡（搜索摘录） |

- 来源：<https://webkit.org/tracking-prevention/>、<https://webkit.org/blog/14445/webkit-features-in-safari-17-0/>、<https://bugs.webkit.org/show_bug.cgi?id=164868>、<https://bugs.webkit.org/show_bug.cgi?id=181849>（搜索摘录）、`@mdn/browser-compat-data` 8.1.5
- 对设计的影响：
  1. 每把 CryptoKey 分开存，不存 CryptoKeyPair。
  2. 产生密钥后**立刻自检**：存进 IndexedDB → 重新打开数据库读出 → 签一段测试资料并验证 → 用 HPKE 加解密一次。任何一步失败就停止设置并告诉你。
  3. 设置完成后呼叫 `navigator.storage.persist()`。
  4. 如果密钥真的不见了，按 §11.5 在 VM 撤销旧设备再重新配对。
  5. iPhone 要**从主屏幕的图示**开始设置（PWA 在 Safari 里开启时会提醒你），因为两边的存储不共用。

## 9. iOS PWA 的 Web Push 现况

| 子项 | 结论 | 状态 |
|---|---|---|
| 支持版本 | iOS / iPadOS 16.4 起，**只限加到主屏幕的 web app** | ✅ |
| 权限 | 只能在用户直接操作（例如按按钮）时请求 | ✅ |
| manifest | `display` 要是非默认值（standalone） | ✅ |
| 推送服务 | 走 Apple Push Notification service；endpoint 网域是 `*.push.apple.com` | ✅ |
| Declarative Web Push | iOS 18.4 起可用（不需要 service worker）；本系统仍用 service worker 的标准做法，两者都相容 | ✅ |
| Apple Watch 会不会收到 | 官方文件没有写；第三方说法是与原生 App 通知一样会出现在配对的 Apple Watch | ❓ 我不确定，需实测（§19 验收 1） |

- 来源：<https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>、<https://webkit.org/blog/16535/meet-declarative-web-push/>、`@mdn/browser-compat-data`

## 10. Vercel Hobby：函式 timeout、调用次数、cron、geo header、是否限非商业用途

| 子项 | 结论 | 状态 |
|---|---|---|
| 函式执行时间 | 开启 Fluid compute（2025-04-23 起新专案默认开启）时，Hobby 默认与上限都是 300 秒 | 🟡 |
| 调用次数 | 每月 1,000,000 次；Active CPU 4 小时；Provisioned Memory 360 GB-hrs | 🟡 |
| cron | Hobby 只能每天跑一次（更频繁的表达式会在部署时失败），而且触发时间可能落在该小时内的任何一分钟；数量上限各页写法不一致（2 个或每专案 100 个） | 🟡 |
| geo header | `x-vercel-ip-country`；Vercel 会覆盖客户端送来的 `X-Forwarded-For`，防止伪造 IP | 🟡 |
| 非商业用途 | Fair Use Guidelines：Hobby 只限「non-commercial personal use」，商业用途要用 Pro | 🟡 |

- 来源（都是 vercel.com 官方页面的搜索摘录）：<https://vercel.com/docs/limits>、<https://vercel.com/docs/functions/configuring-functions/duration>、<https://vercel.com/docs/cron-jobs/usage-and-pricing>、<https://vercel.com/docs/headers/request-headers>、<https://vercel.com/docs/limits/fair-use-guidelines>
- 对设计的影响：v1 不需要 cron（过期、stale、lease 退回都用惰性判断）；v2 的保留期删除每天跑一次正好符合限制。worker 每 30 秒拉一次 ≈ 每月 86,400 次调用，远低于 100 万。

## 11. D1 REST API 的速率限制

| 子项 | 结论 | 状态 |
|---|---|---|
| endpoint | `POST /accounts/{account_id}/d1/database/{database_id}/query`（另有 `/raw`） | 🟡 |
| body | `{ "sql", "params" }` 或 `{ "batch": [ {sql, params}, … ] }`；`params` 的型别是**字串数组**；一个 `sql` 里用分号隔开的多个语句会当成 batch 执行 | 🟡 |
| 速率限制 | 走 Cloudflare API 的全域限制：**每个用户每 5 分钟 1,200 次**，所有 API 调用累计；超过后**所有** API 调用被挡 5 分钟（HTTP 429） | 🟡 |
| 官方定位 | Cloudflare 的教程写：内建 REST API「best suited for administrative use as the global Cloudflare API rate limit applies」 | 🟡 |
| 每日额度 | 2026-09-01 起，Workers Free 方案超过每日读写列数上限时，经 REST 的查询也会失败，直到 UTC 午夜重置 | 🟡 |
| REST batch 是否是交易 | Worker binding 的 batch 是交易；REST batch 的文件没有说清楚 | ❓ 我不确定 |

- 来源：<https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/>、<https://developers.cloudflare.com/fundamentals/api/reference/limits/>、<https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/>、<https://developers.cloudflare.com/changelog/>（皆为搜索摘录）
- 对设计的影响：
  1. 估算：worker 每 30 秒拉一次，每次 1–2 个 D1 请求 ≈ 每 5 分钟 20 次；加上你在手机上的操作，远低于 1,200。但如果同一个 Cloudflare 帐号还有别的程序在用 API，会一起计算。
  2. 每个 Vercel 请求尽量把多个 SQL 合成一个 batch 请求。
  3. 不依赖 REST batch 的交易语义：所有需要原子性的动作都写成单一 SQL 语句。
  4. 这是你在 OD1 已经做的决定，我只是把风险告诉你：如果将来用量变大，可以改成在 Cloudflare 放一个 Worker 用 binding 访问 D1（只需换掉 db adapter）。

## 12. `age` 在 Ubuntu 26.04 的安装方式

- 结论：Ubuntu 26.04（resolute）的 **universe** 仓库有 `age 1.2.1-1build1`，安装指令 `sudo apt install age`。✅（直接查了 `archive.ubuntu.com` 的套件索引）
- 来源：<http://archive.ubuntu.com/ubuntu/dists/resolute/universe/binary-amd64/Packages.xz>、<https://github.com/FiloSottile/age>
- 顺便查到：同一个仓库有 `nodejs 22.22.1`（universe）、`squid 7.2`（main）、`tinyproxy 1.11.3`（universe）、`nftables 1.1.6`、`openssh-server 10.2p1`、`unattended-upgrades`。

## 13. VMware Workstation 25H2 的 Auto Start 设定位置

- 结论（25H2 官方用户手册）：
  1. 在 Windows 的「服务」（`services.msc`）里把 **VMware Autostart Service** 设为「自动」。
  2. 在 Workstation 的 Library 里，**右键「My Computer」→「Configure Auto Start VMs」**，勾选 VM、设定启动顺序。
  3. **加密的 VM 不能设定 Auto Start**。
- 状态：🟡（Broadcom techdocs 的搜索摘录）
- 来源：<https://techdocs.broadcom.com/us/en/vmware-cis/desktop-hypervisors/workstation-pro/25H2/using-vmware-workstation-pro/using-virtual-machines-in-workstation-pro-user-guide/starting-virtual-machines/enable-autostart-for-virtual-machine.html>、<https://knowledge.broadcom.com/external/article/315614/>

---

## 额外查到、会影响实现的事

| 事项 | 结论 | 来源 |
|---|---|---|
| Node `crypto.argon2()` | Node v24.7.0 加入，支持 argon2id；用 RFC 9106 §5.3 的 Argon2id test vector 验证（`tests/web/server-crypto.test.ts`） | <https://nodejs.org/docs/latest-v24.x/api/crypto.html> |
| Node 22 的 TypeScript | Node 22.22 默认开启 type stripping，可以直接执行 `.ts` | 本地实测 |
| Node 的 proxy 支持 | `NODE_USE_ENV_PROXY=1` 让内建 `fetch` 走 `HTTPS_PROXY`；Node 22.22 已支持 | 本地实测 |
| Claude Code 的 proxy | 支持 `HTTPS_PROXY`；不支持 SOCKS；`CLAUDE_CODE_PROXY_RESOLVES_HOSTS=1` 让 proxy 负责 DNS 解析 | <https://code.claude.com/docs/en/network-config>、<https://code.claude.com/docs/en/env-vars> |
| Claude Code 的 apt 仓库 | `downloads.claude.ai/claude-code/apt/stable`，签名密钥指纹 `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`；apt 安装不会自动更新。vm-setup/06 的指令一字不改地取自官方页面（2026-10-14 再确认一次） | <https://code.claude.com/docs/en/setup> |
| `claude setup-token` 在 SSH 上怎么用 | 与 `/login` 相同的浏览器授权流程；浏览器若显示一段 code，就贴回终端的 `Paste code here if prompted`（官方文件说明经由 SSH 时常会这样）；token 只印在终端、不会被存起来 | <https://code.claude.com/docs/en/authentication> |
| Claude Code 的认证优先顺序 | `ANTHROPIC_API_KEY` 的优先权**高于** `CLAUDE_CODE_OAUTH_TOKEN`；worker 给子进程的环境变量是白名单式的，不会有 `ANTHROPIC_API_KEY` | 同上 |
| Vercel：Root Directory 以外的档案 | 选项名称「Include source files outside of the Root Directory in the Build Step」，2020-08-27 之后建立的专案默认开启 🟡（搜索摘录）。npm workspaces 在 Root Directory 为 `web` 时怎么安装：**我不确定**（README 给了备案设定） | <https://vercel.com/docs/monorepos/monorepo-faq> |
| 本文件没有拿到 Blueprint | `Vesper_Blueprint_20261013.html` 没有上传到这次对话，所以我没办法检查两份文件有没有冲突 | — |
