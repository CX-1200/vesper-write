// GET, POST /api/tickets — see lib/handlers for the logic.
import { route } from '../../../lib/app.ts';
import { handleTicketCreate, handleTicketList } from '../../../lib/handlers/tickets.ts';

export const dynamic = 'force-dynamic';

export const GET = route(handleTicketList);
export const POST = route(handleTicketCreate);
