// Splits schema.sql into single statements for the D1 REST API (one
// statement per request). Handles '--' comments, quoted strings and
// CREATE TRIGGER … BEGIN … END; bodies that contain semicolons.

export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          cur += sql[i + 1];
          i += 2;
          continue;
        }
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ';') {
      const stmt = cur.trim();
      const isTrigger = /^CREATE\s+TRIGGER\b/i.test(stmt);
      if (isTrigger && !/\bEND$/i.test(stmt)) {
        cur += ch;
        i++;
        continue;
      }
      if (stmt) out.push(stmt.replace(/\s+/g, ' '));
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (quote) throw new Error('unterminated string in SQL');
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
  return out;
}
