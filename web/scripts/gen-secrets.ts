// Generates the server-side secrets for Vercel WITHOUT printing them.
//
//   node scripts/gen-secrets.ts <new-directory-outside-this-repo>
//
// Writes one file per environment variable (directory 700, files 600):
//   SETUP_TOKEN        one-time token for first setup (§11.1); delete it from Vercel after setup
//   TOTP_ENC_KEY       32-byte key that encrypts the TOTP secret at rest
//   VAPID_PUBLIC_KEY   Web Push application server key (public)
//   VAPID_PRIVATE_KEY  Web Push signing key
// Paste each file's content into Vercel → Settings → Environment Variables
// (mark them Sensitive), and type SETUP_TOKEN into `vesper init` on the VM.
// Then delete the directory (e.g. `shred -u <dir>/* && rmdir <dir>`).

import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const b64url = (b: Buffer) => b.toString('base64url');

function main(): void {
  const target = process.argv[2];
  if (!target) throw new Error('usage: node scripts/gen-secrets.ts <new-directory-outside-this-repo>');
  const dir = resolve(target);
  const repo = resolve(import.meta.dirname, '..', '..');
  if (dir === repo || dir.startsWith(repo + sep)) throw new Error('refusing to write secrets inside the git repository');
  if (existsSync(dir) && readdirSync(dir).length) throw new Error('target directory is not empty');
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const priv = ecdh.getPrivateKey();
  const values: Record<string, string> = {
    SETUP_TOKEN: b64url(randomBytes(32)),
    TOTP_ENC_KEY: b64url(randomBytes(32)),
    VAPID_PUBLIC_KEY: b64url(ecdh.getPublicKey()),
    VAPID_PRIVATE_KEY: b64url(Buffer.concat([Buffer.alloc(32 - priv.length), priv])),
  };
  for (const [name, value] of Object.entries(values)) {
    writeFileSync(join(dir, name), value, { mode: 0o600, flag: 'wx' });
    console.log(`wrote ${join(dir, name)} (${value.length} characters)`);
  }
  console.log('Values were not printed. Copy each one into Vercel as a Sensitive environment variable, then delete the directory.');
}

try {
  main();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
