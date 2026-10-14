// Tiny SQL builders that respect the "no NULL parameters" rule. Table and
// column names always come from code, never from user input.

import type { Param, Statement } from './db/types.ts';

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`bad identifier ${name}`);
  return name;
}

export function insert(table: string, values: Record<string, Param | null | undefined>, opts: { orIgnore?: boolean } = {}): Statement {
  const cols: string[] = [];
  const marks: string[] = [];
  const params: Param[] = [];
  for (const [k, v] of Object.entries(values)) {
    cols.push(ident(k));
    if (v === null || v === undefined) {
      marks.push('NULL');
    } else {
      marks.push('?');
      params.push(v);
    }
  }
  const verb = opts.orIgnore ? 'INSERT OR IGNORE' : 'INSERT';
  return { sql: `${verb} INTO ${ident(table)} (${cols.join(', ')}) VALUES (${marks.join(', ')})`, params };
}

/** SET clause for UPDATE: returns "a = ?, b = NULL" and its params. */
export function setClause(values: Record<string, Param | null>): { sql: string; params: Param[] } {
  const parts: string[] = [];
  const params: Param[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === null) parts.push(`${ident(k)} = NULL`);
    else {
      parts.push(`${ident(k)} = ?`);
      params.push(v);
    }
  }
  return { sql: parts.join(', '), params };
}

/** Coerce a DB value that should be an integer (D1 returns numbers; be defensive). */
export function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

export function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
