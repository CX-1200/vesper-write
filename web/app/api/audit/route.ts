// GET /api/audit — see lib/handlers for the logic.
import { route } from '../../../lib/app.ts';
import { handleAudit } from '../../../lib/handlers/misc.ts';

export const dynamic = 'force-dynamic';

export const GET = route(handleAudit);
