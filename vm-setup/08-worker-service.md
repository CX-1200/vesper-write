# 08 · systemd 服务、沙箱、自检、启动

目标：worker 以 systemd 服务执行，跑在一个很紧的沙箱里；secret 只经由 systemd credential 交给它；先用自检确认一切正常，再正式启动。

## 1. 安装两个 unit

```bash
sudo install -o root -g root -m 0644 /opt/vesper/worker/systemd/vesper-worker.service /etc/systemd/system/vesper-worker.service
sudo install -o root -g root -m 0644 /opt/vesper/worker/systemd/vesper-selftest.service /etc/systemd/system/vesper-selftest.service
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/vesper-worker.service /etc/systemd/system/vesper-selftest.service
```

`verify` 没有印出任何东西就是 OK。

- `vesper-worker.service`：worker 本体，每 30 秒拉一次 ticket。
- `vesper-selftest.service`：只送**一个**无害的请求（「请只回答 OK」）给 Claude Code，用**完全相同**的沙箱、token 和 proxy。用来确认：token 有效、你的计划能用 `ticket-types.json` 里的模型（docs/verification.md 第 1 项「我不确定」的那一点）、这个版本的 Claude Code 接受 worker 用的所有参数。

## 2. 逐行说明 `vesper-worker.service`

**基本设定**

| 设定 | 作用 |
|---|---|
| `User=vesper`、`Group=vesper` | 以没有 sudo 的 `vesper` 用户执行 |
| `WorkingDirectory=/home/vesper/.local/share/vesper` | worker 的资料目录（VM 私钥、可信设备清单、本地锁、本地记录） |
| `ExecStart=/usr/bin/node --conditions=vesper-js /opt/vesper/worker/dist/src/main.js` | 执行已编译好的 JavaScript（`dist/`，见 07 第 1 节）；`--conditions=vesper-js` 让 `@vesper/core` 也载入编译版。程序码在 root 拥有的 `/opt/vesper`，`vesper` 改不了它 |
| `Environment=NODE_USE_ENV_PROXY=1`、`HTTPS_PROXY=…` | 让 Node 内建的 `fetch` 走 squid（docs/verification.md「额外查到」） |
| `StartLimitIntervalSec=600`、`StartLimitBurst=10` | 设定错误时 worker 会结束；10 分钟内失败 10 次就不再重试，避免无限重启 |
| `Restart=on-failure`、`RestartSec=10` | 意外结束时 10 秒后重启（网络问题由 worker 自己用指数退避处理，不会让它结束） |

**secret（§16.3）**

| 设定 | 作用 |
|---|---|
| `LoadCredential=worker-token:/etc/vesper/worker-token` | systemd（root）读取这个 `0600` 档案，在服务启动时放进只有这个服务看得到的 `$CREDENTIALS_DIRECTORY`。`vesper` 用户本身读不到 `/etc/vesper/worker-token` |
| `LoadCredential=claude-oauth-token:/etc/vesper/claude-oauth-token` | 同上。worker 把它放进 Claude Code 子进程的环境变量，不放在命令列参数、不写进日志 |

**沙箱**

| 设定 | 作用 |
|---|---|
| `UMask=0077` | 新建的档案只有 `vesper` 读得到 |
| `NoNewPrivileges=yes` | 不能经由 setuid 程序（例如 sudo）提升权限 |
| `CapabilityBoundingSet=`（空）、`AmbientCapabilities=`（空） | 没有任何 Linux capability |
| `ProtectSystem=strict` | 整个档案系统唯读 |
| `ProtectHome=tmpfs` + `BindReadOnlyPaths=/home/vesper/vesper-content` + `BindPaths=/home/vesper/.local/share/vesper` | `/home` 变成空的，只放回两个路径：内容 repo（**唯读**）和 worker 的资料目录（可写）。worker 看不到其他人的家目录，也改不了你的偏好和模板 |
| `PrivateTmp=yes` | 私有的 `/tmp`，和其他程序隔开 |
| `PrivateDevices=yes` | 看不到硬件设备（只有 `/dev/null`、`/dev/urandom` 这类） |
| `ProtectKernelTunables`、`ProtectKernelModules`、`ProtectKernelLogs`、`ProtectControlGroups`、`ProtectClock`、`ProtectHostname` | 不能改核心参数、载入核心模组、读核心日志、改 cgroup、改时钟、改主机名称 |
| `ProtectProc=invisible` | 在 `/proc` 里看不到其他用户的进程 |
| `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` | 只能开一般的网络和本机 socket（不能开 raw socket、netlink 等） |
| `RestrictNamespaces=yes` | 不能建立任何 namespace（常见的容器逃逸手法） |
| `RestrictRealtime`、`RestrictSUIDSGID`、`LockPersonality`、`RemoveIPC` | 关掉几个少用、但可能被滥用的核心功能 |
| `SystemCallArchitectures=native`、`SystemCallFilter=@system-service`、`SystemCallFilter=~@privileged @resources`、`SystemCallErrorNumber=EPERM` | 只允许一般服务会用到的系统调用；其余的回传「没有权限」 |
| `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1` | 这个服务（含 Claude Code 子进程）只能连 `127.0.0.1`，也就是 squid。这是 05 防火墙之外的**第二道**网络限制 |
| `InaccessiblePaths=-/run/systemd/resolve -/run/dbus/system_bus_socket` | 看不到 systemd-resolved 和 D-Bus 的本机 socket，所以连「经由本机服务查 DNS」这条路都没有（05 第 6 节）。网域名称由 squid 解析 |

