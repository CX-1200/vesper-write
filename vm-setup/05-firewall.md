# 05 · 防火墙（nftables）

目标：

1. **入站**：全部拒绝，只有你的 Windows 主机可以 SSH（和 ping）进来（Build Spec §16.2）。
2. **出站**：`vesper` 用户只能连到本机的 proxy（`127.0.0.1:3128`），不能直接连外，连 DNS 也不行（§16.4）。其他用户（root 的 apt 更新、NTP 校时、squid 本身）不受影响。

为什么用 nftables 而不是 ufw：ufw 很方便，但它不支持「依用户（owner）」的出站规则。这里只用一套工具，避免两套规则互相干扰。

## 1. 先确认 ufw 没在运作

```bash
sudo ufw status
```

如果显示 `Status: active`，先关掉它（规则改由 nftables 管）：

```bash
sudo ufw disable
```

## 2. 安装并填入你的主机位址

```bash
sudo apt install nftables
sudo install -o root -g root -m 0644 /opt/vesper/vm-setup/files/nftables.conf /etc/nftables.conf
sudoedit /etc/nftables.conf
```

把 `<host-vmnet8-ip>` 换成 Windows 主机在 VMware NAT 网段里的位址（01 第 4 节用 `ipconfig` 查到的「VMware Network Adapter VMnet8」，例如 `192.168.80.1`）。

确认没有残留的占位符（应该**没有任何输出**）：

```bash
grep -n '<' /etc/nftables.conf
```

也可以在 VM 里交叉确认：

```bash
ip route | grep default          # default via 192.168.<x>.2 —— .2 是 NAT 闸道，主机通常是同网段的 .1
```

## 3. 检查、套用

```bash
sudo nft -c -f /etc/nftables.conf && echo "语法 OK"
```

`nft` 在载入时会把用户名称 `vesper` 换成 UID，所以 02 一定要先建立 `vesper` 用户，否则这里会出现 `User does not exist`。

**保留目前的 SSH 窗口**，然后：

```bash
sudo systemctl enable --now nftables
sudo nft list ruleset
```

立刻从 Windows **开一个新的** PowerShell 试 `ssh <管理帐号>@<VM 的 IP>`。连得上才关掉旧窗口。连不上的话，在旧窗口（已建立的连线不受影响）或 VMware 主控台执行 `sudo systemctl stop nftables`（会清空规则），修正位址后再试一次。

## 4. 每条规则在做什么

**input 链（进入 VM 的封包），默认 `drop`：**

| 规则 | 作用 |
|---|---|
| `ct state established,related accept` | VM 自己发出去的连线，回应可以进来（否则 VM 什么都连不出去） |
| `ct state invalid drop` | 不属于任何合法连线的封包直接丢掉 |
| `iifname "lo" accept` | 本机内部的通讯（worker ↔ squid）不受影响 |
| `meta l4proto ipv6-icmp accept` | IPv6 的邻居探索需要 ICMPv6；没有它 IPv6 会坏掉 |
| `udp sport 67 udp dport 68 accept` | VMware NAT 的 DHCP 回应（VM 续租 IP 位址需要） |
| `ip saddr $ADMIN_HOST icmp type echo-request accept` | 只有主机可以 ping |
| `ip saddr $ADMIN_HOST tcp dport 22 ct state new accept` | 只有主机可以开 SSH 连线；同网段的其他 VM（例如 Kali）连不进来 |
| `counter drop` | 其余全部丢掉，计数器让你看得到被挡了多少 |

**forward 链**：这台 VM 不转送任何封包。

**output 链（VM 发出的封包），默认 `accept`，但对 `vesper` 用户：**

| 规则 | 作用 |
|---|---|
| `meta skuid "vesper" ip daddr 127.0.0.1 tcp dport 3128 accept` | `vesper` 只能连本机的 squid |
| `meta skuid "vesper" limit rate 6/minute … log prefix "vesper-egress-blocked: "` | 其他连线尝试写进核心日志（每分钟最多 6 笔，避免洗版） |
| `meta skuid "vesper" counter reject with icmpx type admin-prohibited` | 其余一律拒绝，而且是**立刻**失败（不是等到逾时） |

## 5. 测试

```bash
# 直接连外：应该立刻失败（例如 No route to host 或 Connection refused）
sudo -u vesper curl -sS --max-time 5 --noproxy '*' https://example.com/

# 直接查 DNS：应该失败
sudo -u vesper dig +time=2 +tries=1 @127.0.0.53 example.com || true
sudo -u vesper dig +time=2 +tries=1 @1.1.1.1 example.com || true

# 经由 proxy、白名单内：还是可以（印出 HTTP 状态码，例如 404）
sudo -u vesper curl -sS -o /dev/null -w '%{http_code}\n' --proxy http://127.0.0.1:3128 https://api.anthropic.com/

# 你的管理帐号不受影响
curl -sS -o /dev/null -w '%{http_code}\n' https://example.com/

# 被挡下的尝试会留下记录
sudo journalctl -k --since "10 minutes ago" | grep vesper-egress-blocked
```

`dig` 如果没装：`sudo apt install bind9-dnsutils`。

## 6. 一个要知道的细节：经由本机服务的 DNS

nftables 管的是**网络封包**。在 Ubuntu 上，程序查网域名称时，常常不是自己发 DNS 封包，而是经由 systemd-resolved 的本机 socket 去问；真正发出 DNS 封包的是 systemd-resolved（另一个用户），所以上面的规则挡不到。理论上，攻击者可以把资料藏在网域名称里，用这个方式送出去（DNS tunneling）。

所以 08 的 worker 沙箱另外做了两件事：把 systemd-resolved 的 socket 和 D-Bus 都设成 worker 看不到（`InaccessiblePaths=`），并且只允许连 `127.0.0.1`（`IPAddressAllow=`）。worker 和 Claude Code 本来就不需要自己查 DNS：网域名称由 squid 解析。

## 7. 这道防线的限制

- **拿到 root 的攻击者可以关掉这些规则**（`nft flush ruleset`）。v1 把管控放在 VM 里面，只能防住「拿到 `vesper` 权限」的攻击者。v3 会把出站管控移到 VM 外面（Build Spec §19 v3）。
- 白名单是**网域**层级的：worker 可以连 `api.anthropic.com`，就能对它发任何请求。真正防止资料被送到错误地方的，还是「Claude Code 没有任何工具」这件事（docs/verification.md 第 2 项）。
- 需要更新系统或 Claude Code 时**不用放宽规则**：apt 以 root 执行，不受 `vesper` 的出站规则限制。
