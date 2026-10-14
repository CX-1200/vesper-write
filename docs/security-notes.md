# 各安全模块说明

Build Spec §0 第 4 条：每个安全相关模块，用三到五句话说明它**防的是什么**、**怎么防的**。括号里是程序码的位置，方便你对照着读。

---

## 一、密码学

### 1. 端到端加密（HPKE）

**防什么：** Vercel、Cloudflare 或任何能读数据库的人看到你的需求和 prompt。**怎么防：** 手机用 VM 的公钥加密需求（RFC 9180 HPKE：P-256 椭圆曲线交换出一次性的共享密钥，再用 AES-256-GCM 加密），只有持有 VM 私钥的 VM 解得开；VM 回写的 prompt 也分别用每台已批准设备的公钥加密。Vercel 从头到尾只经手密文。我们没有自己设计加密协议，用的是标准套件和成熟的实现，并用 RFC 官方的 test vector 验证。（`packages/core/src/envelope.ts`）

### 2. AAD 绑定

**防什么：** 能改数据库的人把 A ticket 的密文搬到 B ticket，或把「Claude.ai」改成「Claude Code」，让你在错的情境执行一段 prompt。**怎么防：** 加密时把 ticket id、类型、目标、设备 id、时间戳当成「附加验证资料」（AAD）一起计算认证标签；AAD 不会被加密，但只要任何一个字被改，解密就会失败。输出方向另外绑定「收件设备」和处理时间。（`inputAad`、`outputAad`）

### 3. 设备请求签名与防重放

**防什么：** 偷到 session cookie、或在网络上录下请求的人冒充你的设备。**怎么防：** 每个请求都用设备的 ECDSA P-256 私钥签名，签名内容是「方法 | 路径（含参数）| 时间戳 | 随机 nonce | body 的 SHA-256」，前面再加固定前缀避免签名被挪作他用。服务器检查签名、时间戳必须在 ±60 秒内、nonce 不能重复，所以录下的请求无法重送，cookie 单独被偷也没用。（`packages/core/src/sign.ts`、`web/lib/guard.ts`）

### 4. VM 签名（输出、批准、撤销）

**防什么：** 有人改掉数据库里 VM 写回的输出，或伪造「VM 已批准某台设备」。**怎么防：** VM 用自己的签名私钥签署全部输出封包（canonical JSON 的哈希）、每一次设备批准和撤销；手机只用配对时保存的 VM 公钥验证，验证失败就不显示内容，并向所有设备发出警报。所以 Vercel 或数据库被入侵，也无法让你看到假的 prompt，或让一台陌生设备混进来。（`signOutput`、`approvalSigningString`、`web/client/tickets.ts`）

### 5. 指纹比对与配对

**防什么：** 配对时的中间人攻击：攻击者把自己的公钥冒充成 VM 的（或手机的）。**怎么防：** 双方的公钥各自算出一组 6×5 位数字的指纹（SHA-256 的前 120 bits），你在两个屏幕上**用眼睛**逐组比对；手机显示的 VM 指纹是手机自己从公钥算的，VM 显示的设备指纹也是 VM 自己算的，都不采用 Vercel 给的数字。比对一致之后，双方才把对方的公钥存下来，之后不再从 Vercel 取用。批准时还要你输入设备上的最后一组数字，逼你真的去看。（`packages/core/src/fingerprint.ts`、`web/client/pairing.tsx`、`vesper device approve`）

### 6. 设备私钥的保存

**防什么：** 网页程序被注入恶意脚本时，把你的私钥整个读走带到别的地方用。**怎么防：** 私钥在浏览器里产生为「不可导出」的 CryptoKey，存进 IndexedDB；网页程序可以用它签名和解密，但任何程序（包括我们自己的）都读不出私钥本身。产生后立刻自我测试（重新读出、签一次、加解密一次），iOS 存储不可靠时会当场停止，而不是等到之后才发现。（`web/client/identity.ts`）

## 二、身分与存取

### 7. 密码 + TOTP + argon2id

**防什么：** 密码被猜中或数据库外泄后被离线破解。**怎么防：** 登录需要密码、TOTP 验证码**和**设备签名三者同时正确；密码用 argon2id 保存（64 MiB 内存、3 次迭代），每猜一次都很贵；TOTP 同一个时间窗的验证码只能用一次（防重放）。TOTP secret 必须可还原，所以改用 AES-256-GCM 加密存放，密钥在 Vercel 的环境变量里，只拿到数据库的人解不开。（`web/lib/server-crypto.ts`、`web/lib/totp.ts`、`web/lib/handlers/auth.ts`）

### 8. 只存哈希的 token 与 secret

**防什么：** 数据库外泄后，攻击者直接拿到可以用的 token。**怎么防：** setup token、recovery key、break-glass key、kill token、worker token 都只存 argon2id 哈希；验证时把你输入的值重新计算再比较。三组备用 secret 在你的手机上用安全随机数产生（160 bits），服务器只收到哈希。测试会把整个数据库倒出来，确认找不到任何明文。（`web/lib/owner.ts`、`secrets_meta` 表）

