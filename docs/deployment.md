# 部署指南（从零到第一张 ticket）

这一页把整个部署串成一条线，照顺序做就好。每一步都标明**在哪里做**：

- 🌐 **网页**：Cloudflare、GitHub、Vercel 的网站
- 💻 **你的电脑**：Windows 的 cmd 或 PowerShell
- 🖥️ **VM**：经由 SSH 登录的 Ubuntu
- 📱 **手机**

---

## 先理解：三个部分怎么连在一起

```
   📱 手机（PWA）                         🖥️ VM（你的电脑里）
        │  HTTPS                                 │  HTTPS，每 30 秒主动问一次
        │  （开 ticket、看结果）                  │  「有没有新 ticket？」
        ▼                                        ▼
   ┌──────────────── 🌐 Vercel（Next.js）─────────────────┐
   │   只经手密文；存取 Cloudflare D1 数据库                 │
   └──────────────────────────────────────────────────────┘
```

**最重要的一点：Vercel 从来不会连到 VM。** 连线永远是 VM **主动**连出去找 Vercel（每 30 秒一次），所以：

- VM 不需要公开 IP、不需要开任何连入的 port，你家的路由器也不用设定。
- 你**不需要**在 Vercel 上设定任何关于 VM 的东西（没有 VM 的 IP、没有网址）。
- 「衔接」只发生一次：在 VM 上执行 `vesper init` 时，VM 用一次性的 **SETUP_TOKEN** 向 Vercel 登记自己的公钥。之后 VM 只需要知道两件事：**Vercel 的网址**（写在 VM 的设定档里），和 `vesper init` 自动产生的 **worker token**。

所以你说得没错：Vercel 那一侧大部分是自动的（连上 GitHub、按部署，之后每次推送都会自动重新部署）。需要手动做的只有四件：**建资料表一次**、**产生几个 secret 一次**、**填环境变量一次**、**设定 VM**（这是最大的一块）。

---

## 每个 secret 放在哪里（总表）

| 名称 | 谁产生 | 放在哪里 |
|---|---|---|
| D1 API token | 🌐 你在 Cloudflare 网站建立 | Vercel 环境变量（建资料表时你的电脑也会用一次） |
| `SETUP_TOKEN` | 💻 你用一行指令产生 | Vercel 环境变量；在 VM 的 `vesper init` 和手机首次设置**各输入一次**；设置完成后从 Vercel 删除 |
| `TOTP_ENC_KEY` | 💻 一行指令 | 只放 Vercel |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 💻 一行指令 | 只放 Vercel |
| Claude Code token | 🖥️ VM 上的 `claude setup-token` | 只放 VM（`/etc/vesper/claude-oauth-token`） |
| worker token | 🖥️ `vesper init` 自动产生 | VM 上（`/etc/vesper/worker-token`）；Vercel 只存它的哈希，你不用碰它 |
| 密码、TOTP、recovery key 等 | 📱 首次设置时 | 你自己保管；服务器只存哈希 |

---

## 阶段 A · 🌐 Cloudflare：D1 数据库

你已经建立了数据库。还需要三个值：

### A1. Account ID

在 Cloudflare 仪表板登录后，看浏览器的**网址列**：`https://dash.cloudflare.com/` 后面那一串 **32 个字元的英数字**就是 Account ID（例如 `https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/...`）。仪表板的帐号首页或 Workers & Pages 页面的侧栏通常也会显示「Account ID」（位置以画面为准）。

### A2. Database ID

