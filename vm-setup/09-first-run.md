# 09 · 第一次配对与 v1 验收

目标：在手机上完成首次设置、和 VM 互相确认指纹，然后逐条做 Build Spec §19 的 v1 验收。

## 1. 在 iPhone 上安装 PWA

1. 用 **Safari** 打开你的 Vercel 网址。
2. 按「分享」→「**添加到主屏幕**」。
3. **之后都从主屏幕的 Vesper 图示打开**，不要在 Safari 里设置。主屏幕 App 和 Safari 的存储是分开的；在 Safari 里产生的密钥，主屏幕 App 用不到（docs/verification.md 第 8 项：主屏幕 App 也不受 Safari 7 天清除规则影响）。

## 2. 首次设置（手机）

从主屏幕打开 Vesper →「首次设置」：

1. **Setup token**：根目录 README 用 `gen-secrets` 产生的那一组。在手机上输入的方法：用电脑和手机都有的密码管理器暂存，设置完成后删除；或直接照着打。
2. **设备名称**、**登录密码**（至少 12 个字符）。
3. 这台手机会产生两把**不可导出**的密钥，存进 IndexedDB 之后立刻自我测试（重新读出、签名、加解密各一次）。失败的话不会继续。
4. **TOTP**：在**另一台设备**的验证器 App 新增帐号，手动输入画面上的密钥，再输入 6 位数确认。（OD2 提醒：TOTP 不要放在这支手机上，手机遗失时密码和 TOTP 才不会一起落入别人手里。）

## 3. 互相确认指纹（手机 + VM）

**第一步：手机确认 VM。** 手机会显示「这台设备收到的 VM 指纹」。在 VM 上：

```bash
sudo -u vesper -i vesper fingerprint
```

6 组数字要**完全一致**才勾选「一致」。不一致就按「不一致」，停下来：代表手机收到的 VM 公钥不是你 VM 上的那一把。

**第二步：VM 确认手机。** 手机显示「本设备指纹」，最后一组加了底线。在 VM 上：

```bash
sudo -u vesper -i vesper device approve
```

终端会显示**由 VM 自己计算**的设备指纹。逐组比对手机画面，一致的话输入最后一组数字，再输入 `yes`。如果显示「目前没有待批准的设备」，等 30 秒（worker 每 30 秒更新一次）再执行。

批准后 30 秒内，手机会自动进入下一步。手机会用配对时保存的 VM 公钥验证这个批准的签名；之后它**只**信任这把公钥，不会再从 Vercel 取用。

## 4. 三组备用 secret（手机）

画面会显示三组，各只显示这一次：

| | 用途 | 建议存放 |
|---|---|---|
| Recovery key | 登记新设备（单次有效） | 密码管理器 |
| Break-glass key | v2：在 VM 终端解锁 | 纸本，离线保存 |
| Kill token | 紧急时在任何浏览器打开 `/kill` 封锁系统 | 紧急时拿得到的地方（例如密码管理器 + 纸本） |

输入每组的最后 4 个字符确认后，按「完成设置」。服务器只存它们的哈希（argon2id），setup token 同时失效。

## 5. 设置完成后

1. **到 Vercel 删除 `SETUP_TOKEN` 环境变量**，然后重新部署（它已经失效，删掉更干净）。
2. 手机「设置」→「开启推送」（iOS 需要从主屏幕打开才看得到这个选项）。
3. （可选）「设置」→「登记 passkey」。
4. 记下紧急封锁网址：`https://<你的 Vercel 网域>/kill`。

## 6. v1 验收（Build Spec §19）

