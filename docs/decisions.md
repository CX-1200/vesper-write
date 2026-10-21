# 决定记录（decisions）

本文件分两部分：

1. **用户的决定**：Build Spec §20 的 OD1–OD7，用户已于 2026-10-13 全部回答，照表实现。
2. **实现层面的决定**：Build Spec 没有写死、需要在写代码时定下来的细节。每一项都写了理由。这些都没有改变 Build Spec 的要求；如果你不同意其中任何一项，告诉我，我再改。

---

## 1. 用户的决定（§20）

| # | 问题 | 用户的决定 |
|---|---|---|
| OD1 | 数据库 | Cloudflare D1（从 Vercel 用 REST 访问） |
| OD2 | 认证方式 | **密码 + TOTP** 为主要方式；**passkey 为可选的额外方式**。无论哪种，都还要加设备签名（§11）。密码用慢哈希（argon2id）保存，登录失败计入 R3 |
| OD3 | 封锁超时 T | 20 分钟 |
| OD4 | Vercel 上的密文 ticket 用完后保留几天 | 3 天 |
| OD5 | 活跃时段 | 不设固定活跃时段，改设**非活跃时段 00:00–07:00（Asia/Kuala_Lumpur）**。非活跃时段内的登录或操作，要求再输入一次 TOTP（step-up）；不通过或不回应，转为 SUSPICIOUS（见 §12 R5） |
| OD6 | 每日 ticket 上限 | 50，日后视需要调整（写成设定值） |
| OD7 | 电脑关着时，ticket 最长排队多久 | 72 小时，超过就标记为 stale 并提醒用户 |

这些值集中写在 `packages/core/src/config.ts`，改设定只需要改那一个文件。

> **提醒（OD2 / OD5）：**如果 TOTP 验证器和 PWA 在同一支手机上，偷走已解锁手机的人也可能通过 step-up 验证。建议把 TOTP 放在另一台设备。

---

## 2. 实现层面的决定

### 2.1 加密与签名

| 决定 | 理由 |
|---|---|
| HPKE 使用 npm 套件 `hpke`（作者 Filip Skokan / panva，v1.1.7，零依赖） | §8.2 的首选路线。它直接建立在 WebCrypto 上，浏览器和 Node 用同一份代码；**私钥默认 non-extractable**，正好符合 §8.1；`Open()` 接受 KeyPair，所以 non-extractable 私钥也能解密。查证过程见 `docs/verification.md` 第 7 项。 |
| 套件：`DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM`，mode base | §8.2 指定。 |
| 封包的 `alg` 字串为 `HPKE-Base-P256-SHA256-A256GCM`；封包里**没有** `iv` 字段 | HPKE 的 nonce 由密钥排程（key schedule）导出，不需要另外传 IV（§8.3 写的是「若适用」）。 |
| HPKE 的 `info` 参数设为 `vesper/in/v1` 或 `vesper/out/v1` | 让两个方向的密钥派生互相分开（domain separation），是 RFC 9180 建议的用法。 |
| 所有签名内容前面都加一个固定前缀：请求签名 `vesper/req/v1`、输出签名 `vesper/outsig/v1`、批准签名 `vesper/approve/v1`、撤销签名 `vesper/revoke/v1` | 防止「拿 A 用途的签名冒充 B 用途」（跨协议签名重用）。和 AAD 已经有 `vesper/in/v1` 前缀是同一个做法。 |
| 用 `\|` 串接字段时，每个字段都先检查不含 `\|`，否则拒绝 | 避免两组不同的字段串成同一个字串（拼接歧义）。 |
| 设备请求签名里的 `path` 包含 query string（例如 `/api/audit?view=full`） | 否则 GET 的参数可以被改掉而签名仍然有效。 |
| `POST /api/tickets` 的 body 必须是 canonical JSON（键按字母排序、无空白），服务器会检查「原始 body == canonical(解析结果)」 | VM 要重新计算 `sha256(body)` 来验设备签名，所以 body 必须能被一模一样地重建。 |
| VM → 设备的明文除了 `prompt`、`lint`、`model`，另外加 `raw_input`、`truncated`、`limits` | §19 验收 2 要求审核页显示「原始需求」，但原始需求是加密给 VM 的，其他设备解不开；由 VM 在输出里附上，任何一台已批准的设备都能看到。`truncated` 和 `limits` 让设备端能独立重跑 L6（§10 要求 VM 和设备各跑一次 lint）。 |
| 指纹：公钥一律先转成 SPKI DER（从 JWK 的 x、y 按固定格式重建），`SHA-256(sign_spki ‖ enc_spki)` 取前 120 bits，当成一个大整数，取它除以 10^30 的余数，补零成 30 位，分 6 组、每组 5 位 | 符合 §8.5「前 120 bits、6 组 5 位数字」。自己从 JWK 重建 SPKI，保证浏览器、iOS、Node 产生的字节完全相同。30 位十进制数约等于 99.7 bits，足够防止伪造指纹。 |
| 设备的公钥用 JWK 传输与保存（§5.1）；IndexedDB 里**分别**保存每一把 CryptoKey，不保存 CryptoKeyPair 对象 | WebCrypto 规范只定义了 CryptoKey 的结构化复制，CryptoKeyPair 不能放进 IndexedDB。 |