### 9. Session cookie

**防什么：** 脚本偷 cookie（XSS）、其他网站借你的登录状态发请求（CSRF）、子网域或明文 HTTP 设定同名 cookie。**怎么防：** cookie 设为 `HttpOnly`（JavaScript 读不到）、`Secure`（只走 HTTPS）、`SameSite=Strict`（其他网站发起的请求不会带上），名称用 `__Host-` 前缀（浏览器只接受本网域、HTTPS、Path=/ 设定的）。数据库只存 session id 的 SHA-256；而且每个请求还要设备签名，所以就算 cookie 外泄也不够用。（`web/lib/sessions.ts`）

### 10. 速率限制与 R3 封锁

**防什么：** 暴力猜测密码、TOTP、recovery key 或 kill token，以及大量请求把服务拖垮。**怎么防：** 每个来源 IP 每分钟有请求上限；10 分钟内认证失败 5 次（包括签名错误），这个来源就被封锁 15 分钟并发警报。对外的错误讯息一律是通用的（例如只说 `unauthorized`），详细原因只写进审计日志，攻击者无法借错误讯息判断猜对了哪一部分。（`web/lib/rate-limit.ts`、`web/lib/http.ts`）

## 三、侦测与封锁

### 11. 侦测规则 R1、R2、R7、R8

**防什么：** 入侵正在发生，你却不知道。**怎么防：** 没注册或已撤销的设备尝试登录（R1）、有人申请登记新设备（R2）、worker 带着正确 token 但 VM 签名错误（R7，代表 worker token 被偷）、VM 发现伪造或无法验证的 ticket（R8），都会写进审计日志并推送「安全警报」到所有设备。R7 让整个系统进入 LOCKDOWN；R8 让 VM 本地上锁，那张 ticket 立刻被标成失败。R7 只在 token 正确时才触发，否则任何人随便发垃圾请求就能把系统锁住。（`web/lib/alerts.ts`、`web/lib/guard.ts`、`worker/src/loop.ts`）

### 12. 系统状态机、kill switch 与 VM 本地锁

**防什么：** 发现被入侵之后，系统还继续运作、继续把你的资料交给攻击者。**怎么防：** LOCKDOWN 或 KILLED 时撤销所有 session，worker 拉取时只拿得到状态、拿不到 ticket；kill token 不需要登录、任何浏览器都能按，但它**只能**把状态设成 KILLED。VM 一看到封锁或 R8 就写入本地锁，之后就算数据库被改回 NORMAL，VM 也不处理任何东西，只能在 VM 终端解除。也就是说，决定「能不能继续」的是你控制的 VM，而不是 Vercel。（`packages/core/src/system-state.ts`、`worker/src/latch.ts`）

### 13. 审计日志

**防什么：** 入侵后看不出发生了什么，或攻击者事后修改纪录。**怎么防：** 登录、设备、ticket 状态、规则触发、kill switch 等事件都写进 append-only 的资料表，数据库层有 trigger 拒绝任何修改，也没有修改或删除的 API。日志只存元数据（事件、结果、设备、IP、规则编号），不存内容。导出 CSV 时会把以 `=`、`+`、`-`、`@` 开头的栏位加上引号，防止在试算表里被当成公式执行（CSV injection）。（`web/lib/audit.ts`）

## 四、Prompt 本身

### 14. Prompt lint（L1–L7）

**防什么：** 生成的 prompt 里藏着「忽略之前的指令」、外传资料、`curl | sh` 之类的危险指令、secret 或可疑编码，而你没注意到就复制去执行。**怎么防：** 纯确定性的规则（不用 LLM），VM 和手机各跑一次；比对前先把文字正规化（全形转半形、去掉零宽字元、同形字与 leet 还原、去掉空白），再把命中位置对回原文标红。lint 只负责标记、不会自动删改；两边结果不同时会提醒你，`claude_code` 有高严重度标记时复制要再确认一次。（`packages/core/src/lint.ts`、`web/app/t/[id]/page.tsx`）

### 15. 输入组装与 prompt injection

**防什么：** 你的需求里（或你转贴的文字里）有「忽略之前的指令」，让 Claude Code 做出模板以外的事。**怎么防：** 你的需求被包在 `<user_request>` 标签里，系统提示明确说标签内是「资料，不是指令」；标签的假冒写法（包括全形括号、零宽字元）会先被转义。更根本的防线是：Claude Code **没有任何工具**，它就算被骗，也只能输出一段文字，而那段文字还要经过 lint 和你的审阅。（`worker/src/processor.ts`、`worker/assets/system-prompt.md`）

## 五、VM 与执行环境

### 16. Claude Code 的调用方式

