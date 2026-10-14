// GET /api/config — see lib/handlers for the logic.
import { route } from '../../../lib/app.ts';
import { handleConfig } from '../../../lib/handlers/misc.ts';

export const dynamic = 'force-dynamic';

export const GET = route(handleConfig);
