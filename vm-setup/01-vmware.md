# 01 · VMware Workstation 25H2（Windows 主机）

目标：让 VM 和主机之间只剩一条你能控制的通道（SSH），并在主机开机时自动启动 VM。

> 选单名称来自 Workstation 的一般版面，**以你画面上看到的为准**。Auto Start 的位置有查过 25H2 的官方手册（docs/verification.md 第 13 项，🟡）。

## 1. 建立 VM 时的选择

- **客体系统**：Ubuntu Server 26.04.1 LTS（64 位），见 02。
- **网络**：NAT（VMnet8）。为什么：VM 可以主动连出去（拉取 ticket、连 Anthropic），但外面的机器不能主动连进来；也不会像 Bridged 那样直接出现在你家里的局域网上。
- **硬盘**：20 GB 以上就够。
- **不要加密这台 VM。** 加密的 VM 无法设定 Auto Start（官方手册明确写的限制）。资料的静态保护改由**主机的 BitLocker** 负责（下面第 3 节）。

## 2. 移除用不到的硬件、关闭共享

VM 关机状态下，打开 **VM → Settings**：

**Hardware 页签**——把下面这些移除（选取后按 Remove）：

- USB Controller
- Sound Card
- Printer
- 摄像头（如果有列出来）
- 光驱（CD/DVD）：安装完 Ubuntu 后也可以移除，或至少取消「Connect at power on」

为什么：每一个虚拟设备都是 VM 和主机之间的一条额外通道，也是一段额外的程序码（攻击面）。这台 VM 只需要 CPU、内存、硬盘和一张 NAT 网卡。

**Options 页签**：

- **Shared Folders**：选 **Disabled**。共享文件夹会让 VM 直接读写主机的档案。
- **Guest Isolation**：取消勾选 **Enable drag and drop** 和 **Enable copy and paste**。这样 VM 里的东西不能经由剪贴板跑到主机，反之亦然。之后要把 token 之类的文字送进 VM，一律经由 SSH 窗口贴上（见 03）。
- **VMware Tools**：Ubuntu Server 会自动装 `open-vm-tools`，可以保留（关机、时间同步需要它）；上面两个隔离选项关掉就好。

## 3. 确认主机已开启 BitLocker

VM 的虚拟硬盘（`.vmdk`）存在主机上，里面有 VM 的私钥、Claude Code token 和本地 ticket 记录。VM 本身不加密，所以要靠主机的磁盘加密保护这些档案（例如笔电遗失时）。

在 Windows 用「以系统管理员身分执行」开启 PowerShell：

```powershell
manage-bde -status C:
```

确认 `Protection Status` 是 `Protection On`，`Conversion Status` 是 `Fully Encrypted`。如果 VM 放在别的磁盘（例如 `D:`），那颗磁盘也要检查。

## 4. 和 Kali 放在不同的网段

Build Spec §16.1：Vesper 的 VM 不要和 Kali 在同一个网段。为什么：Kali 里常会跑扫描、攻击工具或你正在研究的样本；同一个网段时，它可以直接扫描、甚至对 Vesper 做 ARP 欺骗。

在 Workstation：**Edit → Virtual Network Editor**（需要按 Change Settings 取得系统管理员权限）。

- Vesper 的 VM 用 **VMnet8（NAT）**。
- Kali 改用别的网络：例如 **Host-only（VMnet1）**，或在 Kali 的 Network Adapter 里选 **LAN segment**（只有同一个 segment 里的 VM 互相看得到）。
- 如果 Kali 也需要上网：在 Virtual Network Editor 新增一个网络给它用；Workstation 在 Windows 上**可能只允许一个 NAT 网络**，这种情况下可以只在需要时把 Kali 临时切到 NAT，用完切回来。

即使 Kali 不小心接到同一个 NAT，05 的防火墙也只允许**主机**连 VM 的 SSH，其他来源全部丢弃。但分开网段才是第一道防线。

顺便记下 NAT 网段：在 Windows 执行 `ipconfig`，找到「VMware Network Adapter VMnet8」的 IPv4 位址（通常是 `192.168.<x>.1`）。这个 `192.168.<x>.1` 就是**主机在 NAT 网段里的位址**，05 的防火墙会用到。

## 5. Auto Start（主机开机时自动启动 VM）

依 25H2 官方手册：

1. Windows 按 `Win + R`，输入 `services.msc`。找到 **VMware Autostart Service**，把「启动类型」设为**自动**，然后启动它。
2. 在 Workstation 左侧的 Library，**在「My Computer」上按右键 → Configure Auto Start VMs**，勾选 Vesper 的 VM，设定顺序。

确认：重新开机 Windows，不要登录也等一两分钟，再登录看看 VM 是否已经在跑（Workstation 里会显示为 running；或从主机 `ssh` 进去）。

## 6. 快照

安装完 Ubuntu、做完 02–05 之后先拍一张快照（**VM → Snapshot → Take Snapshot**），名称例如「加固完成（未装 Vesper）」。全部完成、验收通过后再拍一张「v1 基准」。快照让你在做错设定、或怀疑 VM 被入侵时能回到干净的状态。

> 快照里也包含 VM 的私钥和 token。它们和 `.vmdk` 一样存在主机硬盘上，由 BitLocker 保护；不要把快照复制到别的地方。