做完一项打一个勾。需要直接操作数据库的项目，在 Cloudflare 仪表板这个 D1 数据库的 Console 页面执行（选单名称以 Cloudflare 画面为准）。**第 4、7 项会让系统上锁**，做完要照 [README.md 的「v1 手动恢复」](README.md#v1-手动恢复kill-switchlockdown-或-vm-本地锁之后) 恢复。

### ☐ 1. 听写开 ticket、一分钟内收到推送、Apple Watch 也有通知

电脑开着时，在手机「新需求」用键盘的麦克风听写，送出。一分钟内应该收到「有 1 个任务待审阅」。Apple Watch 会不会跟着通知，官方文件没有写（docs/verification.md 第 9 项「我不确定」），请实测并记下结果。

### ☐ 2. 审阅页同时显示原始需求、prompt 和 lint 标记，可以一键复制

点开通知或首页的任务：上面是原始需求，下面是 prompt，命中的片段标红并显示规则编号（例如 L4）。`claude_code` 的任务顶部固定显示「这段 prompt 会在有 shell 权限的环境执行」；有高严重度标记时，复制要再确认一次。

### ☐ 3. 数据库里只看得到密文和元数据

```sql
SELECT id, type, target, status, substr(input_envelope, 1, 60) AS input, substr(output_envelopes, 1, 60) AS output
  FROM tickets ORDER BY created_at DESC LIMIT 5;
```

`input` 和 `output` 只会是 `{"v":1,"alg":"HPKE-…","enc":"…","ct":"…"}` 这类密文封包，找不到你写的任何一个字。

### ☐ 4. 伪造的 ticket：VM 拒绝处理、本地上锁、所有设备收到警报

把最新一张 ticket 的密文和签名复制到一个新的 id（签名涵盖 id，所以一定对不上）：

```sql
INSERT INTO tickets (id, type, target, device_id, input_envelope, input_sig, input_nonce, input_ts, status, attempts, created_at, stale_at)
SELECT '00000000-0000-4000-8000-000000000001', type, target, device_id, input_envelope, input_sig, input_nonce, input_ts,
       'pending', 0, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000 + 259200000
  FROM tickets ORDER BY created_at DESC LIMIT 1;
```

30 秒内：手机收到「安全警报」，首页显示 R8；`sudo -u vesper -i vesper status` 显示本地锁（原因 `r8: bad_device_signature`）；`journalctl -u vesper-worker` 没有呼叫 Claude Code 的纪录。这张假 ticket 会被标成 `failed`（`vm_rejected`）。做完照「v1 手动恢复」解锁。

### ☐ 5. 改动已写回的输出：设备验签失败、不显示内容

找一张「待审阅」任务的 id（审阅页网址最后一段），把它密文的第一个字元换掉：

```sql
UPDATE tickets
   SET output_envelopes = substr(output_envelopes, 1, instr(output_envelopes, '"ct":"') + 5)
       || CASE substr(output_envelopes, instr(output_envelopes, '"ct":"') + 6, 1) WHEN 'A' THEN 'B' ELSE 'A' END
       || substr(output_envelopes, instr(output_envelopes, '"ct":"') + 7)
 WHERE id = '<任务 id>';
```

再打开那张任务：应该显示「VM 签名验证失败……内容不会显示」，所有设备收到安全警报（规则 tamper）。

### ☐ 6. 没注册的设备尝试登录：被拒绝、所有设备收到警报

1. 在电脑的浏览器用 recovery key 登记一台新设备（会触发 R2 警报，这是正常的），在 VM 上批准，并照画面换一组新的 recovery key。
2. 在手机「设备」页撤销它，并在 VM 执行画面显示的 `vesper device revoke <id>`。
3. 回到那个电脑浏览器，用密码 + TOTP 登录：应该被拒绝，手机收到安全警报（R1）。

### ☐ 7. kill switch：worker 下次拉取后本地上锁；数据库改回 NORMAL 也不恢复

1. 任何浏览器打开 `/kill`，输入 kill token，确认。
2. 30 秒内：`sudo -u vesper -i vesper status` 显示本地锁（`server_killed`）。
3. 只把数据库改回 NORMAL（README「v1 手动恢复」第 2 步），**不要**删本地锁。重新登录、开一张新 ticket：它会一直停在「排队中」，worker 日志只有心跳。
4. 做完照「v1 手动恢复」第 3、4 步完成恢复（包括换一组新的 kill token）。

### ☐ 8. 电脑关机时开的 ticket，开机后会被处理；超过 OD7（72 小时）变成 stale

1. 把 VM 关机（或 `sudo systemctl stop vesper-worker`），在手机开一张 ticket。首页 VM 显示「离线」。
2. 开机（或 `start`）：一分钟内收到推送，ticket 被处理。
3. stale：再停一次 worker、开一张 ticket，然后在数据库把它的期限改到过去（模拟等了 72 小时）：

   ```sql
   UPDATE tickets SET stale_at = 0 WHERE status = 'pending';
   ```

   重新整理手机首页：它变成「排队超时」；每天第一次打开时，首页会提醒你有任务排队超时。

### ☐ 9. §18 安全需求清单

逐条看 [docs/security-checklist.md](../docs/security-checklist.md)，把需要你在 VM 或 Vercel 上确认的项目打勾（包括第 08 页的 `systemd-analyze security` 分数）。

## 7. 拍快照

全部通过后，拍一张「v1 基准」快照（01 第 6 节）。
