'use client';

import { useEffect } from 'react';

/** Registers /sw.js (push notifications only; it caches nothing). */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      // Push is optional; the app works without it.
    });
  }, []);
  return null;
}