### 2.2 认证与 secret

| 决定 | 理由 |
|---|---|
| 密码与所有 token（setup、recovery、break-glass、kill、worker）都用 **argon2id**，使用 Node ≥ 24.7 内建的 `crypto.argon2()`，不另装套件 | OD2 指定 argon2id；内建函式等于零依赖。Vercel 端因此需要 Node 24（`web/package.json` 的 `engines`）。 |
| argon2id 参数：密码 `m=64 MiB, t=3, p=1`；高熵 token `m=19 MiB, t=2, p=1` | 密码可能熵不高，用较重的参数；token 是 256-bit 随机值，用 OWASP 建议的最低参数即可，避免 worker 每 30 秒一次的验证太耗资源。 |
| TOTP：RFC 6238，SHA-1、6 位数、30 秒，允许 ±1 个时间窗；同一个时间窗的验证码只能用一次 | 与一般验证器 App（Google Authenticator、1Password、iOS 密码 App）相容；「只能用一次」防止验证码被重放。 |
| TOTP secret 在数据库里用 AES-256-GCM 加密，密钥放在 Vercel 的 Sensitive env var `TOTP_ENC_KEY` | TOTP secret 不能只存哈希（服务器要用它算验证码），所以改成加密存放：D1 被读走时拿不到 TOTP secret。 |
| 新增 `owner` 表（单行）存密码哈希与加密后的 TOTP secret | §5.1 没有地方放这两个值；OD2 需要它们。 |
| setup token 放在 Vercel env `SETUP_TOKEN`（§11.1 第 1 步），设置完成后在 `secrets_meta` 记下它的哈希与 `used_at`，之后任何人拿同一个 token 都会被拒绝 | 「setup token 立即失效」。设置完成后也请你从 Vercel 删掉这个 env var。 |
| recovery key、break-glass key、kill token 都在**你的设备上**用安全随机数产生，只显示一次，服务器只收到并保存它们的 argon2id 哈希 | 服务器从头到尾不需要知道明文以外的东西；随机产生比人自己想的强得多。 |
| recovery key 用过一次（登记新设备）就失效，PWA 会提示你产生新的 | §5.1「用过一次就失效或必须更换」。 |
| worker token 由 `vesper init` 在 VM 上产生，经 HTTPS 送到 Vercel 一次（Vercel 只存哈希），之后放在 systemd credential `/etc/vesper/worker-token` | §18 要求 secret 只存在 systemd credential。 |
| **R7 只在「worker token 正确、但 VM 签名不对」时触发 LOCKDOWN**；worker token 本身就错的请求，当一般认证失败处理（计入 R3） | 否则网络上任何人随便发一个垃圾请求到 `/api/worker/pull`，就能让整个系统进入 LOCKDOWN（阻断服务攻击）。R7 要抓的是「worker token 被偷、但 VM 私钥没被偷」的情况。 |
| Session cookie 名称 `__Host-vesper_sid`，`HttpOnly; Secure; SameSite=Strict; Path=/`，有效 12 小时；数据库只存 SHA-256(session id) | §5.1、§18。`__Host-` 前缀让浏览器拒绝任何子域或非 HTTPS 设定同名 cookie。 |

### 2.3 设备批准的流程（VM 端）

| 决定 | 理由 |
|---|---|
| `vesper device approve` / `revoke` 只改本地的 `trusted-devices.json`，并把一份**由 VM 签名**的批准或撤销记录放进本地 outbox；正在运行的 worker 下一次拉取时把它送到 `/api/worker/device-approval` | 这样 CLI 完全不需要碰网络和 worker token；所有对外连接都只来自 systemd 沙箱里的 worker。信任根仍然是 VM 本地的 `trusted-devices.json`。 |
| 待批准设备的清单由 worker 从 `/api/worker/pull` 取得并缓存在本地；**指纹一律由 VM 自己从公钥重新计算**，不采用 Vercel 给的指纹 | Vercel 不可信；只有你在两个屏幕上肉眼比对的指纹才算数。 |
| 批准时，CLI 要求你输入「设备屏幕上指纹的最后一组 5 位数字」，再输入 `yes` | 逼你真的去看设备屏幕，而不是直接按 Enter。 |

