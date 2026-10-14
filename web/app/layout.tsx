import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import { ServiceWorker } from './service-worker.tsx';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vesper',
  description: 'Prompt 秘书',
  applicationName: 'Vesper',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Vesper', statusBarStyle: 'default' },
  formatDetection: { telephone: false, email: false, address: false },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f6f3' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1115' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Render every page per request: the CSP nonce (proxy.ts) is new each time
  // and Next.js can only attach it to its scripts when rendering dynamically.
  await connection();
  return (
    <html lang="zh-CN">
      <body>
        <ServiceWorker />
        {children}
      </body>
    </html>
  );
}
