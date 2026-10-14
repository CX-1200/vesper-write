// POST /api/kill — see lib/handlers for the logic.
import { route } from '../../../lib/app.ts';
import { handleKill } from '../../../lib/handlers/misc.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleKill);
