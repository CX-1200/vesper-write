// `vesper` CLI commands (§11). They run as the vesper user at the VM terminal.
// Only `init` talks to the network (with the one-time setup token); approvals
// and revocations are VM-signed and queued for the running worker to deliver.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { b64urlEncode } from '@vesper/core/encoding';
import { assertValidPublicJwk } from '@vesper/core/keys';
import { computeFingerprint, lastGroup } from '@vesper/core/fingerprint';
import { approvalSigningString, revocationSigningString, signString } from '@vesper/core/sign';
import { formatLocal } from '@vesper/core/time';
import { isKnownTicketType, TICKET_TYPES } from '@vesper/core/ticket-types';
import { HttpError, NetworkError, registerVm } from "./api.js";
import { generateVmKeys, keysExist, loadVmKeys } from "./keystore.js";
import { readJson, writeFileAtomic } from "./fsutil.js";
import { ContentError, loadPreferences, loadTicketTypes, loadType } from "./content.js";
import { readLatch } from "./latch.js";
import { enqueueDeviceAction, listDeviceActions } from "./outbox.js";
import { loadRevoked, loadTrusted, trustDevice, untrustDevice } from "./trust.js";
export class CliError extends Error {
}
function showFingerprint(io, label, fp) {
    io.out(`  ${label}`);
    io.out(`      ${fp.split(' ').join('  ')}`);
}
// ---------------------------------------------------------------------------
export async function cmdInit(env) {
    const { io, paths: p } = env;
    let keys;
    let workerToken;
    if (keysExist(env.paths)) {
        if (!existsSync(p.pendingWorkerToken)) {
            throw new CliError('VM 已经有身份密钥，而且已登记过。若真的要重新产生（VM 指纹会改变，所有设备都必须重新配对），请先手动把 keys/ 目录移走再执行。');
        }
        io.out('找到上次未完成的登记，使用同一组密钥重试。');
        keys = await loadVmKeys(p);
        workerToken = readFileSync(p.pendingWorkerToken, 'utf8').trim();
    }
    else {
        keys = await generateVmKeys(p);
        workerToken = b64urlEncode(new Uint8Array(randomBytes(32)));
        writeFileAtomic(p.pendingWorkerToken, workerToken + '\n');
        io.out('已产生 VM 的签名密钥与加密密钥（keys/，权限 600）。');
    }
    const setupToken = (await io.ask('请输入你在 Vercel 设定的 SETUP_TOKEN（输入时不会显示）：', { hidden: true })).trim();
    if (setupToken.length < 32)
        throw new CliError('SETUP_TOKEN 太短（至少 32 个字符）。');
    let res;
    try {
        res = await registerVm({
            baseUrl: env.baseUrl,
            setupToken,
            workerToken,
            vmSignKey: keys.signPrivate,
            signPublicJwk: keys.signPublicJwk,
            encPublicJwk: keys.encPublicJwk,
            now: env.now,
            ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
        });
    }
    catch (e) {
        if (e instanceof NetworkError)
            throw new CliError('连不上 Vercel。请确认 /etc/vesper/worker.json 的 baseUrl，以及出站 proxy 允许这个网域。');
        if (e instanceof HttpError && e.status === 409)
            throw new CliError('Vercel 拒绝重新登记：已经有设备开始设置了。若要重来，需要先重置 Vercel 的数据库。');
        if (e instanceof HttpError)
            throw new CliError(`登记失败（HTTP ${e.status}）。请确认 SETUP_TOKEN 正确，且还没完成设置。`);
        throw e;
    }
    if (res.fingerprint !== keys.fingerprint) {
        throw new CliError('Vercel 回报的 VM 指纹和本机计算的不一致！不要继续设置，请检查网络与 Vercel 部署。');
    }
    io.out('');
    io.out('登记成功。这是 VM 的指纹，稍后要和设备屏幕上显示的「VM 指纹」逐位比对：');
    showFingerprint(io, 'VM 指纹', keys.fingerprint);
    io.out('');
    io.out('下一步（用有 sudo 权限的账号执行）：');
    io.out(`  1. sudo install -D -o root -g root -m 0600 ${p.pendingWorkerToken} /etc/vesper/worker-token`);
    io.out(`  2. sudo shred -u ${p.pendingWorkerToken}`);
    io.out('  3. 安装并启动 systemd 服务（vm-setup/08-worker-service.md）。');
    io.out('  4. 在手机上打开 PWA，进行首次设置（vm-setup/09-first-run.md）。');
}
export async function cmdFingerprint(env) {
    const keys = await loadVmKeys(env.paths);
    showFingerprint(env.io, 'VM 指纹', keys.fingerprint);
}
export async function cmdStatus(env) {
    const { io, paths: p } = env;
    const keys = await loadVmKeys(p);
    showFingerprint(io, 'VM 指纹', keys.fingerprint);
    const latch = readLatch(p);
    io.out(latch ? `本地锁：已上锁（${latch.reason}${latch.detail ? `: ${latch.detail}` : ''}，${formatLocal(latch.since)}）` : '本地锁：无');
    const status = readJson(p.status);
    io.out(status?.last_pull_ok ? `最后一次成功连接：${formatLocal(status.last_pull_ok)}（系统状态 ${status.state ?? '?'}）` : '最后一次成功连接：尚无纪录');
    io.out(`可信设备：${(await loadTrusted(p)).length} 台；已撤销：${loadRevoked(p).length} 台`);
    const pending = readJson(p.pendingDevices)?.devices ?? [];
    io.out(`待批准设备：${pending.length} 台`);
    io.out(`待送出的批准/撤销：${listDeviceActions(p).length} 笔`);
}
export async function cmdDeviceList(env) {
    const { io, paths: p } = env;
    const trusted = await loadTrusted(p);
    io.out('可信设备（trusted-devices.json）：');
    if (!trusted.length)
        io.out('  （无）');
    for (const d of trusted)
        io.out(`  ${d.id}  ${d.name}  批准于 ${formatLocal(d.approved_at)}\n      指纹 ${d.fingerprint}`);
    const revoked = loadRevoked(p);
    if (revoked.length) {
        io.out('已撤销：');
        for (const d of revoked)
            io.out(`  ${d.id}  ${d.name}  撤销于 ${formatLocal(d.revoked_at)}`);
    }
    const pending = readJson(p.pendingDevices)?.devices ?? [];
    if (pending.length) {
        io.out('待批准（来自 Vercel，指纹由本机重新计算）：');
        for (const d of pending) {
            const fp = await computeFingerprint(d.sign_public_key, d.enc_public_key).catch(() => '（公钥无效）');
            io.out(`  ${d.id}  ${d.name}  登记于 ${formatLocal(d.enrolled_at)}\n      指纹 ${fp}`);
        }
    }
}
export async function cmdDeviceApprove(env, wantedId) {
    const { io, paths: p } = env;
    const keys = await loadVmKeys(p);
    const cache = readJson(p.pendingDevices);
    const pending = cache?.devices ?? [];
    if (!pending.length) {
        io.out('目前没有待批准的设备。请确认 worker 正在运行（它每 30 秒更新一次清单），并且设备已经完成登记。');
        return false;
    }
    let d;
    if (wantedId)
        d = pending.find((x) => x.id === wantedId || x.id.startsWith(wantedId));
    else if (pending.length === 1)
        d = pending[0];
    else {
        pending.forEach((x, i) => io.out(`  [${i + 1}] ${x.name}  ${x.id}  登记于 ${formatLocal(x.enrolled_at)}`));
        const n = Number((await io.ask('要批准哪一台？输入编号：')).trim());
        d = pending[n - 1];
    }
    if (!d) {
        io.out('找不到这台设备。');
        return false;
    }
    // Never trust what Vercel says the fingerprint is: recompute from the keys.
    let sign, enc;
    try {
        sign = await assertValidPublicJwk(d.sign_public_key);
        enc = await assertValidPublicJwk(d.enc_public_key);
    }
    catch {
        io.out('这台设备的公钥格式无效，已拒绝。');
        return false;
    }
    const fp = await computeFingerprint(sign, enc);
    io.out('');
    io.out(`设备名称：${d.name}`);
    io.out(`设备 ID：${d.id}`);
    io.out(`登记时间：${formatLocal(d.enrolled_at)}`);
    showFingerprint(io, '设备指纹（由 VM 计算）', fp);
    io.out('');
    io.out('提醒：设备屏幕上显示的「VM 指纹」必须是：');
    showFingerprint(io, 'VM 指纹', keys.fingerprint);
    io.out('');
    const typed = (await io.ask('请看设备屏幕上的「本设备指纹」，输入它的最后一组 5 位数字：')).trim();
    if (typed !== lastGroup(fp)) {
        io.out('不一致，已取消。不要批准这台设备；如果你没有登记过它，可能有人在冒用（可执行 vesper device revoke 撤销它）。');
        return false;
    }
    const yes = (await io.ask('两边的指纹完全一致吗？确认批准请输入 yes：')).trim();
    if (yes !== 'yes') {
        io.out('已取消。');
        return false;
    }
    const approvedAt = env.now();
    await trustDevice(p, { id: d.id, name: d.name, sign_public_key: sign, enc_public_key: enc, approved_at: approvedAt });
    const sig = await signString(keys.signPrivate, approvalSigningString({ deviceId: d.id, fingerprint: fp, approvedAt }));
    enqueueDeviceAction(p, { action: 'approve', device_id: d.id, fingerprint: fp, approved_at: approvedAt, sig });
    io.out('已加入 trusted-devices.json。worker 会在 30 秒内通知 Vercel，设备上随后会显示「VM 已批准」。');
    return true;
}
export async function cmdDeviceRevoke(env, id) {
    const { io, paths: p } = env;
    if (!id)
        throw new CliError('用法：vesper device revoke <设备 ID>');
    const trusted = await loadTrusted(p);
    const match = trusted.find((x) => x.id === id) ?? trusted.find((x) => x.id.startsWith(id));
    const deviceId = match?.id ?? id;
    if (!/^[0-9a-f-]{36}$/.test(deviceId))
        throw new CliError('请输入完整的设备 ID（可用 vesper device list 查看）。');
    io.out(match ? `要撤销：${match.name}（${match.id}）` : `这台设备不在可信清单里（${deviceId}），仍会通知 Vercel 撤销它。`);
    const yes = (await io.ask('确认撤销请输入 yes：')).trim();
    if (yes !== 'yes') {
        io.out('已取消。');
        return false;
    }
    const keys = await loadVmKeys(p);
    const revokedAt = env.now();
    await untrustDevice(p, deviceId, revokedAt);
    const sig = await signString(keys.signPrivate, revocationSigningString({ deviceId, revokedAt }));
    enqueueDeviceAction(p, { action: 'revoke', device_id: deviceId, revoked_at: revokedAt, sig });
    io.out('已从 trusted-devices.json 移除；之后不会再为它加密任何内容。worker 会通知 Vercel 撤销它的会话。');
    return true;
}
export async function cmdLatch(env) {
    const latch = readLatch(env.paths);
    if (!latch) {
        env.io.out('本地锁：无');
        return;
    }
    env.io.out(`本地锁：已上锁（${latch.reason}${latch.detail ? `: ${latch.detail}` : ''}，${formatLocal(latch.since)}）`);
    env.io.out('v1 没有解锁指令（v2 会提供 vesper unlock：需要 break-glass key，并由 VM 签名）。');
    env.io.out('在 v1 测试期间如需解除，请看 vm-setup/README.md 的「v1 手动恢复」。');
}
const CONTENT_ERROR_LABEL = {
    content_missing: '找不到档案',
    content_too_large: '档案超过 64 KiB',
    bad_template_path: '模板路径不合法（必须是相对路径，而且不能跳出内容目录）',
    bad_ticket_types: 'ticket-types.json 格式不正确',
    unknown_type: 'ticket-types.json 里没有这个类型',
};
function contentError(e) {
    if (e instanceof ContentError)
        return `${CONTENT_ERROR_LABEL[e.code] ?? e.code}（${e.message}）`;
    return '无法读取';
}
/** Files other users could modify would let them inject instructions into every prompt. */
function writableByOthers(dir) {
    const out = [];
    const walk = (p) => {
        const st = statSync(p);
        if (st.mode & 0o022)
            out.push(p);
        if (st.isDirectory())
            for (const name of readdirSync(p))
                if (name !== '.git')
                    walk(join(p, name));
    };
    walk(dir);
    return out;
}
/** `vesper content check`: validates ~/vesper-content against the ticket types Vercel knows. */
export async function cmdContentCheck(env, contentDir) {
    const { io } = env;
    if (!existsSync(contentDir)) {
        io.out(`✗ 找不到内容目录 ${contentDir}`);
        return false;
    }
    let ok = true;
    let types;
    try {
        types = loadTicketTypes(contentDir);
    }
    catch (e) {
        io.out(`✗ ticket-types.json：${contentError(e)}`);
        return false;
    }
    try {
        io.out(`✓ preferences.md（${loadPreferences(contentDir).length} 个字符）`);
    }
    catch (e) {
        ok = false;
        io.out(`✗ preferences.md：${contentError(e)}`);
    }
    for (const t of TICKET_TYPES) {
        if (!types[t.key]) {
            ok = false;
            io.out(`✗ ${t.key}（${t.label}）：ticket-types.json 里没有这个类型，这类 ticket 都会失败`);
            continue;
        }
        try {
            const l = loadType(contentDir, t.key);
            io.out(`✓ ${t.key}（${t.label}）：模型 ${l.config.model}，模板 ${l.config.template}，上限 ${l.config.max_output_chars} 字符`);
        }
        catch (e) {
            ok = false;
            io.out(`✗ ${t.key}（${t.label}）：${contentError(e)}`);
        }
    }
    for (const key of Object.keys(types)) {
        if (!isKnownTicketType(key))
            io.out(`! ${key}：Vercel 上没有这个类型，永远不会被用到`);
    }
    const loose = writableByOthers(contentDir);
    if (loose.length) {
        ok = false;
        io.out(`✗ 这些档案或目录其他用户也能写入（可以借此改写你的 prompt）：${loose.join('、')}`);
        io.out(`  修正：chmod -R go-w ${contentDir}`);
    }
    io.out(ok ? '内容检查通过。' : '内容有问题，请修正后再执行一次 vesper content check。');
    return ok;
}