打开你建立的那个 D1 数据库的页面（在 Storage & Databases → D1，或 Workers & Pages 底下，以画面为准）。页面上会显示 **Database ID**，格式像 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`（36 个字元、有 4 个横线）。

### A3. API token（在 Cloudflare 网站建立，不是在电脑上产生）

这个 token 让 Vercel 能读写你的 D1。它是 **Cloudflare 网站帮你产生**的：

1. 右上角头像 → **My Profile** → **API Tokens** → **Create Token**。
2. 选 **Create Custom Token**（自订）。
3. Permissions：选 **Account** → **D1** → **Edit**。只给这一项。
4. Account Resources：只选你自己的帐号。
5. 建立后，token **只会显示这一次**。先把它暂存在密码管理器里，等一下要贴进 Vercel，和在 A4 用一次。

（选单名称以 Cloudflare 画面为准。）

---

## 阶段 B · 💻 你的电脑：产生 secret、建立资料表

为什么在你的电脑做：这两件事都只做**一次**，而且都会碰到 secret。Vercel 的部署只负责「执行网站程序」，不会帮你建资料表或想密码；放在 VM 上做也可以，但 VM 是信任根，越少东西经过它越好。

需要：电脑上装了 **Node.js 22.18 以上**（`node --version` 确认；没有或太旧，从 nodejs.org 装 24 LTS）和 **git**。

### B1. 产生 4 个 secret

你的理解完全正确，就是类似 `node -e "...randomBytes..."` 的一行指令。在 **cmd** 执行：

```bat
node -e "console.log('SETUP_TOKEN=' + require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('TOTP_ENC_KEY=' + require('crypto').randomBytes(32).toString('base64url'))"
node -e "const e=require('crypto').createECDH('prime256v1');e.generateKeys();console.log('VAPID_PUBLIC_KEY='+e.getPublicKey().toString('base64url'));console.log('VAPID_PRIVATE_KEY='+Buffer.from(e.getPrivateKey('hex').padStart(64,'0'),'hex').toString('base64url'))"
```

注意格式：

- `TOTP_ENC_KEY` **必须是 32 bytes、base64url**（印出来是 43 个字元）。用 `randomBytes(64).toString('hex')` 会**不对**（那是 128 个字元的 hex），服务器会拒绝启动。
- `SETUP_TOKEN` 至少 32 个字元，上面的指令产生 43 个。
- VAPID 是一对**椭圆曲线密钥**（Web Push 用来证明推送来自你的服务器），不是随机字串，所以第三行比较长。

把印出来的四行暂存到密码管理器，然后执行 `cls` 清掉画面。（repo 里的 `web/scripts/gen-secrets.ts` 做的是同一件事，只是改成写进档案、不印在画面上；两种都可以。）

### B2. 建立资料表

数据库刚建立时是空的。网站程序需要的资料表（tickets、devices、audit_log……）要先建立一次；Vercel 部署**不会**自动做这件事。

```bat
git clone https://github.com/CX-1200/vesper-write.git
cd vesper-write
git checkout claude/new-session-hdsryc
set D1_ACCOUNT_ID=<A1 的 Account ID>
set D1_DATABASE_ID=<A2 的 Database ID>
node web\scripts\migrate.ts
```

- 它会问 `D1 API token`，贴上 A3 的 token（**输入时不会显示**，贴上后按 Enter）。
- 不需要先 `npm install`：这个脚本只用 Node 内建的功能。
- 成功时最后一行会列出资料表名称：`D1 schema applied. Tables: alerts, audit_log, …`。
- 重复执行没有关系（每个语句都是「不存在才建立」）。
- 如果 repo 是私有的，`git clone` 会要求登录 GitHub（或改用 GitHub Desktop / 下载 ZIP 解压缩）。

---

## 阶段 C · 🌐 GitHub

### C1. 把程序码合并进 main

目前所有程序码都在分支 `claude/new-session-hdsryc` 上。Vercel 的**正式环境（Production）默认部署 `main` 分支**，其他分支只会得到预览部署。所以先在 GitHub 开一个 Pull Request，把 `claude/new-session-hdsryc` 合并进 `main`。（要我帮你开 PR，跟我说一声。）

### C2. 开启安全设定

repo 的 **Settings → Code security**：开启 Secret scanning、Push protection、Dependabot alerts 和 security updates（名称以 GitHub 画面为准）。

---

## 阶段 D · 🌐 Vercel

### D1. 汇入专案

1. Vercel → **Add New… → Project** → 选这个 GitHub repo（第一次要授权 Vercel 读取它）。
2. **Root Directory**：按 Edit，选 `web`。
3. Framework Preset：Next.js（通常会自动侦测）。
4. 先不填环境变量，直接按 **Deploy**。

第一次部署不需要环境变量就能建置成功（环境变量是在**执行时**才读取的）。部署完成后，Vercel 会给你一个网址，例如 `https://vesper-write-abc123.vercel.app`。**记下这个网址**，下面要用；也要用在 VM 的设定里。

