# 06 · Claude Code：安装、一年期 token、隐私设定

目标：用官方的 apt 套件库装好 Claude Code（有签名、不会自己更新），并产生一个**只能发模型请求**的一年期 token，安全地交给 worker。

下面的 apt 指令一字不改地取自官方文件 <https://code.claude.com/docs/en/setup>（Install with Linux package managers → apt）。

## 1. 用 apt 安装

```bash
sudo apt install curl gnupg
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL https://downloads.claude.ai/keys/claude-code.asc \
  -o /etc/apt/keyrings/claude-code.asc
gpg --show-keys /etc/apt/keyrings/claude-code.asc
```

**确认指纹**：`gpg` 印出的指纹必须是

```
31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
```

（官方文件写的值；docs/verification.md 也记了同一个。）不一致就停下来，不要继续：代表下载到的不是 Anthropic 的签名密钥。为什么要比对：之后 apt 会用这把密钥验证每一个 Claude Code 套件，如果它是假的，攻击者就能让你装上被改过的 Claude Code。

注册套件库（`stable` 频道）并安装：

```bash
echo "deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/stable stable main" \
  | sudo tee /etc/apt/sources.list.d/claude-code.list
sudo apt update
sudo apt install claude-code
```

## 2. 确认版本（Haiku 5.5 需要 v2.1.293 以上）

```bash
claude --version
command -v claude                       # 记下这个路径，07 的 worker.json 要用（通常是 /usr/bin/claude）
```

官方文件写 Haiku 5.5 要用 **v2.1.293 或更新**的版本（docs/verification.md 第 1 项）。`stable` 频道大约落后一周；如果版本低于 2.1.293，改用 `latest` 频道（官方文件的写法，路径和 suite 名称都要改）：

```bash
echo "deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/latest latest main" \
  | sudo tee /etc/apt/sources.list.d/claude-code.list
sudo apt update
sudo apt install claude-code
claude --version
```

之后要升级：`sudo apt update && sudo apt upgrade claude-code`。apt 安装的 Claude Code **不会自己更新**（官方文件写明），worker 也另外设了 `DISABLE_AUTOUPDATER=1`。版本由你决定什么时候换，升级后跑一次 08 的自检。

## 3. 产生一年期 token（`claude setup-token`）

官方文件：`claude setup-token` 会走和 `/login` 相同的浏览器授权流程，核准后把 token **印在终端**；它不会把 token 存到任何地方。这个 token 需要 Pro / Max / Team / Enterprise 计划，**只能发模型请求**（不能开 Remote Control，也拿不到 claude.ai connectors）。

在 VM 上（用你的管理帐号、经由 SSH 窗口；**不是** `vesper` 用户）：

```bash
claude setup-token
```

- 它会显示一个网址。在**主机的浏览器**打开它，登录你的 claude.ai 帐号并核准。
- 浏览器如果显示一段 code，而不是自动跳回来，就把那段 code 贴回终端的 `Paste code here if prompted` 提示（官方文件说明：经由 SSH 时常会这样）。
- 完成后，token 会印在终端上。**先不要关窗口**，接着做第 4 步。

## 4. 把 token 存给 worker（只有 root 读得到）

```bash
sudo install -d -o root -g root -m 0755 /etc/vesper
sudo bash -c 'umask 077; read -rsp "贴上 Claude Code token（不会显示）: " T; echo; printf "%s\n" "$T" > /etc/vesper/claude-oauth-token; unset T'
sudo ls -l /etc/vesper/claude-oauth-token          # 应该是 -rw------- root root
sudo wc -c /etc/vesper/claude-oauth-token          # 只看长度，不要 cat 出来
```

为什么这样做：

- `read -rs`：输入时不显示，token 也**不会出现在 shell history**（它不是指令的一部分）。
- 档案权限 `0600`、拥有者 root：`vesper` 用户自己读不到它。08 的 systemd 用 `LoadCredential=` 在服务启动时把它交给 worker；worker 只把它放进 Claude Code 子进程的环境变量 `CLAUDE_CODE_OAUTH_TOKEN`，**不会**放进命令列参数（`ps` 看得到参数）或任何日志。

做完后清掉画面上的 token：

```bash
clear
```

再把这个 SSH 窗口整个关掉（Windows Terminal 的卷动纪录里还有它）。

## 5. 资料隐私设定（请你自己确认）

你的偏好、模板和每一张 ticket 的需求，都会送进 Claude 的模型。依官方文件（docs/verification.md 第 6 项）：Pro / Max 帐号如果开启「允许用资料改进模型」，资料会保留 5 年；关闭的话是 30 天。请到 <https://claude.ai/settings/data-privacy-controls> 确认这个设定是你想要的。

## 6. 使用条款（只引用原文，由你判断）

Vesper 用订阅的 token 以程序执行 `claude -p`。相关的条款原文整理在 docs/verification.md 第 6 项（Consumer Terms 第 3 节第 7 点、Claude Code 的 Legal and compliance 页、Authentication 页对 `setup-token` 用途的说明）。条款怎么适用于你的用法，请你自己阅读后判断。

## 7. token 的到期与撤销

- **一年后到期**：到期前重做第 3、4 步，然后 `sudo systemctl restart vesper-worker`。
- **怀疑外泄时**：到 claude.ai 的 **Settings → Claude Code**，找到这个 token 按删除（来源是 Anthropic 帮助中心的搜索摘录，docs/verification.md 第 3 项 🟡）。社群有人回报删除后旧 token 还能用一段时间，所以删除后跑一次 08 的自检，确认旧 token 已经失效；再重做第 3、4 步换成新的。
