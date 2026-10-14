import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { splitSql } from '../../web/lib/db/split-sql.ts';

test('splitSql: comments, strings with semicolons, trigger bodies', () => {
  const sql = `-- comment; with semicolon
CREATE TABLE a (x TEXT DEFAULT 'a;b'); -- trailing
INSERT INTO a VALUES ('it''s;');
CREATE TRIGGER t BEFORE UPDATE ON a
BEGIN
  SELECT RAISE(ABORT, 'no; updates');
END;
`;
  assert.deepEqual(splitSql(sql), [
    "CREATE TABLE a (x TEXT DEFAULT 'a;b')",
    "INSERT INTO a VALUES ('it''s;')",
    "CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'no; updates'); END",
  ]);
});

test('splitSql: schema.sql statements execute one by one and match exec()', () => {
  const schema = readFileSync(new URL('../../web/lib/db/schema.sql', import.meta.url), 'utf8');
  const parts = splitSql(schema);
  assert.ok(parts.length > 20);
  const a = new DatabaseSync(':memory:');
  for (const s of parts) a.exec(s);
  const b = new DatabaseSync(':memory:');
  b.exec(schema);
  const objects = (db: DatabaseSync) => db.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name").all();
  assert.deepEqual(objects(a), objects(b));
  // idempotent: running everything again is harmless (IF NOT EXISTS / OR IGNORE)
  for (const s of parts) a.exec(s);
  a.exec("INSERT INTO audit_log (ts, event, actor, result) VALUES (1, 'e', 'a', 'ok')");
  assert.throws(() => a.exec("UPDATE audit_log SET event = 'x'"), /append-only/, 'trigger still active');
});

test('splitSql: rejects unterminated strings', () => {
  assert.throws(() => splitSql("SELECT 'oops;"), /unterminated/);
});
