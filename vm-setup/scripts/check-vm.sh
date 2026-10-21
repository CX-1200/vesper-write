#!/usr/bin/env bash
# vm-setup/scripts/check-vm.sh — READ-ONLY checks of the Vesper VM hardening.
#
#   sudo bash /opt/vesper/vm-setup/scripts/check-vm.sh
#
# It changes nothing: it only reads configuration, file permissions and service
# state, and makes a few test connections as the vesper user (to see that the
# firewall and the proxy allowlist work). It never prints any secret: token
# files are only checked for owner and permissions.

set -u
PASS=0
FAIL=0
SKIP=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
skip() { printf '  \033[33mSKIP\033[0m %s\n' "$1"; SKIP=$((SKIP + 1)); }
section() { printf '\n== %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 执行：sudo bash $0" >&2
  exit 2
fi

perm_is() { # path owner:group mode
  [ -e "$1" ] || return 1
  [ "$(stat -c '%U:%G %a' "$1")" = "$2 $3" ]
}

section "02 · Ubuntu"
if [ -f /etc/apt/apt.conf.d/20auto-upgrades ] && grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then
  pass "unattended-upgrades 已启用"
else
  fail "unattended-upgrades 没有启用（02 第 3 节）"
fi
if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then pass "时间已同步（NTP）"; else fail "时间没有同步（02 第 4 节）"; fi
if id vesper >/dev/null 2>&1; then
  pass "vesper 用户存在"
  if id -nG vesper | tr ' ' '\n' | grep -qxE 'sudo|admin|wheel'; then fail "vesper 在 sudo/admin 群组里"; else pass "vesper 没有 sudo 权限"; fi
  if passwd -S vesper 2>/dev/null | awk '{print $2}' | grep -qx L; then pass "vesper 的密码已锁"; else fail "vesper 的密码没有锁（sudo passwd -l vesper）"; fi
  if [ "$(stat -c '%a' /home/vesper 2>/dev/null)" = "700" ]; then pass "/home/vesper 权限 700"; else fail "/home/vesper 不是 700（sudo chmod 700 /home/vesper）"; fi
else
  fail "没有 vesper 用户（02 第 5 节）"
fi
if [ -d /opt/vesper ]; then
  OWNER_BAD=$(find /opt/vesper -path /opt/vesper/.git -prune -o ! -user root -print -quit 2>/dev/null)
  WRITE_BAD=$(find /opt/vesper -path /opt/vesper/.git -prune -o ! -type l -perm /022 -print -quit 2>/dev/null)
  if [ -z "$OWNER_BAD" ] && [ -z "$WRITE_BAD" ]; then
    pass "/opt/vesper 由 root 拥有，其他人不能写入"
  else
    [ -n "$OWNER_BAD" ] && fail "/opt/vesper 里有不属于 root 的档案，例如：$OWNER_BAD"
    [ -n "$WRITE_BAD" ] && fail "/opt/vesper 里有 group/other 可写入的档案，例如：$WRITE_BAD"
  fi
else
  skip "/opt/vesper 还不存在（02 第 7 节）"
fi

section "03 · SSH"
if have sshd; then
  # sshd -T fails (empty output) when /run/sshd does not exist yet, e.g. with
  # socket activation before the first connection. Report that instead of
  # five misleading FAILs.
  # Normalise: some OpenSSH builds print keywords in mixed case (PermitRootLogin)
  # rather than lowercase, and lines may carry trailing whitespace.
  T=$(sshd -T 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed 's/[[:space:]]*$//')
  if [ -z "$T" ]; then
    skip "sshd -T 无法执行：$(sshd -T 2>&1 >/dev/null | head -1)（手动执行 sudo sshd -T 看原因）"
  else
  echo "$T" | grep -qE '^passwordauthentication[[:space:]]+no$' && pass "不接受密码登录" || fail "仍接受密码登录"
  echo "$T" | grep -qE '^kbdinteractiveauthentication[[:space:]]+no$' && pass "不接受 keyboard-interactive" || fail "仍接受 keyboard-interactive"
  echo "$T" | grep -qE '^permitrootlogin[[:space:]]+no$' && pass "root 不能登录" || fail "root 可以登录"
  AU=$(echo "$T" | grep -E '^allowusers[[:space:]]' | sed -E 's/^allowusers[[:space:]]+//')
  if [ -n "$AU" ]; then
    if echo "$AU" | grep -q '<'; then fail "AllowUsers 还是占位符（03 第 5 节）"; elif echo "$AU" | grep -qw vesper; then fail "AllowUsers 包含 vesper"; else pass "AllowUsers：$AU"; fi
  else
    fail "没有设定 AllowUsers"
  fi
  echo "$T" | grep -qE '^allowtcpforwarding[[:space:]]+no$' && pass "不允许 TCP 转发" || fail "允许 TCP 转发"
  fi
else
  skip "没有安装 sshd"
fi

section "04 · squid"
if systemctl is-active --quiet squid; then
  pass "squid 正在运行"
  LISTEN=$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep ':3128$' | sort -u | tr '\n' ' ')
  if [ "$LISTEN" = "127.0.0.1:3128 " ]; then pass "squid 只监听 127.0.0.1:3128"; else fail "squid 监听位址：${LISTEN:-无}（应该只有 127.0.0.1:3128）"; fi
  grep -qE '^http_access deny all' /etc/squid/squid.conf && pass "squid.conf 以 deny all 结尾" || fail "squid.conf 没有 http_access deny all"
  if grep -q '<your-vercel-domain>' /etc/squid/squid.conf; then fail "squid.conf 还没填入 Vercel 网域"; fi
