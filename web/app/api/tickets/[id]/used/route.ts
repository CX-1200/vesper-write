// POST /api/tickets/[id]/used — see lib/handlers for the logic.
import { route } from '../../../../../lib/app.ts';
import { handleTicketUsed } from '../../../../../lib/handlers/tickets.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleTicketUsed);
