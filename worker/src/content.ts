// ~/vesper-content (§4): preferences.md, templates/, ticket-types.json.
// Owned and committed by the user; the worker only reads it, fresh for every
// ticket (§9.1 step 3). Template paths are confined to the content directory.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface TicketTypeConfig {
  /** model alias or full model ID, e.g. "claude-haiku-5-5" */
  model: string;
  /** path relative to the content directory, e.g. "templates/general.md" */
  template: string;
  /** hard cap: longer output is truncated and flagged L6 */
  max_output_chars: number;
  /** soft norm: output longer than 1.5× this is flagged L6 */
  typical_chars?: number;
}

export interface LoadedType {
  key: string;
  config: TicketTypeConfig;
  template: string;
}

const MAX_FILE_BYTES = 64 * 1024;
const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{1,63}$/;

export class ContentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ContentError';
  }
}

function readSmall(path: string): string {
  const st = statSync(path);
  if (!st.isFile()) throw new ContentError('content_missing', `${path} is not a file`);
  if (st.size > MAX_FILE_BYTES) throw new ContentError('content_too_large', `${path} is larger than 64 KiB`);
  return readFileSync(path, 'utf8');
}

/** Resolve `rel` inside `root`, refusing absolute paths, ".." escapes and symlinks pointing outside. */
export function insideRoot(root: string, rel: string): string {
  if (isAbsolute(rel)) throw new ContentError('bad_template_path', 'template path must be relative');
  const realRoot = realpathSync(root);
  const target = realpathSync(resolve(realRoot, rel));
  const r = relative(realRoot, target);
  if (r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..')) throw new ContentError('bad_template_path', 'template path escapes the content directory');
  return target;
}

export function loadTicketTypes(contentDir: string): Record<string, TicketTypeConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(readSmall(join(contentDir, 'ticket-types.json')));
  } catch (e) {
    if (e instanceof ContentError) throw e;
    throw new ContentError('bad_ticket_types', 'ticket-types.json is missing or not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ContentError('bad_ticket_types', 'ticket-types.json must be an object');
  const out: Record<string, TicketTypeConfig> = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(key)) throw new ContentError('bad_ticket_types', `bad type key ${key}`);
    const c = v as Partial<TicketTypeConfig>;
    if (!c || typeof c.model !== 'string' || !MODEL_RE.test(c.model)) throw new ContentError('bad_ticket_types', `${key}.model is invalid`);
    if (typeof c.template !== 'string' || !c.template) throw new ContentError('bad_ticket_types', `${key}.template is required`);
    if (!Number.isSafeInteger(c.max_output_chars) || c.max_output_chars! < 100 || c.max_output_chars! > 200_000) {
      throw new ContentError('bad_ticket_types', `${key}.max_output_chars must be 100–200000`);
    }
    if (c.typical_chars !== undefined && (!Number.isSafeInteger(c.typical_chars) || c.typical_chars < 1)) {
      throw new ContentError('bad_ticket_types', `${key}.typical_chars must be a positive integer`);
    }
    out[key] = { model: c.model, template: c.template, max_output_chars: c.max_output_chars!, ...(c.typical_chars ? { typical_chars: c.typical_chars } : {}) };
  }
  return out;
}

export function loadPreferences(contentDir: string): string {
  return readSmall(join(contentDir, 'preferences.md'));
}

export function loadType(contentDir: string, key: string): LoadedType {
  const types = loadTicketTypes(contentDir);
  const config = types[key];
  if (!config) throw new ContentError('unknown_type', `ticket type ${key} is not in ticket-types.json`);
  let path: string;
  try {
    path = insideRoot(contentDir, config.template);
  } catch (e) {
    if (e instanceof ContentError) throw e;
    throw new ContentError('content_missing', `template for ${key} not found`);
  }
  return { key, config, template: readSmall(path) };
}
