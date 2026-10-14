# Vesper

一个「prompt 秘书」：你在手机上口述或打字开 ticket，内容在手机上就先加密；电脑开机后，本地 VM 里的 Claude Code（`claude -p`，不开放任何工具）依照你的偏好和模板把需求整理成 prompt，再加密写回；你在手机上解密、审阅，手动复制到 Claude.ai 或 Claude Code 执行。Vercel 只经手密文和元数据。

依据：Vesper Build Spec v2（2026-10-13）。目前完成的是 **v1**，等你验收。

## 目录

```
packages/core/   web 与 worker 共用：加密封包（HPKE）、签名、指纹、lint L1–L7、状态机、schema、设定值
web/             Next.js（Vercel）：API、PWA 页面、D1 adapter、侦测规则、审计日志、推送
worker/          VM 上的 worker 与 vesper 指令、systemd unit
vm-setup/        VM 加固与部署：一步一步由你自己执行的说明与脚本
tests/           单元、整合测试（node:test）与浏览器端到端测试
docs/            决定记录、§21 查证结果、§18 安全清单、各安全模块说明
```

## 文件

| 文件 | 内容 |
|---|---|
| [docs/decisions.md](docs/decisions.md) | 你在 §20 的决定，以及所有实现层面的决定和理由 |
| [docs/verification.md](docs/verification.md) | §21 每一项的查证结果、来源、「我不确定」的项目 |
| [docs/security-checklist.md](docs/security-checklist.md) | §18 安全需求清单，逐条的证据与需要你确认的项目 |
| [docs/security-notes.md](docs/security-notes.md) | 每个安全模块防什么、怎么防（给正在学 cybersecurity 的你） |
| [vm-setup/README.md](vm-setup/README.md) | VM 的部署顺序、v1 手动恢复、日常维护 |

---

## 部署：Vercel 那一侧

顺序：先部署 Vercel（这一节），再照 [vm-setup/](vm-setup/README.md) 设定 VM。

### 1. Cloudflare D1 数据库（OD1）

1. 在 Cloudflare 仪表板建立一个 D1 数据库，记下 **Account ID** 和 **Database ID**。
2. 建立一个 **API token**，权限只给这个帐号的 **D1 编辑**（选单名称以 Cloudflare 画面为准）。这个 token 等一下会放进 Vercel。
3. 建立资料表（在你自己的电脑上，repo 根目录，Node 24）：

   ```bash
   npm ci
   export D1_ACCOUNT_ID=<Account ID>
   export D1_DATABASE_ID=<Database ID>
   node web/scripts/migrate.ts          # 会问 D1 API token，输入时不显示
   ```

   每个语句都是 `IF NOT EXISTS` / `OR IGNORE`，重复执行没有关系。

### 2. 产生服务器端的 secret

```bash
node web/scripts/gen-secrets.ts <repo 以外的一个新目录>
```