## 3. 安全分数

```bash
systemd-analyze security vesper-worker
```

最后一行是整体的「exposure」分数（0–10，**越低越好**）。我在开发环境用 systemd 255 的离线模式估算，两个 unit 都是 **1.1（OK）**；你 VM 上的 systemd 版本较新，数字可能略有不同。**请把你实际得到的分数填进 [docs/security-checklist.md](../docs/security-checklist.md)**（Build Spec §18 要求记录）。

刻意没有开、而分数里会显示 ✗ 的几项，以及原因：

| 项目 | 为什么不开 |
|---|---|
| `MemoryDenyWriteExecute=` | Node（V8）和 Claude Code 都需要 JIT，开了会无法执行 |
| `PrivateNetwork=` | worker 需要连本机的 squid；独立的网络 namespace 连不到它 |
| `RestrictAddressFamilies=~AF_UNIX` | Node 建立子进程（Claude Code）的 stdin/stdout 管道会用到 UNIX socket |
| `ProcSubset=pid` | Node 会读 `/proc/meminfo` 之类的档案决定内存设定，拿掉可能造成难查的问题 |
| `PrivateUsers=` | 理论上可以开；为了避免和 Claude Code 产生没测过的相容问题，v1 先不开。之后想试：加上这一行、跑自检，通过再保留 |
| `RootDirectory=` | 需要另外准备一个只有 worker 的根档案系统，对 v1 来说成本太高 |

## 4. 自检（启动 worker 之前一定要先跑）

```bash
sudo systemctl start vesper-selftest
journalctl -u vesper-selftest -n 20 --no-pager
```

看到 `selftest_ok`（而且 `answer_is_ok` 是 `true`）就代表：沙箱、proxy、防火墙都没有挡到 Claude Code，token 有效，你的计划可以用这个模型。

如果失败（`selftest_failed`），看 `code`：

| code | 可能的原因 |
|---|---|
| `claude_spawn` | `worker.json` 的 `claudeBin` 路径不对，或 Claude Code 没装好 |
| `claude_error` | Claude Code 回报错误：token 无效或过期、你的计划不能用这个模型（这时改 `ticket-types.json` 的 `model`，例如 `haiku`） |
| `claude_timeout` | 连不出去：看 `sudo tail /var/log/squid/access.log` 有没有 `TCP_DENIED`，和 `sudo journalctl -k | grep vesper-egress-blocked` |
| `claude_exit`、`claude_bad_output` | 沙箱挡到了 Claude Code 需要的东西。`journalctl -u vesper-selftest` 里会有 exit code；把错误讯息贴给我看 |

日志里还会有一行 `claude_version_ok`（或 `claude_version_too_old`：回到 06 换 `latest` 频道）。

自检**不会**把任何内容写进日志；Claude Code 也设定成不留会话纪录（`--no-session-persistence`、`cleanupPeriodDays: 1`，docs/verification.md 第 4 项）。

## 5. 启动 worker

```bash
sudo systemctl enable --now vesper-worker
systemctl status vesper-worker --no-pager
journalctl -u vesper-worker -n 20 --no-pager
```

正常的日志：`worker_start`（带 VM 指纹、Vercel 网址），之后每 30 秒没有新的输出就是在正常拉取（只有事件才记录）。

日志的原则：**只有事件名称、ticket id、错误代码**，永远不会有 ticket 内容、prompt、token。可以自己检查两个 token 有没有出现在日志里（`grep -f` 直接从档案读出要找的字串，所以 token 不会显示在画面上，也不会出现在指令参数里）：

```bash
for f in claude-oauth-token worker-token; do
  printf '%s 在日志里出现的次数：' "$f"
  sudo journalctl -u vesper-worker -u vesper-selftest -o cat --no-pager | sudo grep -cF -f "/etc/vesper/$f"
done
```

两个都应该是 `0`。

## 6. 每天会用到的指令

```bash
systemctl status vesper-worker            # 服务状态
journalctl -u vesper-worker -f            # 看即时日志（Ctrl+C 离开）
sudo -u vesper -i vesper status           # 本地锁、最后一次连线、设备数量
sudo -u vesper -i vesper device list      # 可信、已撤销、待批准的设备
sudo systemctl restart vesper-worker      # 改过 worker.json 或更新程序码之后
```
