// GET /api/tickets/[id] — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handleTicketGet } from '../../../../lib/handlers/tickets.ts';

export const dynamic = 'force-dynamic';

export const GET = route(handleTicketGet);
