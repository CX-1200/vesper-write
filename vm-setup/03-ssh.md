# 03 · SSH：只接受 key、只给管理帐号

目标：只有你的 Windows 主机、拿着你的私钥，才能登录 VM；密码猜测完全无效。之后输入 token、贴设定，也都经由这个 SSH 窗口（01 已经关掉剪贴板共享）。

> **这一页的顺序很重要：** 先确认「用 key 登录」**已经成功**（第 4 节），才关掉密码登录（第 5 节）。顺序反过来，你会被锁在外面。
>
> **安全网：** 改 SSH 设定时，保留一个已登录的窗口不要关，在**另一个**窗口测试。真的被锁在外面，还可以从 **VMware 主控台**（直接在 VM 视窗里）登录修正（第 7 节）。

## 先弄清楚：key 放在哪里

SSH key 是**一对**档案，只在 **Windows** 上产生一次：

| 档案 | 在哪里 | 作用 |
|---|---|---|
| 私钥 `id_ed25519` | 只留在 Windows（`C:\Users\<你>\.ssh\`），永远不复制到别处 | 证明「我是我」 |
| 公钥 `id_ed25519.pub` | 复制一份到 VM 管理帐号的 `~/.ssh/authorized_keys` | VM 用它认出你的私钥 |

**VM 里不需要另外产生 key。** VM 只需要「认得」你的公钥。

## 1. 〔VM 主控台〕确认 SSH 服务在运行

```bash
sudo systemctl status ssh --no-pager
```

- `active (running)` → 好，继续。
- `Unit ssh.service could not be found` → 安装 Ubuntu 时没勾 OpenSSH server，现在安装：

  ```bash
  sudo apt install openssh-server
  sudo systemctl enable --now ssh
  ```

- `inactive (dead)` → `sudo systemctl enable --now ssh`

再查 VM 的 IP（记下 `inet` 后面那个，例如 `192.168.80.130`）：

```bash
ip -4 addr show scope global
```

> 从 Windows 连线时看到 **`Connection refused`**，几乎都是这一节的问题（服务没装或没启动），或 IP 打错（要用 VM 里查到的位址，不是 Windows 自己的）。

## 2. 〔Windows PowerShell〕产生 key

```powershell
ssh-keygen -t ed25519 -C "vesper-admin"
```

- 存放位置直接按 Enter，用默认的 `C:\Users\<你>\.ssh\id_ed25519`。
- **设定一组 passphrase**：私钥档案就算被复制走，也不能直接使用。

确认两个档案都在：

```powershell
dir $env:USERPROFILE\.ssh
```

应该看到 `id_ed25519` 和 `id_ed25519.pub`。

## 3. 〔Windows PowerShell〕把公钥放进 VM

这时 VM 还接受密码登录（这是**最后一次**用密码）。`knight` 换成你的管理帐号、IP 换成第 1 节查到的：

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh knight@192.168.80.130 "umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

它会问 VM 管理帐号的**密码**；输入后没有任何输出就结束，代表成功。

## 4. 〔Windows PowerShell〕确认用 key 登录成功 —— 没成功不要往下做

```powershell
ssh knight@192.168.80.130
```

**成功的样子：** 它问的是 `Enter passphrase for key ...`（第 2 节设的 passphrase），**不是** VM 的密码，然后进入 VM。

如果它还是问 VM 的密码，代表 key 没被接受。登录进去后检查：

```bash
cat ~/.ssh/authorized_keys          # 应该有一行 ssh-ed25519 AAAA... vesper-admin
ls -ld ~ ~/.ssh ~/.ssh/authorized_keys
```

`~/.ssh` 要是 `drwx------`，`authorized_keys` 要是 `-rw-------`，拥有者都是你的管理帐号。不对的话：`chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`，再试一次。仍然不行，在 PowerShell 跑 `ssh -v knight@<IP>`，把最后 20 行贴给 Claude。

## 5. 〔VM，经由 SSH 窗口〕关掉密码登录

**保持第 4 节登录成功的这个窗口开着**，在里面执行：

```bash
whoami
```

记下印出来的名字（例如 `knight`）。**它不能是 `root`**；如果是 `root`，先 `exit` 回到管理帐号。

安装设定档，再**直接写入你的帐号名称**（把下面的 `knight` 换成 `whoami` 印出来的名字）：

```bash
sudo install -o root -g root -m 0644 /opt/vesper/vm-setup/files/sshd-vesper.conf /etc/ssh/sshd_config.d/10-vesper.conf
sudo sed -i 's/^AllowUsers.*/AllowUsers knight/' /etc/ssh/sshd_config.d/10-vesper.conf
sudo grep -n AllowUsers /etc/ssh/sshd_config.d/10-vesper.conf
```

**重启前必须确认**最后一行印出的是 `AllowUsers knight`（你的名字），**不是** `AllowUsers <your-admin-user>`，也不是后面空白的 `AllowUsers`。这两种情况下重启，**没有任何帐号能登录**。

确认没问题后：

```bash
sudo sshd -t && echo "设定语法 OK"
sudo systemctl restart ssh
```

`sshd -t` 有印出错误就**不要**重启，先修正。

档案里每一行的用途都写在注解里。重点：

| 设定 | 作用 |
|---|---|
| `AuthenticationMethods publickey`、`PasswordAuthentication no`、`KbdInteractiveAuthentication no` | 只接受 key，猜密码完全没用 |
| `PermitRootLogin no`、`AllowUsers <管理帐号>` | root 和 `vesper` 都不能远端登录 |
| `X11Forwarding no`、`AllowTcpForwarding no`、`PermitTunnel no` …… | 不能把 SSH 当成隧道，绕过 05 的防火墙 |
| `MaxAuthTries 3`、`LoginGraceTime 30` | 拖慢猜测 |

## 6. 〔Windows，开一个新的 PowerShell〕确认

**原本的窗口不要关。**

```powershell
ssh knight@192.168.80.130
# 应该成功（问 passphrase）

ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password knight@192.168.80.130
# 应该失败：Permission denied (publickey).  ← 这是「对的」结果，代表密码登录已经关掉
```

两个结果都符合，才关掉旧窗口。

在 VM 上看实际生效的值：

```bash
sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|allowusers|authenticationmethods|x11forwarding|allowtcpforwarding)'
```

如果 `passwordauthentication` 还是 `yes`，通常是有别的档案先设定了它：`grep -rn PasswordAuthentication /etc/ssh/sshd_config /etc/ssh/sshd_config.d/`，把我们的档案名称改得更前面（例如 `05-vesper.conf`）。

## 7. 被锁在外面时怎么办

症状：两个测试都显示 `Permission denied (publickey)`（第一个应该成功却失败）。代表 VM 不认得你的 key，而密码登录已经关了。

1. 〔VM 主控台〕暂时停用 Vesper 的 SSH 设定：

   ```bash
   sudo mv /etc/ssh/sshd_config.d/10-vesper.conf /etc/ssh/sshd_config.d/10-vesper.conf.off
   sudo systemctl restart ssh
   ```

2. 回到第 3 节放公钥、第 4 节确认 key 登录成功。
3. 〔SSH 窗口〕装回设定：

   ```bash
   sudo mv /etc/ssh/sshd_config.d/10-vesper.conf.off /etc/ssh/sshd_config.d/10-vesper.conf
   sudo sshd -t && sudo systemctl restart ssh
   ```

4. 重做第 6 节。

## 8. 「只监听 NAT 网卡」（可选）

Build Spec §16.5 要求 sshd 只监听 VMware NAT 那张网卡。这台 VM 只有**一张**网卡（NAT），所以默认的「监听所有位址」实际上就是 NAT 网卡加上 loopback；05 的防火墙还会再限制只有主机能连 22 埠。

如果你还是想明确写死 `ListenAddress`，VM 必须先有固定 IP（否则 DHCP 换了位址，sshd 会启动失败、你会被锁在外面）：

1. 用 netplan 设定固定 IP（`/etc/netplan/` 下的设定档，位址选在 NAT 网段里、DHCP 范围以外，gateway 是 `192.168.<x>.2`）。
2. 取消 `10-vesper.conf` 最后一行 `ListenAddress` 的注解，填上那个固定 IP。
3. Ubuntu 的 ssh 是由 systemd socket 启动的，改了监听位址要重新产生 socket 设定：

   ```bash
   sudo sshd -t && sudo systemctl daemon-reload && sudo systemctl restart ssh.socket ssh
   ```

不做也符合「只有 NAT 网卡」的效果。

## 9. 备份用的 forced-command key（v2）

Build Spec §16.5 第二点（主机那把 key 只能执行 `vesper backup serve` / `ack`）属于 §15 的每周备份，是 **v2** 的范围，v1 不设定。