它会在那个目录（权限 700）写出四个档案（权限 600），**不会印出任何值**：`SETUP_TOKEN`、`TOTP_ENC_KEY`、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`。等一下把内容贴进 Vercel，`SETUP_TOKEN` 还要在 VM 的 `vesper init` 和手机的首次设置各输入一次。全部设定完成后删除这个目录（例如 `shred -u <目录>/* && rmdir <目录>`）。

### 3. Vercel 专案

1. 在 Vercel 汇入这个 GitHub repo。
2. **Root Directory** 设为 `web`，Framework 为 Next.js。保留「Include source files outside of the Root Directory in the Build Step」为开启（web 需要读 `packages/core`；Vercel 的 monorepo FAQ 说 2020-08-27 之后建立的专案默认开启，来源是搜索摘录 🟡）。
3. Node.js 版本：`web/package.json` 的 `engines` 写的是 `24.x`（argon2id 用的是 Node 24.7 起内建的 `crypto.argon2()`）。
4. **我不确定** Vercel 在 Root Directory 是 `web` 时，会不会在 repo 根目录安装 npm workspaces（`@vesper/core` 是 workspace 套件）。本地 `npm run build:web` 是通过的。如果第一次部署在安装或建置阶段失败（找不到 `@vesper/core` 或 `next`），把专案设定改成：
   - Install Command：`cd .. && npm ci`
   - Build Command：`cd .. && npm run build:web`

### 4. 环境变量（Production）

全部设成 **Sensitive**。名称也列在 [.env.example](.env.example)（只有名称、没有值）。

| 名称 | 值 |
|---|---|
| `APP_ORIGIN` | 你的网址，例如 `https://vesper-abc123.vercel.app`（不加结尾 `/`） |
| `RP_ID` | 可省略（默认是 `APP_ORIGIN` 的主机名称；passkey 用） |
| `SETUP_TOKEN` | `gen-secrets` 产生的档案内容。**设置完成后删除这个变量并重新部署** |
| `TOTP_ENC_KEY` | 同上（加密数据库里的 TOTP secret） |
| `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` | 同上（Web Push） |
| `VAPID_SUBJECT` | `mailto:<你的 email>`（推送服务需要一个联络方式） |
| `DB_DRIVER` | `d1` |
| `D1_ACCOUNT_ID`、`D1_DATABASE_ID`、`D1_API_TOKEN` | 第 1 节的值 |

**不要**使用 `NEXT_PUBLIC_` 开头的变量：那种变量会被打包进浏览器端的程序（§18）。这个专案没有任何一个。

### 5. 部署并确认

部署完成后：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<你的网域>/api/config     # 401 = 服务正常（还没登录）
```

如果是 500：多半是环境变量缺少或格式不对。Vercel 的 Function 日志只会记录错误的类别名称（例如 `EnvError`），不会记录内容或 secret。

接下来到 [vm-setup/](vm-setup/README.md)。

---

## GitHub 设定提醒（§18）

请在这个 repo 的 **Settings → Code security**（名称以 GitHub 画面为准）开启：

- **Secret scanning** 与 **Push protection**：误把 secret commit 进来时会被拦下。
- **Dependabot alerts** 与 **security updates**：依赖有漏洞时通知你。

测试里有几个**刻意写成 secret 样子的假字串**（例如 `tests/core/lint.test.ts` 里给 L7 用的 `sk-ant-…`、`AKIA…EXAMPLE`），它们不是真的 secret；secret scanning 如果回报它们，可以标成「用于测试」关闭。

---

## 开发与测试

需要 Node **24.x**（`nvm use 24`）。

```bash
npm ci
npm test                 # 单元与整合测试（core、web、worker）
npm run typecheck
npm run build:web        # Next.js production build
```

浏览器端到端测试（Chromium + Playwright；会启动 `next start`、用本地 SQLite、真正的 worker 程序码和一个假的 `claude`）：

```bash
npm run build:web
PLAYWRIGHT_MODULE=<playwright 套件的路径> npm run test:e2e
```

Playwright 没有列为这个专案的依赖（只在测试时用）；找不到它时这个测试会自动跳过。

worker 在 VM 上用 Node 22 执行；`node --test "tests/core/*.test.ts" "tests/worker/*.test.ts"` 在 Node 22 上也会通过（少数需要 web 端模拟的测试会标示 SKIP）。

本地开发服务器（只限开发，不要 commit 设定档）：在 `web/.env.local` 设定 `APP_ORIGIN=http://localhost:3000`、`SETUP_TOKEN`、`TOTP_ENC_KEY`、`DB_DRIVER=sqlite`，然后 `npm run dev -w web`。

---

## v1 的范围与之后

v1 已实现：PWA、首次设置与设备配对、密码 + TOTP（passkey 可选）+ 设备签名、端到端加密与双向签名、密文 ticket 与状态机、lease、12 小时过期、stale、worker 与 `claude -p`、VM 与设备各跑一次 lint、Web Push、VM 状态、kill switch 与 VM 本地锁、审计日志（两种视图）、R1–R3、R7、R8、每日上限、VM 加固说明。

**v2（等你批准 v1 之后才开始）**：R4–R6、SUSPICIOUS → LOCKDOWN、确认本人、`vesper unlock` 与 token 轮换、Vercel 保留期删除、每周加密备份。v1 期间如果需要从封锁状态恢复，见 [vm-setup/README.md 的「v1 手动恢复」](vm-setup/README.md)。