如果部署在安装或建置阶段失败、讯息提到找不到 `@vesper/core` 或 `next`：到 **Settings → Build and Deployment**，把 Install Command 改成 `cd .. && npm ci`，Build Command 改成 `cd .. && npm run build:web`，再重新部署。（这是 README 提过的「我不确定」那一点。）

### D2. 填环境变量

**Settings → Environment Variables**。每个都选 **Production**，并勾选 **Sensitive**：

| Key | Value |
|---|---|
| `APP_ORIGIN` | D1 的网址，例如 `https://vesper-write-abc123.vercel.app`（结尾不要 `/`） |
| `SETUP_TOKEN` | B1 |
| `TOTP_ENC_KEY` | B1 |
| `VAPID_PUBLIC_KEY` | B1 |
| `VAPID_PRIVATE_KEY` | B1 |
| `VAPID_SUBJECT` | `mailto:你的email` |
| `DB_DRIVER` | `d1` |
| `D1_ACCOUNT_ID` | A1 |
| `D1_DATABASE_ID` | A2 |
| `D1_API_TOKEN` | A3 |

环境变量改了之后**要重新部署才会生效**：Deployments → 最新那一次 → ⋯ → **Redeploy**。

### D3. 确认

用浏览器打开 `https://<你的网址>/api/config`：

- 看到 `{"error":"unauthorized","login":true}` → **正常**（服务在跑、数据库连得上，只是你还没登录）。
- 看到 500 或 `server_error` → 环境变量缺少或格式不对。到 Vercel 的 Logs 看错误类别（例如 `EnvError`、`DbError`），对照上表检查。

到这里 Vercel 就完成了。之后你推送新的程序码到 `main`，Vercel 会自动重新部署，不用再手动操作。

---

## 阶段 E · 🖥️ VM

照 [vm-setup/](../vm-setup/README.md) 的 01 到 08 做。和 Vercel 有关的只有三个地方：

| 步骤 | 用到 Vercel 的什么 |
|---|---|
| 04（squid 白名单） | Vercel 网址的**网域**部分，例如 `vesper-write-abc123.vercel.app` |
| 07 第 4 节（`/etc/vesper/worker.json`） | `baseUrl`：完整网址，例如 `https://vesper-write-abc123.vercel.app` |
| 07 第 7 节（`vesper init`） | 输入 `SETUP_TOKEN` → VM 向 Vercel 登记，终端显示 **VM 指纹** |

`vesper init` 成功后，08 启动 worker，VM 就会每 30 秒自己连 Vercel。到这里「Vercel ↔ VM」就接好了。

---

## 阶段 F · 📱 手机

照 [vm-setup/09](../vm-setup/09-first-run.md)：用 Safari 打开你的 Vercel 网址 → 加到主屏幕 → 从主屏幕打开 → 首次设置（输入 `SETUP_TOKEN`）→ 和 VM 互相比对指纹 → 设定三组备用 secret → 开启推送 → 开第一张 ticket。

---

## 阶段 G · 🌐 收尾

1. Vercel → Environment Variables → **删除 `SETUP_TOKEN`** → Redeploy。（它在设置完成时已经失效，删掉更干净。）
2. 删掉你在密码管理器或电脑上暂存的 `SETUP_TOKEN`、`TOTP_ENC_KEY`、VAPID 私钥（它们已经在 Vercel 里了）。D1 API token 也只需要留在 Vercel。
3. 做 [vm-setup/09](../vm-setup/09-first-run.md) 的 v1 验收。

---

## 卡住的时候

| 症状 | 先看哪里 |
|---|---|
| `/api/config` 回 500 | Vercel Logs 的错误类别；环境变量是否齐全、改完有没有 Redeploy |
| `vesper init` 说连不上 Vercel | `worker.json` 的 `baseUrl`；squid 白名单的网域（`sudo tail /var/log/squid/access.log`） |
| `vesper init` 回 401 | `SETUP_TOKEN` 和 Vercel 上的不一样，或改完环境变量没有 Redeploy |
| 手机首次设置说「VM 还没登记」 | 先在 VM 完成 `vesper init` |
| 手机一直停在「等待 VM 批准」 | VM 上 `systemctl status vesper-worker` 是否在跑；`vesper device approve` 要等 worker 拉过一次（30 秒） |
