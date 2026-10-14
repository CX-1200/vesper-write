// File helpers with safe permissions: directories 0700, files 0600, and
// atomic replacement (write to a temp file, fsync, rename) so a crash never
// leaves a half-written trust list or key.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync, chmodSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n', mode);
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function appendLine(path: string, line: string): void {
  ensureDir(dirname(path));
  appendFileSync(path, line.endsWith('\n') ? line : line + '\n', { mode: 0o600 });
}

/** Returns a description of the problem if `path` is readable by group/other, else null. */
export function permissionProblem(path: string): string | null {
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  return mode & 0o077 ? `${path} has mode ${mode.toString(8)}, expected 600/700` : null;
}