### 2.4 数据库（D1 REST）

| 决定 | 理由 |
|---|---|
| 所有 SQL 参数都转成字串再送出；SQL 里需要 NULL 时直接写 `NULL`，不经过参数 | D1 REST API 文件把 `params` 定义为「字串数组」（见 verification 第 11 项）。本地测试用的 SQLite adapter 也故意做同样的转换，确保测试与正式环境行为一致。 |
| 认领 ticket 用单一 SQL 语句 `UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING …` | 单一语句在 SQLite 里本身就是原子的；不依赖 REST batch 的交易语义（文件没有说清楚）。 |
| 时间一律存 UTC 毫秒（INTEGER），显示时转为 Asia/Kuala_Lumpur | §5.1。 |
| 「每日 ticket 上限」的「一天」以 Asia/Kuala_Lumpur 的日历日计算 | 你在吉隆坡时区生活。 |

### 2.5 VM 上的执行环境

| 决定 | 理由 |
|---|---|
| worker 用 Ubuntu 官方仓库的 `nodejs` 执行**编译好的 JavaScript**（`worker/dist/`、`packages/core/dist/`，commit 在 repo 里，经由 `--conditions=vesper-js` 载入）；CI 检查 `dist/` 与原始码重新编译的结果逐字相同（2026-10-21 你选择的方案 B） | Ubuntu 的 `nodejs` 不支持直接执行 TypeScript（实测 `process.features.typescript` 为 `false`）。这样 VM 仍然不需要建置工具链，Node 的安全更新也由 Ubuntu 自动处理。 |
| Claude Code 用官方 apt 仓库安装（`downloads.claude.ai`，有 GPG 签名；安装前比对签名密钥指纹） | 二进位档由 root 拥有，`vesper` 用户改不了；apt 会验签；不会自动更新。apt 以 root 执行，不受 `vesper` 的出站规则限制，所以更新时**不需要**放宽规则（§16.4 的「暂时放宽」在这个设计下用不到）。 |
| 调用 `claude -p` 时，子进程的 `HOME` 指到 `~/.local/share/vesper/claude-home`，`CLAUDE_CONFIG_DIR` 指到其下的 `.claude`，并在空的工作目录执行 | Claude Code 想写的东西都落在沙箱允许写入的目录；空的工作目录确保不会读到任何 `.claude/settings.json`、`.mcp.json` 或 CLAUDE.md。 |
| 出站 proxy 建议用 **squid**（Ubuntu main 仓库，Canonical 安全团队维护）；tinyproxy 作为备选 | 比较见 `vm-setup/04-proxy.md`。**你已于 2026-10-18 确认使用 squid。** |
| worker 唯一的第三方依赖（`hpke`）用 `vm-setup/scripts/install-worker-deps.sh` 安装，不在 VM 上装 npm；脚本只下载 `package-lock.json` 锁定的版本，先比对 sha512 才解开 | Ubuntu 的 `npm` 套件会带进几百个 `node-*` 套件，对信任根这台 VM 来说攻击面太大。 |
| 防火墙用 nftables（不用 ufw）；入站只让 Windows 主机的 VMnet8 位址连 SSH | ufw 不支持「依用户」的出站规则；只用一套工具避免规则互相干扰。只开放给主机（而不是整个 NAT 网段），同网段的其他 VM（例如 Kali）也连不进来。 |
| systemd：`ProtectHome=tmpfs`，只把内容 repo（唯读）和资料目录（可写）挂回来；`IPAddressAllow=127.0.0.1`；用 `InaccessiblePaths=` 藏起 systemd-resolved 与 D-Bus 的 socket；加启动次数上限 | 比 §16.3 的范例（`ProtectHome=read-only`）更严：worker 看不到任何其他家目录。nftables 只管封包，经由 systemd-resolved 本机 socket 的 DNS 查询挡不到，藏起 socket 才能堵住 DNS 外传。离线估算的 `systemd-analyze security` 分数 1.1。 |
| `~/vesper-content` 由 `vesper` 拥有、经 `sudo -u vesper -i` 编辑；worker 经 systemd 唯读挂载；`vesper content check` 检查类型、模板与「其他用户能不能写入」；pre-push hook 拒绝任何推送 | §4「只能由用户 commit；worker 只读」。其他用户能写入模板，等于能改写每一段 prompt。 |
| `sshd` 不写死 `ListenAddress`（可选） | VM 只有一张 NAT 网卡，默认监听就等于「只有 NAT 网卡」；写死位址需要固定 IP，设错会把你锁在外面。 |