else
  fail "squid 没有在运行（04）"
fi

section "05 · nftables"
if systemctl is-active --quiet ufw && ufw status 2>/dev/null | grep -q 'Status: active'; then fail "ufw 还在运作（05 第 1 节）"; else pass "ufw 没有在运作"; fi
if nft list table inet vesper >/dev/null 2>&1; then
  R=$(nft list table inet vesper)
  echo "$R" | grep -q 'hook input priority filter; policy drop' && pass "入站默认拒绝" || fail "入站不是默认拒绝"
  echo "$R" | grep -qE 'skuid .*3128 accept' && pass "vesper 只允许连 127.0.0.1:3128" || fail "没有 vesper 的出站规则"
  systemctl is-enabled --quiet nftables && pass "nftables 开机自动载入" || fail "nftables 没有设为开机启动"
  grep -q '<host-vmnet8-ip>' /etc/nftables.conf 2>/dev/null && fail "/etc/nftables.conf 还没填入主机位址"
else
  fail "没有 inet vesper 规则表（05）"
fi

section "出站测试（以 vesper 身分）"
if id vesper >/dev/null 2>&1 && have curl; then
  if runuser -u vesper -- env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy curl -sS -o /dev/null --max-time 8 https://example.com/ 2>/dev/null; then
    fail "vesper 可以不经 proxy 直接连外"
  else
    pass "vesper 不能直接连外"
  fi
  CODE=$(runuser -u vesper -- curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --proxy http://127.0.0.1:3128 https://api.anthropic.com/ 2>/dev/null)
  case "$CODE" in [1-5][0-9][0-9]) pass "经由 proxy 可以连 api.anthropic.com（HTTP $CODE）" ;; *) fail "经由 proxy 连不到 api.anthropic.com" ;; esac
  if runuser -u vesper -- curl -sS -o /dev/null --max-time 8 --proxy http://127.0.0.1:3128 https://example.com/ 2>/dev/null; then
    fail "白名单外的网域（example.com）竟然连得到"
  else
    pass "白名单外的网域被拒绝"
  fi
else
  skip "缺少 vesper 用户或 curl"
fi

section "06 · Claude Code"
if have claude; then
  V=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ -n "$V" ] && [ "$(printf '%s\n%s\n' "2.1.293" "$V" | sort -V | head -1)" = "2.1.293" ]; then pass "Claude Code $V（≥ 2.1.293）"; else fail "Claude Code 版本 ${V:-未知}，Haiku 5.5 需要 ≥ 2.1.293（06 第 2 节）"; fi
