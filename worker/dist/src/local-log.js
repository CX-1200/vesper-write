// §5.2 local ticket record (log/tickets.jsonl, mode 0600). This is the only
// place plaintext requests and prompts are kept, and it lives on the VM —
// the root of trust. Weekly encrypted backup and rotation arrive in v2 (§15).
import { appendLine } from "./fsutil.js";
export function appendTicketRecord(p, r) {
    appendLine(p.ticketLog, JSON.stringify(r));
}
