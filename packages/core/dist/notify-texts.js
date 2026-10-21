// §13: push notifications may ONLY contain one of these fixed texts. The push
// payload carries a code and a count; the service worker maps it to text.
// web/public/sw.js has a copy of this table (a test keeps them in sync).
export const NOTIFY_KINDS = ['review', 'alert', 'locked', 'expired', 'stale', 'proposal'];
export function notifyText(kind, n = 1) {
    switch (kind) {
        case 'review':
            return `有 ${n} 个任务待审阅`;
        case 'alert':
            return '安全警报，请在另一台设备上查看';
        case 'locked':
            return 'Vesper 已封锁';
        case 'expired':
            return `有 ${n} 个任务已过期`;
        case 'stale':
            return `有 ${n} 个任务排队超时`;
        case 'proposal':
            return '有新的蒸馏提议';
    }
}
