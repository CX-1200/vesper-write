# 07 · 安装 worker、设定档、内容 repo、`vesper init`

目标：把 worker 装在 root 拥有的 `/opt/vesper`，建立设定档和你的内容 repo `~/vesper-content`，然后用一次性的 setup token 向 Vercel 登记这台 VM。

开始之前：

- 02–06 已完成（`vesper` 用户、SSH、squid、nftables、Claude Code 和 token）。
- **Vercel 已经部署好**，`SETUP_TOKEN` 已设定（见根目录 [README.md](../README.md)）。04 的 squid 白名单里已经有你的 Vercel 网域。

## 1. Node.js

```bash
sudo apt install nodejs
node --version
```

需要 **v22.18 以上**（Node 从 22.18 起默认可以直接执行 TypeScript；Ubuntu 26.04 的套件是 22.22.1，docs/verification.md 第 12 项）。**不需要装 npm**，见第 3 节。

## 2. 程序码

02 第 7 节已经把 repo 放在 `/opt/vesper`。如果之后有新版本，先看一下要更新哪些东西、再切换：

```bash
sudo git -C /opt/vesper fetch
sudo git -C /opt/vesper log --oneline HEAD..origin/<分支名称>      # 看看有哪些新的 commit
sudo git -C /opt/vesper checkout <要部署的 commit>
sudo git -C /opt/vesper log -1 --format='%H %s'                   # 和 GitHub 上的 commit hash 比对
```

## 3. 安装 worker 用到的套件（不用 npm）

worker 只用到一个第三方套件：`hpke`（HPKE 加密，零依赖）。在 Ubuntu 上装 npm 会多出几百个 `node-*` 套件，对信任根这台 VM 来说太多了。所以改用一个小脚本：它只下载 `package-lock.json` 里锁定的那个版本，**先比对 sha512 和 lockfile 一致**，才解开。

先读一遍脚本（很短），再执行：

```bash
less /opt/vesper/vm-setup/scripts/install-worker-deps.sh
sudo bash /opt/vesper/vm-setup/scripts/install-worker-deps.sh /opt/vesper
```

应该看到 `sha512 与 package-lock.json 相符` 和 `完成`。之后每次更新程序码（第 2 节）都要再跑一次。

确认权限（`vesper` 只能读，不能改）：

```bash
ls -ld /opt/vesper /opt/vesper/node_modules          # 都是 root root，而且不是 group/other 可写
```

## 4. 设定档 `/etc/vesper/worker.json`

```bash
sudo install -o root -g root -m 0644 /opt/vesper/worker/systemd/worker.example.json /etc/vesper/worker.json
sudoedit /etc/vesper/worker.json
```

| 栏位 | 说明 |
|---|---|
| `baseUrl` | 你的 Vercel 网址，例如 `https://vesper-abc123.vercel.app`（必须是 https，结尾不要加 `/`）。网域要和 squid 白名单一致 |
| `dataDir` | worker 的资料目录，保持 `/home/vesper/.local/share/vesper` |
| `contentDir` | 你的内容 repo，保持 `/home/vesper/vesper-content` |
| `claudeBin` | 06 用 `command -v claude` 查到的路径 |
| `proxyUrl` | squid：`http://127.0.0.1:3128` |
| `pollIntervalMs` | 拉取间隔，默认 30000（30 秒） |
| `claimMax` | 每次最多认领几张 ticket，默认 2 |
| `claudeTimeoutMs` | 单张 ticket 等 Claude Code 多久，默认 120000（120 秒） |
| `minClaudeVersion` | 低于这个版本时 worker 会在日志里警告，默认 `2.1.293` |

这个档案没有任何 secret，所以是 `0644`（`vesper` 指令需要读它）。secret 只放在 `0600` 的 `claude-oauth-token` 和 `worker-token`。

## 5. `vesper` 指令

```bash
sudo install -o root -g root -m 0755 /opt/vesper/worker/systemd/vesper-cli-wrapper.sh /usr/local/bin/vesper
sudo -u vesper -i vesper help
```

