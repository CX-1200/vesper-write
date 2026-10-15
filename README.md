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
| [docs/deployment.md](docs/deployment.md) | 部署总流程：每一步在哪里做、每个 secret 放哪里 |
| [vm-setup/README.md](vm-setup/README.md) | VM 的部署顺序、v1 手动恢复、日常维护 |

---

## 部署

**照 [docs/deployment.md](docs/deployment.md) 一步一步做**：Cloudflare D1 → 在你的电脑产生 secret、建资料表 → GitHub → Vercel → VM（[vm-setup/](vm-setup/README.md)）→ 手机。那一页也说明了 Vercel 和 VM 怎么连接（VM 主动连 Vercel，Vercel 从不连 VM）。

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
