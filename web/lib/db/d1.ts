// Cloudflare D1 over the REST API (OD1).
// POST /client/v4/accounts/{account_id}/d1/database/{database_id}/query
// body: { sql, params } for one statement or { batch: [{ sql, params }, …] }.
// See docs/verification.md item 11 for what is and is not documented.

import { assertParams, DbError, type Db, type Statement, type StatementResult } from './types.ts';

interface D1Result {
  results?: Record<string, unknown>[];
  success?: boolean;
  meta?: { changes?: number };
}

interface D1Response {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: D1Result[];
}

export interface D1Config {
  accountId: string;
  databaseId: string;
  apiToken: string;
  /** "batch" (one request) or "sequential" (one request per statement) */
  mode?: 'batch' | 'sequential';
  fetchImpl?: typeof fetch;
}

type ResolvedD1Config = Required<D1Config>;

export class D1RestDb implements Db {
  readonly #cfg: ResolvedD1Config;

  constructor(cfg: D1Config) {
    if (!/^[0-9a-f]{32}$/i.test(cfg.accountId)) throw new DbError('D1 account id looks wrong');
    if (!/^[0-9a-f-]{36}$/i.test(cfg.databaseId)) throw new DbError('D1 database id looks wrong');
    if (!cfg.apiToken) throw new DbError('D1 API token missing');
    this.#cfg = { mode: 'batch', fetchImpl: globalThis.fetch.bind(globalThis), ...cfg };
  }

  get #url(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.#cfg.accountId}/d1/database/${this.#cfg.databaseId}/query`;
  }

  async #post(body: unknown): Promise<D1Result[]> {
    let res: Response;
    try {
      res = await this.#cfg.fetchImpl(this.#url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#cfg.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new DbError('D1 request failed (network)');
    }
    let json: D1Response;
    try {
      json = (await res.json()) as D1Response;
    } catch {
      throw new DbError(`D1 returned a non-JSON response (HTTP ${res.status})`);
    }
    if (!res.ok || !json.success || !Array.isArray(json.result)) {
      // Error codes/messages from D1 describe SQL problems; they never contain the token.
      const msg = (json.errors ?? []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ');
      throw new DbError(`D1 query failed (HTTP ${res.status}) ${msg}`.slice(0, 500));
    }
    for (const r of json.result) if (r.success === false) throw new DbError('D1 statement failed');
    return json.result;
  }

  async batch(statements: Statement[]): Promise<StatementResult[]> {
    for (const s of statements) assertParams(s.params);
    const norm = statements.map((s) => ({ sql: s.sql, params: (s.params ?? []).map(String) }));
    if (norm.length === 0) return [];
    let results: D1Result[];
    if (norm.length === 1) {
      results = await this.#post(norm[0]);
    } else if (this.#cfg.mode === 'batch') {
      results = await this.#post({ batch: norm });
    } else {
      results = [];
      for (const s of norm) results.push(...(await this.#post(s)));
    }
    if (results.length !== norm.length) throw new DbError('D1 returned an unexpected number of results');
    return results.map((r) => ({ rows: r.results ?? [], changes: r.meta?.changes ?? 0 }));
  }
}
