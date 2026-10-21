# vm-setup：VM 加固与部署（v1）

这个目录是**写给你自己一步一步执行**的说明和脚本。Claude Code 不会、也不应该替你在 VM 上执行任何指令（Build Spec §0 第 6 条）。

每一页都写了：要做什么、为什么这样做、怎么确认做对了。请**先读完一页，再执行那一页的指令**。指令里用 `<尖括号>` 标出的地方，要换成你自己的值。

## 顺序

| 步骤 | 文件 | 内容 | 在哪里做 |
|---|---|---|---|
| 1 | [01-vmware.md](01-vmware.md) | VMware Workstation 25H2 的 VM 设定、BitLocker、和 Kali 分开网段、Auto Start | Windows 主机 |
| 2 | [02-ubuntu.md](02-ubuntu.md) | Ubuntu Server 26.04.1 安装选项、自动安全更新、时间同步、建立 `vesper` 用户 | VM |
| 3 | [03-ssh.md](03-ssh.md) | SSH 只接受 key、只给管理帐号用 | VM + 主机 |
| 4 | [04-proxy.md](04-proxy.md) | 出站 proxy（squid）和网域白名单 | VM |
| 5 | [05-firewall.md](05-firewall.md) | nftables：入站全拒（只留 SSH）、`vesper` 用户只能经 proxy 出网 | VM |
| 6 | [06-claude-code.md](06-claude-code.md) | 用 apt 安装 Claude Code、产生一年期 token、资料隐私设定 | VM |
| 7 | [07-worker-install.md](07-worker-install.md) | 安装 worker 程序、设定档、内容 repo `~/vesper-content`、`vesper init` | VM |
| 8 | [08-worker-service.md](08-worker-service.md) | systemd 服务与沙箱（逐行说明）、自检、启动 | VM |
| 9 | [09-first-run.md](09-first-run.md) | 第一次配对、验收检查、加固完成后拍快照 | 手机 + VM |

部署 Vercel 那一侧（环境变量、D1 数据库）请看[docs/deployment.md](../docs/deployment.md)。顺序上：**先把 Vercel 部署好**（第 7 步的 `vesper init` 要连到它），再做第 7 步之后的部分。

## 目录里的其他文件

- `files/`：要复制到 VM 上的设定档（`sshd-vesper.conf`、`squid.conf`、`nftables.conf`）。每个档案开头都有注解。
- `content-example/`：`~/vesper-content/` 的范例（偏好、模板、`ticket-types.json`）。这只是起点，请改成你自己的内容；**你真正的 `~/vesper-content/` 永远不要推送到任何地方**。
- `scripts/check-vm.sh`：**只读**的检查脚本，逐项印出 PASS / FAIL（不会修改任何东西）。每做完几步就可以跑一次。

## 怎么读这些指令

- 每个指令区块前面会标明**在哪里执行**：〔Windows PowerShell〕、〔VM 主控台〕（直接在 VMware 的 VM 视窗里）、或〔VM，经由 SSH 窗口〕。没标明的，都是在 VM 上用你的**管理帐号**执行。
- **`<尖括号>` 是占位符**，一定要换成你自己的值，而且尖括号本身也要删掉。例如 `ssh <管理帐号>@<VM 的 IP>` → `ssh knight@192.168.80.130`。改设定档后，用 `grep -n '<' 档案` 确认没有残留（各页都有写）。
- 范例里的 `knight`、`192.168.80.130` 只是示范，换成你的帐号和 IP。
- 结果不确定对不对时，把**原样的输出**贴给 Claude，不要先继续下一步。

## 几个固定的习惯

1. **复制指令前先看懂它。** 不懂的地方先问，不要直接贴上执行。
2. **secret 不进 shell history、不进截图。** 需要输入 token 的步骤都用「输入时不显示」的方式（`read -rs`），不要把 token 写在指令参数里。
3. **改 SSH 或防火墙之前，保留一个已登录的 SSH 窗口**，在另一个窗口测试新设定；真的被锁在外面，还可以用 VMware 的主控台登录。
4. **每完成一个阶段就拍快照**（VMware：VM → Snapshot → Take Snapshot）。加固全部完成、验收通过后，再拍一张「v1 基准」快照。

