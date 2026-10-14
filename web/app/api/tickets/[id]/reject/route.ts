// POST /api/tickets/[id]/reject — see lib/handlers for the logic.
import { route } from '../../../../../lib/app.ts';
import { handleTicketReject } from '../../../../../lib/handlers/tickets.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleTicketReject);
