// GET /api/alerts — see lib/handlers for the logic.
import { route } from '../../../lib/app.ts';
import { handleAlerts } from '../../../lib/handlers/misc.ts';

export const dynamic = 'force-dynamic';

export const GET = route(handleAlerts);
