// §5.2 local ticket record (log/tickets.jsonl, mode 0600). This is the only
// place plaintext requests and prompts are kept, and it lives on the VM —
// the root of trust. Weekly encrypted backup and rotation arrive in v2 (§15).

import type { LintHit } from '@vesper/core/lint';
import { appendLine } from './fsutil.ts';
import type { Paths } from './paths.ts';

export interface TicketRecord {
  ts: number;
  ticket_id: string;
  type: string;
  target: string;
  device_id: string;
  status: 'awaiting_review' | 'failed' | 'skipped';
  attempts: number;
  raw_input?: string;
  prompt?: string;
  lint?: LintHit[];
  model?: string;
  truncated?: boolean;
  duration_ms?: number;
  error_code?: string;
  recipients?: number;
}

export function appendTicketRecord(p: Paths, r: TicketRecord): void {
  appendLine(p.ticketLog, JSON.stringify(r));
}
