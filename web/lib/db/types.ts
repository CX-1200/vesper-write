// Database abstraction. Production: Cloudflare D1 over its REST API (OD1).
// Local dev and tests: node:sqlite, deliberately restricted to the same rules.
//
// Rules every query in this codebase follows:
//  - parameters are strings or numbers only, and are SENT AS STRINGS
//    (the D1 REST API types `params` as an array of strings);
//  - NULL is never a parameter: SQL text writes NULL literally;
//  - anything that must be atomic is a single SQL statement.

export type Param = string | number;

export interface Statement {
  sql: string;
  params?: Param[];
}

export interface StatementResult<T = Row> {
  rows: T[];
  changes: number;
}

export type Row = Record<string, unknown>;

export interface Db {
  /** Run several statements in one round trip. Not guaranteed to be a transaction. */
  batch(statements: Statement[]): Promise<StatementResult[]>;
}

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbError';
  }
}

export async function all<T = Row>(db: Db, sql: string, params: Param[] = []): Promise<T[]> {
  const [r] = await db.batch([{ sql, params }]);
  return (r?.rows ?? []) as T[];
}

export async function first<T = Row>(db: Db, sql: string, params: Param[] = []): Promise<T | null> {
  const rows = await all<T>(db, sql, params);
  return rows[0] ?? null;
}

export async function run(db: Db, sql: string, params: Param[] = []): Promise<number> {
  const [r] = await db.batch([{ sql, params }]);
  return r?.changes ?? 0;
}

export function assertParams(params: unknown[] | undefined): void {
  for (const p of params ?? []) {
    if (typeof p === 'number') {
      if (!Number.isSafeInteger(p)) throw new DbError('numeric parameters must be safe integers');
    } else if (typeof p !== 'string') {
      throw new DbError('parameters must be strings or integers (write NULL literally in SQL)');
    }
  }
}
