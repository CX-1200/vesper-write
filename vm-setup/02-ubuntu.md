# 02 · Ubuntu Server 26.04.1 LTS

目标：一台最小、会自动装安全更新、时间准确的服务器，外加一个专门跑 worker 的低权限用户 `vesper`。

## 1. 安装时的选择

- 安装类型：**Ubuntu Server**（不要装桌面环境）。少一个图形界面，就少一大块要更新、可能有漏洞的程序。
- 帐号：建立**你自己的管理帐号**（例如 `admin`），它会有 `sudo` 权限。**不要**把它叫做 `vesper`；`vesper` 是之后另外建立、没有 sudo 的服务用户。
- **勾选「Install OpenSSH server」**。先不要从 GitHub 汇入 key，03 会手动设定。
- 「Featured server snaps」**全部不选**。
- 磁盘：用默认的 guided 设定即可。**不要**选磁盘加密（LUKS）：开机时要输入密码，VM 就无法无人值守地自动启动；静态加密由主机 BitLocker 负责（01 第 3 节）。

## 2. 第一次登录后：更新

```bash
sudo apt update
sudo apt full-upgrade
sudo reboot
```

## 3. 自动安全更新（unattended-upgrades）

Ubuntu Server 通常默认已经安装并启用。确认：

```bash
systemctl status unattended-upgrades --no-pager
cat /etc/apt/apt.conf.d/20auto-upgrades
```

第二个指令应该印出这两行（数字是 `"1"`）：

```
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

如果档案不存在或数字是 `"0"`：

```bash
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades     # 出现问题时选 Yes
```

为什么：这台 VM 会长时间无人看管地运行，安全更新要能自己装上。

（可选）核心更新需要重开机才会生效。如果想让它在半夜自动重开，可以编辑 `/etc/apt/apt.conf.d/50unattended-upgrades`，把 `Unattended-Upgrade::Automatic-Reboot` 设成 `"true"`、`Unattended-Upgrade::Automatic-Reboot-Time` 设成例如 `"04:00"`。VM 重开后 worker 会自动启动（08 设定 `enable`）。

## 4. 时间同步与时区

Vesper 的每个请求都带时间戳，签名只在 ±60 秒内有效；TOTP 也依赖准确的时间。时间不准，worker 会被 Vercel 拒绝。

```bash
timedatectl
```

确认 `System clock synchronized: yes`、`NTP service: active`。如果不是：`sudo timedatectl set-ntp true`。

时区（只影响日志的显示；Vesper 的「每日上限」「非活跃时段」在程序里固定用吉隆坡时间计算，和这个设定无关）：

```bash
sudo timedatectl set-timezone Asia/Kuala_Lumpur
```

## 5. 建立 `vesper` 用户

worker、Claude Code 子进程、`vesper` 指令都以这个用户执行。它**没有 sudo、没有密码、不能 SSH 登录**；万一 worker 或 Claude Code 被攻破，攻击者拿到的也只是这个受限的帐号（再加上 08 的 systemd 沙箱与 05 的防火墙）。

```bash
sudo useradd --create-home --shell /bin/bash --user-group vesper
sudo passwd -l vesper              # 锁住密码：这个帐号不能用密码登录
sudo chmod 700 /home/vesper        # 其他用户不能读它的家目录（里面有 VM 私钥）
```

为什么 shell 是 `/bin/bash` 而不是 `nologin`：你之后要用 `sudo -u vesper -i vesper …` 以这个用户执行管理指令，`-i` 需要一个可用的登录 shell。它没有密码、也不在 03 的 `AllowUsers` 里，所以无法远端登录。

确认：

```bash
id vesper                          # 只应该有 vesper 这个群组，不能有 sudo
sudo -u vesper -i whoami           # 印出 vesper
sudo grep '^vesper:' /etc/shadow | cut -d: -f2 | cut -c1   # 印出 ! 表示密码已锁
```

## 6. （可选）移除用不到的服务

```bash
sudo ss -tulpn
```

列出所有在监听的服务。此时应该只有 `sshd`（22 埠）和 `systemd-resolved`（`127.0.0.53`）。之后装了 squid 会多一个 `127.0.0.1:3128`。

Vesper 不需要 snap。如果想再缩小攻击面，可以移除 snapd：

```bash
snap list                          # 先看有没有装任何 snap；没有就可以移除
sudo apt purge snapd
```

## 7. 把 Vesper 的程序码放到 VM 上

接下来几页要用到 `vm-setup/files/` 里的设定档，07 要安装 `worker/`。把整个 repo 放在 `/opt/vesper`，**由 root 拥有**：`vesper` 用户只能读、不能改它要执行的程序码。

```bash
sudo apt install git                 # 通常已经装好
sudo git clone https://github.com/<你的 GitHub 帐号>/<repo 名称>.git /opt/vesper
sudo git -C /opt/vesper log -1 --format='%H %s'
```

- 如果 repo 是**私有**的：git 会问帐号和密码。密码栏位请贴一个 GitHub **fine-grained personal access token**，权限只给这一个 repo 的 *Contents: Read-only*，有效期设短一点（例如 7 天）。输入时不会显示，也不会存起来（这台 VM 没有设定 credential helper）。用完可以到 GitHub 删除这个 token。
- 最后一行印出的 commit hash，和 GitHub 网页上你要部署的那个 commit 比对一致，才继续。这样可以确认 VM 拿到的就是你看过的程序码。

确认权限：

```bash
ls -ld /opt/vesper                   # 拥有者应该是 root root
```

---

做完这一页，可以跑一次检查脚本（它只读，不会修改任何东西）：

```bash
sudo bash /opt/vesper/vm-setup/scripts/check-vm.sh
```

现在很多项目会是 FAIL 或 SKIP（还没做到），这是正常的。之后每做完一页再跑一次。
