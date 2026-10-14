// Local stand-in for D1 (dev and tests), using Node's built-in node:sqlite.
// Parameters are converted to strings exactly like the D1 REST API, so tests
// exercise the same type-affinity behavior as production.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { assertParams, type Db, type Statement, type StatementResult } from './types.ts';

const require = createRequire(import.meta.url);

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint };
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export class SqliteDb implements Db {
  readonly #db: SqliteDatabase;

  constructor(path = ':memory:') {
    // Loaded lazily so production bundles never touch node:sqlite.
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => SqliteDatabase };
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys = ON;');
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  applySchema(schemaPath: string | URL): void {
    this.#db.exec(readFileSync(schemaPath, 'utf8'));
  }

  close(): void {
    this.#db.close();
  }

  async batch(statements: Statement[]): Promise<StatementResult[]> {
    const out: StatementResult[] = [];
    for (const s of statements) {
      assertParams(s.params);
      const params = (s.params ?? []).map(String);
      const stmt = this.#db.prepare(s.sql);
      const returnsRows = /^\s*(select|with|pragma)\b/i.test(s.sql) || /\breturning\b/i.test(s.sql);
      if (returnsRows) {
        const rows = stmt.all(...params).map((r) => ({ ...r }));
        out.push({ rows, changes: /^\s*select\b/i.test(s.sql) ? 0 : rows.length });
      } else {
        const r = stmt.run(...params);
        out.push({ rows: [], changes: Number(r.changes) });
      }
    }
    return out;
  }
}
