// Vesper service worker.
// Only shows fixed, content-free notifications (Build Spec §13). It has no
// fetch handler on purpose: nothing (and certainly no decrypted content) is
// ever cached by the service worker.

const TEXTS = {
  review: (n) => `有 ${n} 个任务待审阅`,
  alert: () => '安全警报，请在另一台设备上查看',
  locked: () => 'Vesper 已封锁',
  expired: (n) => `有 ${n} 个任务已过期`,
  stale: (n) => `有 ${n} 个任务排队超时`,
  proposal: () => '有新的蒸馏提议',
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // Unknown or malformed payloads fall back to the security-alert text.
  let kind = 'alert';
  let n = 1;
  try {
    const data = event.data ? event.data.json() : {};
    if (typeof data.k === 'string' && Object.prototype.hasOwnProperty.call(TEXTS, data.k)) kind = data.k;
    if (Number.isInteger(data.n) && data.n > 0 && data.n < 1000) n = data.n;
  } catch {
    // keep defaults
  }
  event.waitUntil(
    self.registration.showNotification('Vesper', {
      body: TEXTS[kind](n),
      tag: kind,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if ('focus' in w) return w.focus();
      }
      return self.clients.openWindow('/');
    })(),
  );
});