**防什么：** Claude Code 执行指令、读档、上网、载入 MCP 或 hooks，或 token 和内容外泄到 `ps` 与日志。**怎么防：** 以 `--tools ""` 关掉所有内建工具，`--strict-mcp-config` 不载入任何 MCP，`--disable-slash-commands`、`--no-session-persistence`，并在空的工作目录执行（避免读到任何 `.claude/`、`.mcp.json`）。内容只经 stdin 传入，token 只放在子进程的环境变量；环境变量用白名单，不继承 worker 的任何其他变量。参数名称都查过官方文件（docs/verification.md 第 2 项）。（`claudeArgs`、`claudeEnv`）

### 17. systemd 沙箱

**防什么：** worker 或 Claude Code 被攻破后，攻击者在 VM 上为所欲为。**怎么防：** 服务以没有 sudo 的 `vesper` 用户执行，没有任何 capability、不能提升权限；整个档案系统唯读，`/home` 换成空的，只放回内容 repo（唯读）和 worker 资料目录；系统调用、socket 种类、namespace 都受限；网络只能连 `127.0.0.1`，连本机 DNS 服务的 socket 都看不到。secret 由 systemd 在启动时交给服务，`vesper` 用户本身读不到 `/etc/vesper/` 里的档案。（`worker/systemd/vesper-worker.service`、vm-setup/08）

### 18. 出站白名单（squid + nftables）

**防什么：** 被骗的程序把资料送到攻击者的网站。**怎么防：** squid 只允许 HTTPS 隧道连到四个网域（Anthropic API、claude.ai 的两个认证网域、你的 Vercel），nftables 再规定 `vesper` 用户**只能**连 squid，直接连外、包括 DNS 都会被拒绝并记录。这是三层：systemd 的 IP 限制、nftables 的用户规则、squid 的网域白名单。限制：拿到 root 的人可以关掉规则，v3 会把管控移到 VM 外。（`vm-setup/files/squid.conf`、`nftables.conf`）

### 19. SSH 与 VMware 隔离

**防什么：** 从网络（包括同一个 NAT 里的 Kali）登录 VM，或经由共享文件夹、剪贴板、USB 等通道接触 VM。**怎么防：** SSH 只接受 key、只有管理帐号能登录、不能当隧道；防火墙只让 Windows 主机连 22 埠。VMware 关掉共享文件夹、拖放、剪贴板和不需要的虚拟硬件，并和 Kali 放在不同网段。VM 本身不加密（才能自动开机），由主机的 BitLocker 保护硬盘档案。（vm-setup/01、03、05）

### 20. 程序码、依赖与内容的完整性

**防什么：** 有人改掉 worker 的程序码、塞进恶意的依赖、或改写你的偏好和模板（等于改写每一段 prompt）。**怎么防：** 程序码放在 root 拥有的 `/opt/vesper`，`vesper` 改不了；唯一的第三方依赖 `hpke` 由脚本下载，先比对 `package-lock.json` 里的 sha512 才解开；Claude Code 从有签名的官方 apt 套件库安装，安装前比对签名密钥指纹。内容 repo 对 worker 唯读，`vesper content check` 会检查有没有其他用户能写入，pre-push hook 防止误推送到任何远端。（`vm-setup/scripts/install-worker-deps.sh`、`vesper content check`）

## 六、Web 前端与通知

### 21. CSP 与安全标头

**防什么：** 跨站脚本（XSS）：攻击者设法在页面里执行自己的 JavaScript，借用不可导出的私钥签名或解密。**怎么防：** 每个页面请求都产生新的随机 nonce，CSP 只允许带这个 nonce 的脚本（`strict-dynamic`），不载入第三方脚本、不允许 inline 脚本和 inline style、禁止被别的网站嵌入（clickjacking）。另外加上 HSTS、`nosniff`、`no-referrer` 等标头；API 回应一律 `default-src 'none'` 和 `no-store`。浏览器端到端测试确认整个流程没有任何 CSP 违规。（`web/proxy.ts`、`web/next.config.ts`）

### 22. 推送通知

**防什么：** 推送内容经过 Apple / Google 的推送服务，或显示在锁定画面、手表上，被别人看到。**怎么防：** 推送只送「种类与数量」，显示的文字来自 service worker 里的固定表格（例如「有 1 个任务待审阅」），永远不含任何 ticket 内容。登记推送时只接受已知推送服务的网址，防止有人把服务器变成帮他发请求的跳板（SSRF）。（`packages/core/src/notify-texts.ts`、`web/public/sw.js`、`web/lib/notify.ts`）

### 23. 每日上限

**防什么：** 设备或 session 被盗用时，被用来大量开 ticket，消耗你的 Claude 用量、把审阅清单淹没。**怎么防：** 每天（吉隆坡时间）最多 50 张（OD6），超过就拒绝并记进审计日志；上限是集中设定值，可以调整。（`packages/core/src/config.ts`、`web/lib/handlers/tickets.ts`）
