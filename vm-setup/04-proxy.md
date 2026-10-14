# 04 · 出站 proxy 与网域白名单

目标：`vesper` 用户（worker、Claude Code、`vesper` 指令）只能经由一个本机 proxy 连到四个网域：

- `api.anthropic.com`（Claude 的模型请求）
- `platform.claude.com`（claude.ai 帐号 token 的交换与更新）
- `claude.ai`（claude.ai 帐号认证）
- 你的 Vercel 网域（拉取 ticket、写回结果）

这四个和 Claude Code 官方的「Network access requirements」一致（docs/verification.md 第 5 项）。其他地方一律拒绝。05 会再用防火墙确保 `vesper` **只能**走这个 proxy。

为什么要这样：如果有人设法让 Claude Code 或 worker 做出意料之外的事（例如 prompt injection），它也没办法把资料送到攻击者的网站，因为根本连不出去。

## 1. squid 还是 tinyproxy？

两个都在 Ubuntu 26.04 的套件库里（docs/verification.md 第 12 项）。我的比较：

| | squid 7.2 | tinyproxy 1.11.3 |
|---|---|---|
| 套件库 | **main**：Canonical 提供安全更新 | universe：社群维护，安全更新没有保证 |
| 白名单写法 | `dstdomain` 写**完整主机名称**，精确比对 | 过滤档用正规表示式，容易写错（例如忘了跳脱 `.`，`claude.ai` 也会比对到 `claudexai.com`） |
| 记录 | 每个连线一行，有目的主机 | 较简略 |
| 资源 | 较大，但对这台 VM 不是问题 | 很小 |
| 设定 | 档案大，但我们只用约 20 行 | 简单 |

**我的建议是 squid**：有 Canonical 的安全更新，白名单是精确比对而不是正规表示式。这是需要你确认的决定（docs/decisions.md）。下面的步骤用 squid；如果你选 tinyproxy，告诉我，我再补上对应的设定和测试。

## 2. 安装与设定

```bash
sudo apt install squid
sudo cp /etc/squid/squid.conf /etc/squid/squid.conf.dist        # 保留原本的范例档
sudo install -o root -g root -m 0644 /opt/vesper/vm-setup/files/squid.conf /etc/squid/squid.conf
sudoedit /etc/squid/squid.conf
```

在编辑器里把 `<your-vercel-domain>` 改成你的 Vercel 网域，例如 `vesper-abc123.vercel.app`（不要加 `https://`，也不要加路径）。如果你用自己的网域，就填那个网域。

检查语法、重启、设为开机启动：

```bash
sudo squid -k parse 2>&1 | grep -Ei 'error|fatal|warning' || echo "没有错误"
sudo systemctl restart squid
sudo systemctl enable squid
sudo ss -tlnp | grep 3128          # 应该只有 127.0.0.1:3128
```

设定档的每个部分都有注解。重点：

- `http_port 127.0.0.1:3128`：只监听 loopback，VM 以外的机器不能用这个 proxy。
- `http_access deny !CONNECT`：不接受明文 HTTP，只接受 HTTPS 隧道。
- `http_access deny CONNECT !SSL_ports`：隧道只能连 443 埠。
- `http_access allow localhost vesper_allowed` 然后 `deny all`：只有白名单上的主机。
- `cache deny all`：不缓存任何东西。

squid 只看得到「连到哪个主机」，看不到内容：worker 和 Claude Code 与 Vercel / Anthropic 之间是端到端的 TLS。

## 3. 测试

```bash
# 白名单内：应该印出一个 HTTP 状态码（例如 404），代表隧道建立成功
sudo -u vesper curl -sS -o /dev/null -w '%{http_code}\n' --proxy http://127.0.0.1:3128 https://api.anthropic.com/

# 你的 Vercel：应该印出 401（还没登录），代表连得到
sudo -u vesper curl -sS -o /dev/null -w '%{http_code}\n' --proxy http://127.0.0.1:3128 https://<你的 Vercel 网域>/api/config

# 白名单外：应该失败，讯息类似 CONNECT tunnel failed, response 403
sudo -u vesper curl -sS -o /dev/null --proxy http://127.0.0.1:3128 https://example.com/

# 明文 HTTP：应该被拒绝（403）
sudo -u vesper curl -sS -o /dev/null -w '%{http_code}\n' --proxy http://127.0.0.1:3128 http://example.com/
```

看 squid 的记录（只有主机名称、没有内容）：

```bash
sudo tail -n 20 /var/log/squid/access.log
```

被拒绝的连线会显示 `TCP_DENIED/403`。之后如果 worker 或 Claude Code 出现连线问题，先看这里：如果看到白名单以外的网域，代表 Claude Code 需要的网域有变化，查官方文件后再决定要不要加。

## 4. 这时候还没完成

现在 `vesper` 用户**如果不设定 proxy**，还是可以直接连外网。05 的防火墙会把这条路关掉。
