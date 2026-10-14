// Creates the Vesper tables (idempotent: every statement is IF NOT EXISTS /
// OR IGNORE, so running it again is safe).
//
//   Cloudflare D1 (production):
//     export D1_ACCOUNT_ID=…  D1_DATABASE_ID=…
//     node scripts/migrate.ts            # asks for the D1 API token, input hidden
//   Local SQLite (development):
//     DB_DRIVER=sqlite SQLITE_PATH=.data/vesper.sqlite node scripts/migrate.ts
//
// The token is only sent to api.cloudflare.com and is never printed.

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { D1RestDb } from '../lib/db/d1.ts';
import { SqliteDb } from '../lib/db/sqlite.ts';
import { splitSql } from '../lib/db/split-sql.ts';
import { askHidden } from './tty.ts';

const schemaUrl = new URL('../lib/db/schema.sql', import.meta.url);

async function main(): Promise<void> {
  const driver = process.env.DB_DRIVER ?? 'd1';
  if (driver === 'sqlite') {
    const path = process.env.SQLITE_PATH || '.data/vesper.sqlite';
    mkdirSync(dirname(path), { recursive: true });
    const db = new SqliteDb(path);
    db.applySchema(schemaUrl);
    db.close();
    console.log(`SQLite schema applied: ${path}`);
    return;
  }
  if (driver !== 'd1') throw new Error('DB_DRIVER must be d1 or sqlite');
  const accountId = process.env.D1_ACCOUNT_ID ?? '';
  const databaseId = process.env.D1_DATABASE_ID ?? '';
  if (!accountId || !databaseId) throw new Error('set D1_ACCOUNT_ID and D1_DATABASE_ID first');
  const apiToken = process.env.D1_API_TOKEN || (await askHidden('D1 API token（输入时不会显示）：')).trim();
  const db = new D1RestDb({ accountId, databaseId, apiToken, mode: 'sequential' });
  const statements = splitSql(readFileSync(schemaUrl, 'utf8'));
  for (const [i, sql] of statements.entries()) {
    await db.batch([{ sql }]);
    console.log(`[${i + 1}/${statements.length}] ${sql.slice(0, 60)}${sql.length > 60 ? '…' : ''}`);
  }
  const tables = await db.batch([{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name" }]);
  console.log(`D1 schema applied. Tables: ${tables[0]!.rows.map((r) => r.name).join(', ')}`);
}

main().catch((e: Error) => {
  console.error(`migrate failed: ${e.message}`);
  process.exit(1);
});