else
  fail "没有安装 Claude Code（06）"
fi
if perm_is /etc/vesper/claude-oauth-token root:root 600; then pass "claude-oauth-token：root、600"; elif [ -e /etc/vesper/claude-oauth-token ]; then fail "claude-oauth-token 的拥有者或权限不对（应为 root root 600）"; else skip "还没有 /etc/vesper/claude-oauth-token（06 第 4 节）"; fi

section "07 · worker"
if perm_is /etc/vesper/worker-token root:root 600; then pass "worker-token：root、600"; elif [ -e /etc/vesper/worker-token ]; then fail "worker-token 的拥有者或权限不对"; else skip "还没有 /etc/vesper/worker-token（07 第 8 节）"; fi
if [ -e /home/vesper/.local/share/vesper/keys/worker-token.pending ]; then fail "worker-token.pending 还留在 vesper 的目录（07 第 8 节：install 后 shred）"; fi
if perm_is /etc/vesper/worker.json root:root 644; then
  pass "worker.json：root、644"
  grep -q 'YOUR-PROJECT' /etc/vesper/worker.json && fail "worker.json 还没填入 baseUrl"
else
  skip "还没有 /etc/vesper/worker.json（07 第 4 节）"
fi
D=/home/vesper/.local/share/vesper
if [ -d "$D/keys" ]; then
  [ "$(stat -c '%a' "$D")" = 700 ] && pass "资料目录权限 700" || fail "$D 不是 700"
  BAD=$(find "$D/keys" -type f ! -perm 600 -print 2>/dev/null | head -3)
  [ -z "$BAD" ] && pass "VM 私钥档案都是 600" || fail "这些档案不是 600：$BAD"
else
  skip "还没有执行 vesper init（07 第 7 节）"
fi
C=/home/vesper/vesper-content
if [ -d "$C/.git" ]; then
  [ -z "$(git -C "$C" -c safe.directory="$C" remote 2>/dev/null)" ] && pass "vesper-content 没有任何 remote" || fail "vesper-content 设了 remote（不可以推送到任何地方）"
  [ -x "$C/.git/hooks/pre-push" ] && pass "pre-push 防呆 hook 存在" || fail "没有 pre-push hook（07 第 6 节）"
  if [ -x /usr/local/bin/vesper ]; then
    if runuser -u vesper -- /usr/local/bin/vesper content check >/dev/null 2>&1; then pass "vesper content check 通过"; else fail "vesper content check 没有通过（以 vesper 身分执行看细节）"; fi
  fi
else
  skip "还没有建立 ~/vesper-content（07 第 6 节）"
fi

section "08 · 服务"
if systemctl cat vesper-worker >/dev/null 2>&1; then
  systemctl is-enabled --quiet vesper-worker && pass "vesper-worker 开机启动" || fail "vesper-worker 没有 enable"
  systemctl is-active --quiet vesper-worker && pass "vesper-worker 正在运行" || fail "vesper-worker 没有在运行"
  SCORE=$(systemd-analyze security vesper-worker 2>/dev/null | grep -oE 'Overall exposure level for vesper-worker.service: [0-9.]+' | grep -oE '[0-9.]+$')
  if [ -n "$SCORE" ]; then
    if awk -v s="$SCORE" 'BEGIN { exit !(s < 2.0) }'; then pass "systemd-analyze security 分数 $SCORE（请填进 docs/security-checklist.md）"; else fail "systemd-analyze security 分数 $SCORE（预期 < 2.0）"; fi
  fi
  if [ -e "$D/state/latch" ]; then fail "本地锁存在：worker 不会处理任何 ticket（sudo -u vesper -i vesper status）"; else pass "没有本地锁"; fi
else
  skip "还没有安装 vesper-worker.service（08）"
fi

printf '\n结果：%d PASS，%d FAIL，%d SKIP\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
