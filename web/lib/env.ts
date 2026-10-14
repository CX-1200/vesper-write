// Server-side configuration. Secrets come only from environment variables
// (on Vercel: Sensitive env vars). Error messages name the variable, never
// its value. None of them is exposed to the browser: Next's public-env
// prefix is never used (§18).

import { b64urlDecode } from '@vesper/core/encoding';

export type DbConfig =
  | { driver: 'd1'; accountId: string; databaseId: string; apiToken: string; mode: 'batch' | 'sequential' }
  | { driver: 'sqlite'; path: string };

export interface Env {
  appOrigin: string;
  rpId: string;
  setupToken: string | null;
  totpEncKey: Uint8Array;
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  db: DbConfig;
  trustProxyHeaders: boolean;
  isProduction: boolean;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

type Source = Record<string, string | undefined>;

function required(src: Source, name: string): string {
  const v = src[name];
  if (!v) throw new EnvError(`missing environment variable ${name}`);
  return v;
}

export function loadEnv(src: Source = process.env): Env {
  const appOrigin = required(src, 'APP_ORIGIN').replace(/\/$/, '');
  let origin: URL;
  try {
    origin = new URL(appOrigin);
  } catch {
    throw new EnvError('APP_ORIGIN must be an absolute URL');
  }
  const isProduction = src.NODE_ENV === 'production';
  if (isProduction && origin.protocol !== 'https:' && origin.hostname !== 'localhost') {
    throw new EnvError('APP_ORIGIN must use https in production');
  }

  let totpEncKey: Uint8Array;
  try {
    totpEncKey = b64urlDecode(required(src, 'TOTP_ENC_KEY'));
  } catch (e) {
    if (e instanceof EnvError) throw e;
    throw new EnvError('TOTP_ENC_KEY must be base64url');
  }
  if (totpEncKey.length !== 32) throw new EnvError('TOTP_ENC_KEY must decode to 32 bytes');

  const setupToken = src.SETUP_TOKEN ? src.SETUP_TOKEN : null;
  if (setupToken !== null && setupToken.length < 32) throw new EnvError('SETUP_TOKEN must be at least 32 characters');

  const vapid =
    src.VAPID_PUBLIC_KEY && src.VAPID_PRIVATE_KEY
      ? { publicKey: src.VAPID_PUBLIC_KEY, privateKey: src.VAPID_PRIVATE_KEY, subject: src.VAPID_SUBJECT || 'mailto:owner@localhost' }
      : null;

  const driver = src.DB_DRIVER ?? 'd1';
  let db: DbConfig;
  if (driver === 'd1') {
    db = {
      driver: 'd1',
      accountId: required(src, 'D1_ACCOUNT_ID'),
      databaseId: required(src, 'D1_DATABASE_ID'),
      apiToken: required(src, 'D1_API_TOKEN'),
      mode: src.D1_BATCH_MODE === 'sequential' ? 'sequential' : 'batch',
    };
  } else if (driver === 'sqlite') {
    if (isProduction && src.ALLOW_SQLITE_IN_PRODUCTION !== '1') throw new EnvError('DB_DRIVER=sqlite is for local development only');
    db = { driver: 'sqlite', path: src.SQLITE_PATH || '.data/vesper.sqlite' };
  } else {
    throw new EnvError('DB_DRIVER must be d1 or sqlite');
  }

  return {
    appOrigin: origin.origin,
    rpId: src.RP_ID || origin.hostname,
    setupToken,
    totpEncKey,
    vapid,
    db,
    trustProxyHeaders: src.TRUST_PROXY_HEADERS !== '0',
    isProduction,
  };
}
