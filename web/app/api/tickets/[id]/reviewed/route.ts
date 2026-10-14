// POST /api/tickets/[id]/reviewed — see lib/handlers for the logic.
import { route } from '../../../../../lib/app.ts';
import { handleTicketReviewed } from '../../../../../lib/handlers/tickets.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleTicketReviewed);
