# 03 · SSH：只接受 key、只给管理帐号

目标：只有你的 Windows 主机、拿着你的私钥，才能登录 VM；密码猜测完全无效。之后输入 token、贴设定，也都经由这个 SSH 窗口（01 已经关掉剪贴板共享）。

> **安全习惯：** 改 SSH 设定时，保留一个已登录的窗口不要关，在**另一个**窗口测试。真的被锁在外面，还可以从 VMware 主控台登录修正。

## 1. 在 Windows 主机产生 key

Windows 10/11 内建 OpenSSH client。开启 PowerShell：

```powershell
ssh-keygen -t ed25519 -C "vesper-admin"
```

- 存放位置用默认的 `C:\Users\<你>\.ssh\id_ed25519`。
- **设定一组 passphrase**：这样私钥档案被复制走，也不能直接使用。

## 2. 把公钥放进 VM

先查 VM 的 IP（在 VM 主控台）：

```bash
ip -4 addr show scope global
```

在 Windows PowerShell（这时 VM 还接受密码登录，最后一次用密码）：

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh <管理帐号>@<VM 的 IP> "umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

测试用 key 登录（会问 passphrase，不会问 VM 密码）：

```powershell
ssh <管理帐号>@<VM 的 IP>
```

## 3. 套用 Vesper 的 SSH 设定

在 VM 上（`/opt/vesper` 是 02 第 7 节放的程序码）：

```bash
sudo install -o root -g root -m 0644 /opt/vesper/vm-setup/files/sshd-vesper.conf /etc/ssh/sshd_config.d/10-vesper.conf
sudo sed -i "s/<your-admin-user>/$USER/" /etc/ssh/sshd_config.d/10-vesper.conf
sudo grep -n AllowUsers /etc/ssh/sshd_config.d/10-vesper.conf      # 确认是你的管理帐号名称
sudo sshd -t && echo "设定语法 OK"
sudo systemctl restart ssh
```

`sshd -t` 会检查语法；它有印出错误就**不要**重启 ssh，先修正。

档案里每一行的用途都写在注解里。重点：

| 设定 | 作用 |
|---|---|
| `AuthenticationMethods publickey`、`PasswordAuthentication no`、`KbdInteractiveAuthentication no` | 只接受 key，猜密码完全没用 |
| `PermitRootLogin no`、`AllowUsers <管理帐号>` | root 和 `vesper` 都不能远端登录 |
| `X11Forwarding no`、`AllowTcpForwarding no`、`PermitTunnel no` …… | 不能把 SSH 当成隧道，绕过 05 的防火墙 |
| `MaxAuthTries 3`、`LoginGraceTime 30` | 拖慢猜测 |

## 4. 确认

**保留原本的窗口**，在 Windows 开一个新的 PowerShell：

```powershell
ssh <管理帐号>@<VM 的 IP>                                            # 应该成功
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password <管理帐号>@<VM 的 IP>
# 应该失败：Permission denied (publickey).
```

在 VM 上看实际生效的值：

```bash
sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|allowusers|authenticationmethods|x11forwarding|allowtcpforwarding)'
```

如果 `passwordauthentication` 还是 `yes`，通常是有别的档案先设定了它：`grep -rn PasswordAuthentication /etc/ssh/sshd_config /etc/ssh/sshd_config.d/`，把我们的档案名称改得更前面（例如 `05-vesper.conf`）。

## 5. 「只监听 NAT 网卡」

Build Spec §16.5 要求 sshd 只监听 VMware NAT 那张网卡。这台 VM 只有**一张**网卡（NAT），所以默认的「监听所有位址」实际上就是 NAT 网卡加上 loopback；05 的防火墙还会再限制只有主机能连 22 埠。

如果你还是想明确写死 `ListenAddress`，VM 必须先有固定 IP（否则 DHCP 换了位址，sshd 会启动失败、你会被锁在外面）：

1. 用 netplan 设定固定 IP（`/etc/netplan/` 下的设定档，位址选在 NAT 网段里、DHCP 范围以外，gateway 是 `192.168.<x>.2`）。
2. 取消 `10-vesper.conf` 最后一行 `ListenAddress` 的注解，填上那个固定 IP。
3. Ubuntu 的 ssh 是由 systemd socket 启动的，改了监听位址要重新产生 socket 设定：

   ```bash
   sudo sshd -t && sudo systemctl daemon-reload && sudo systemctl restart ssh.socket ssh
   ```

这一步是**可选**的，不做也符合「只有 NAT 网卡」的效果。

## 6. 备份用的 forced-command key（v2）

Build Spec §16.5 第二点（主机那把 key 只能执行 `vesper backup serve` / `ack`）属于 §15 的每周备份，是 **v2** 的范围，v1 不设定。