### 2.6 PWA（手机端）

| 决定 | 理由 |
|---|---|
| setup token 只存在设置页面的内存里；中断后继续设置要重新输入 | 它是 secret，不该存进 IndexedDB 或 localStorage。 |
| iPhone 必须从「主屏幕」的 Vesper 图示开始设置（在 Safari 里开启时会提醒） | 主屏幕 App 和 Safari 的存储是分开的；在 Safari 产生的密钥，主屏幕 App 用不到。 |
| TOTP 密钥以文字显示，请你在**另一台设备**的验证器手动输入；不显示 QR code | 不增加 QR code 依赖；也顺势鼓励 TOTP 放在别的设备（OD2）。如果你想要 QR code，告诉我（有零依赖的小套件可选）。 |
| 审阅页的标记以**设备端** lint 为准，和 VM 的结果不同时另外提示；`claude_code` + 高严重度时复制要再确认一次；高严重度规则编号只在第一次打开时回报（审计日志不重复） | §10。 |
| 「复制」和「已使用 / 拒绝」是分开的按钮；已过期的任务仍可查看与复制，但不能再改状态 | 复制不代表一定执行；12 小时的审阅期限到了，状态就固定。 |
| 新需求不存草稿 | 明文不该留在设备的任何存储里。 |
| 「每日第一次打开时提醒过期／排队超时」用 localStorage 只记日期和时间戳 | §6.1；不含任何内容。 |
| 首页比对 Vercel 回报的 VM 公钥和配对时保存的；不同时显示警告，但**继续只用配对时的公钥** | §8.4「设备不在配对之后再从 Vercel 取 VM 公钥」。 |
| `/kill` 页面不需要登录、不需要设备密钥 | §7：kill switch 是例外，任何浏览器都要能用。 |

### 2.7 稳健性与其他

| 决定 | 理由 |
|---|---|
| VM 回报 R8 时附上 ticket id，Vercel 立刻把那张 ticket 设为 `failed`（`vm_rejected`；状态机新增这条转换） | 否则 lease 到期后它会回到 pending，你手动解锁后 VM 又会拉到它、再次上锁。 |
| ticket 类型清单（key 与中文名称）移到 `packages/core`，web 与 worker 共用 | `vesper content check` 才能检查 VM 上的 `ticket-types.json` 和 Vercel 的清单一致。 |
| CSP 的 `upgrade-insecure-requests` 只在 https 时加上 | 本地 `next start`（http://localhost）测试时不会把资源升级成连不上的 https。 |
| argon2id 的 PHC 字串用标准 base64（无 padding） | PHC 格式规定的写法，其他 argon2 工具也能验证。 |
| `gen-secrets` 把 secret 写进档案（700/600 权限、拒绝写在 repo 里面），**不印出任何值** | §0 第 9 条：secret 不印出来。 |
| D1 建表用 `web/scripts/migrate.ts`，经 REST 一个语句一个语句执行 | REST 的多语句与交易语义文件没写清楚（verification 第 11 项）；每个语句都是 `IF NOT EXISTS`，可重复执行。 |
| 范例模板不写出具体的危险指令（例如删档、下载后执行） | 生成的 prompt 会原样带着这些字，每次都被 lint 标成高严重度，真正的警告反而容易被忽略。 |
| 浏览器端到端测试用 Playwright（找得到才跑），不列为专案依赖 | 只有测试需要；依赖越少越好（§0 第 7 条）。 |

### 2.8 依赖

| 套件 | 用在哪里 | 理由 |
|---|---|---|
| `next`、`react`、`react-dom` | web | §3 指定的框架。 |
| `hpke` | core（web 与 worker 共用） | HPKE（§8.2），零依赖。 |
| `@simplewebauthn/server`、`@simplewebauthn/browser` | web | §3 指定；passkey 是 OD2 的可选登录方式。WebAuthn 的验证细节很多，自己写风险高。 |
| `web-push` | web | §3 指定；处理 VAPID 与 RFC 8291 推送加密。 |
| `typescript`、`@types/*` | 开发时 | 型别检查，不进入执行时。 |

测试用 Node 内建的 `node:test`，本地开发用 Node 内建的 `node:sqlite` 模拟 D1，都不需要另外装套件。v1 期间没有新增任何依赖。