这个小 wrapper 会：拒绝以 `vesper` 以外的用户执行、把 umask 设成 `077`（新档案只有 `vesper` 读得到）、让 Node 走 squid（`NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`）。

## 6. 你的内容 repo `~/vesper-content`

这里放你的偏好（`preferences.md`）、每种 ticket 的模板（`templates/`）和类型设定（`ticket-types.json`）。worker 每处理一张 ticket 都会重新读一次。

```bash
sudo -u vesper -i                       # 切换成 vesper 用户（之后的指令都在这个 shell 里）
cp -r /opt/vesper/vm-setup/content-example ~/vesper-content
cd ~/vesper-content
chmod -R go-w .
git init -b main
git config user.name "Vesper owner"
git config user.email "owner@localhost"
printf '#!/bin/sh\necho "vesper-content 不可以推送到任何地方。" >&2\nexit 1\n' > .git/hooks/pre-push
chmod +x .git/hooks/pre-push
git add -A && git commit -m "初始内容"
vesper content check
exit                                    # 回到你的管理帐号
```

- **不要加任何 remote，也不要推送**（Build Spec §4、§22）。`pre-push` hook 是防呆：就算不小心执行了 `git push`，也会被拒绝。
- 之后要改内容：`sudo -u vesper -i`，编辑档案，`vesper content check`，再 `git commit`。git 记录让你看得到每一次改了什么。
- worker 对这个目录**只有读取权限**：08 的 systemd 沙箱把整个 `/home` 设成唯读（只开放 `~/.local/share/vesper` 可写）。
- `vesper content check` 会检查：每个 Vercel 上的类型（`general`、`coding`、`writing`、`research`）都有设定、模板读得到、档案不能被其他用户写入。
- **`preferences.md` 和模板里不要写任何 secret**：它们会附在每一张 ticket 前面送给 Claude。
- 范例模板刻意不写出具体的危险指令（例如删档或下载后执行的指令），因为生成的 prompt 会原样带着这些字，每次都被 lint 标成高严重度。

## 7. `vesper init`：产生 VM 密钥并向 Vercel 登记

```bash
sudo -u vesper -i vesper init
```

它会：

1. 在 `~/.local/share/vesper/keys/` 产生 VM 的**签名密钥**和**加密密钥**（权限 600，私钥永远不离开这台 VM）。
2. 产生一组随机的 **worker token**（之后 worker 每个请求都要带它，Vercel 只存它的哈希）。
3. 问你 **SETUP_TOKEN**（输入时不显示），用它向 Vercel 登记 VM 的公钥。
4. 在终端印出 **VM 指纹**（6 组数字）。

**把 VM 指纹抄下来**（或保持这个窗口开着）：09 第一次配对时，手机上显示的「VM 指纹」必须和这里一模一样。

如果登记失败：

- 「连不上 Vercel」：检查 `worker.json` 的 `baseUrl`，和 squid 白名单是否有这个网域（`sudo tail /var/log/squid/access.log`）。
- 「登记失败（HTTP 401）」：SETUP_TOKEN 打错，或 Vercel 上还没设定。
- 重新执行 `vesper init` 会用**同一组**密钥重试（不会重新产生），直到登记成功。

## 8. 把 worker token 交给 root

`vesper init` 最后会印出接下来的步骤，前两步是：

```bash
sudo install -D -o root -g root -m 0600 /home/vesper/.local/share/vesper/keys/worker-token.pending /etc/vesper/worker-token
sudo shred -u /home/vesper/.local/share/vesper/keys/worker-token.pending
sudo ls -l /etc/vesper/                    # worker-token 和 claude-oauth-token 都是 -rw------- root root
```

为什么要搬：worker token 是 VM 向 Vercel 证明身分的 secret 之一。放在 `/etc/vesper`、只有 root 读得到，`vesper` 用户（以及任何以它的身分执行的程序）就不能直接读取或带走它；只有 08 的 systemd 服务在启动时，经由 `LoadCredential=` 拿到一份。

第 3、4 步就是 08 和 09。

---

```bash
sudo bash /opt/vesper/vm-setup/scripts/check-vm.sh
```
