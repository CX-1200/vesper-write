// Chinese display labels. Unknown keys fall back to the raw identifier.

import { TICKET_TYPES } from '../lib/ticket-types.ts';

export const EVENT_LABEL: Record<string, string> = {
  'auth.login': '登录成功',
  'auth.logout': '登出',
  'auth.passkey_registered': '登记 passkey',
  'auth.fail.password': '登录失败：密码错误',
  'auth.fail.totp': '验证失败：TOTP 错误',
  'auth.fail.passkey': '登录失败：passkey',
  'auth.fail.passkey_counter': '登录失败：passkey 计数异常',
  'auth.fail.unknown_device': '登录失败：未注册或已撤销的设备',
  'auth.fail.revoked_device': '请求被拒：设备已撤销',
  'auth.fail.signature': '请求被拒：设备签名无效',
  'auth.fail.bad_signature': '请求被拒：签名无效',
  'auth.fail.stale': '请求被拒：时间戳过期',
  'auth.fail.replay': '请求被拒：重放的请求',
  'auth.fail.setup_token': '设置失败：setup token 错误',
  'auth.fail.recovery_key': '登记失败：recovery key 错误',
  'auth.fail.kill_token': 'kill switch 失败：token 错误',
  'auth.fail.worker_token': 'worker 请求被拒：token 错误',
  'auth.fail.vm_signature': 'worker 请求被拒：VM 签名无效',
  'setup.begin': '开始首次设置',
  'setup.totp_confirmed': 'TOTP 已确认',
  'setup.complete': '首次设置完成',
  'device.enroll': '登记设备',
  'device.vm_approve': 'VM 批准设备',
  'device.revoke': '撤销设备',
  'device.rename': '更改设备名称',
  'device.remove': '移除已撤销的设备',
  'vm.register': 'VM 登记',
  'vm.r8': 'VM 拒绝处理（R8）',
  'ticket.create': '开 ticket',
  'ticket.status': 'ticket 状态变化',
  'ticket.output_signature_invalid': '输出签名验证失败',
  'lint.high': 'lint 高严重度命中',
  'lint.vm_device_mismatch': 'VM 与设备的 lint 结果不一致',
  'rule.triggered': '侦测规则触发',
  'system.state': '系统状态变化',
  kill_switch: 'kill switch',
  'push.subscribe': '登记推送',
  'secrets.rotate': '更换 secret',
};

export function eventLabel(event: string): string {
  return EVENT_LABEL[event] ?? event;
}

export const RESULT_LABEL: Record<string, string> = { ok: '成功', fail: '失败', info: '信息' };

export const RULE_LABEL: Record<string, string> = {
  R1: '未注册或已撤销的设备尝试登录',
  R2: '有人申请登记新设备',
  R3: '认证失败太多次，来源已封锁 15 分钟',
  R4: 'IP 国家改变',
  R5: '非活跃时段操作',
  R6: '短时间内开太多 ticket',
  R7: 'worker 请求的 VM 签名无效（已封锁）',
  R7_ip: 'worker 的 IP 改变',
  R8: 'VM 发现无效签名、不可信设备或解密失败（VM 已本地上锁）',
  kill: 'kill switch 已按下',
  tamper: '数据被改动（签名不符）',
};

export const ALERT_REASON_LABEL: Record<string, string> = {
  unregistered_device: '未注册的设备',
  bad_device_signature: '设备签名无效',
  enroll_start: '登记新设备',
  invalid_vm_signature: 'VM 签名无效',
  worker_ip_changed: 'worker IP 改变',
  kill_switch: 'kill switch',
  output_signature_invalid: '输出的 VM 签名无效',
  approval_fingerprint_mismatch: '批准的指纹不符',
  untrusted_device: 'ticket 来自不在可信清单里的设备',
  malformed_ticket: 'ticket 格式异常',
  ticket_too_old: 'ticket 时间戳过旧',
  decrypt_failed: 'ticket 无法解密',
};

export const TICKET_ERROR_LABEL: Record<string, string> = {
  claude_timeout: 'Claude Code 超时',
  claude_exit: 'Claude Code 异常结束',
  claude_spawn: '无法启动 Claude Code',
  claude_error: 'Claude Code 回报错误',
  claude_bad_output: 'Claude Code 输出格式异常',
  claude_empty: 'Claude Code 没有输出',
  content_missing: '找不到模板或偏好文件',
  content_too_large: '模板或偏好文件太大',
  bad_ticket_types: 'ticket-types.json 设定错误',
  bad_template_path: '模板路径不合法',
  unknown_type: 'VM 上没有这个 ticket 类型',
  device_revoked: '设备已撤销',
  vm_rejected: 'VM 拒绝处理（签名无效或设备不可信，R8）',
  lease_timeout: '处理超时（worker 没有回报）',
  worker_not_processing: 'worker 未处理',
  worker_error: 'worker 错误',
};

export const STATE_LABEL: Record<string, string> = {
  NORMAL: '正常',
  SUSPICIOUS: '可疑',
  LOCKDOWN: '已封锁',
  KILLED: '已封锁（kill switch）',
};

export const TARGET_LABEL: Record<string, string> = {
  claude_ai: 'Claude.ai',
  claude_code: 'Claude Code',
};

const TYPE_LABEL: Record<string, string> = Object.fromEntries(TICKET_TYPES.map((t) => [t.key, t.label]));

export function typeLabel(key: string): string {
  return TYPE_LABEL[key] ?? key;
}