---

## v1 手动恢复（kill switch、LOCKDOWN 或 VM 本地锁之后）

v1 **没有**解锁指令。正式的解锁流程（`vesper unlock` + break-glass key + 轮换所有 token）是 v2 的范围（Build Spec §11.4）。在 v1 测试期间，如果你按了 kill switch，或系统进入 LOCKDOWN、VM 上了本地锁，用下面的方式**手动**恢复。

> 先查原因，再恢复。尤其是 **R8**（VM 发现伪造的 ticket、不在清单里的设备或无法解密的内容）和 **R7**（worker 的 VM 签名无效）都可能是真的攻击。没弄清楚之前，不要恢复。

### 1. 查原因

- 手机 PWA 的「日志」页（`view=full`）：看 `rule.triggered`、`vm.r8`、`kill_switch`、`system.state` 这几种事件。
- VM 上：

  ```bash
  sudo -u vesper -i vesper status        # 本地锁的原因与时间
  journalctl -u vesper-worker -n 100     # worker 的日志（不含任何内容，只有事件名称和 ticket id）
  ```

### 2. 把 Vercel 的系统状态改回 NORMAL

在 Cloudflare 仪表板打开这个 D1 数据库的 Console（查询）页面（选单名称以 Cloudflare 画面为准），执行：

```sql
UPDATE system_state
   SET state = 'NORMAL', since = CAST(strftime('%s','now') AS INTEGER) * 1000,
       trigger_rule = NULL, suspicious_device_id = NULL, version = version + 1
 WHERE id = 1;
UPDATE vm_identity SET latched = 0 WHERE id = 1;
```

- KILLED / LOCKDOWN 时所有会话都已撤销，所以每台设备之后都要重新登录。
- R8 的那张 ticket 已经被标成 `failed`（`error_code = vm_rejected`），不会再被领取。可以用下面的查询确认：

  ```sql
  SELECT id, status, error_code FROM tickets WHERE error_code = 'vm_rejected';
  ```

### 3. 移除 VM 的本地锁

```bash
sudo -u vesper rm /home/vesper/.local/share/vesper/state/latch
sudo systemctl restart vesper-worker
journalctl -u vesper-worker -f          # 看到 worker_start，之后没有 latched 就是恢复了（Ctrl+C 离开）
```

本地锁存在时，即使 Vercel 回报 NORMAL，worker 也**不会**处理任何 ticket（这是刻意的设计，§6.3）。所以第 2 步和第 3 步都要做。

### 4. 换掉用过的 secret

- 如果按过 kill switch：kill token 已经输入过，登录后到 PWA 的「设置 → 更换」换一组新的。
- 如果怀疑 worker token 外泄（例如 R7）：v1 没有轮换 worker token 的指令。最稳妥的做法是重设整个系统（清空 D1、在 VM 上移走 `keys/` 后重新 `vesper init`、所有设备重新配对）。v2 的 `vesper unlock` 会自动轮换。

---

## 平常的维护

- **系统更新**：`unattended-upgrades` 会自动装安全更新（见 02）。需要重开机时（`/var/run/reboot-required` 存在），找你方便的时间 `sudo reboot`。
- **Claude Code 更新**：apt 安装的版本**不会自动更新**。每隔一段时间执行 `sudo apt update && sudo apt upgrade claude-code`，然后 `sudo systemctl start vesper-selftest` 确认还能用（见 06、08）。
- **Vesper worker 更新**：见 07 的「更新 worker」。
- **Claude Code token**：一年后到期。到期前用 06 的步骤换新的。
- **出站规则的限制**：`vesper` 用户被 nftables 和 squid 限制，但**拿到 root 的攻击者可以关掉这些规则**。v3 会把出站管控移到 VM 外面（Build Spec §16.4、§19 v3）。
