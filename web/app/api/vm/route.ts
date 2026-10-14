// GET /api/vm — see lib/handlers for the logic.
import { route } from '../../../lib/app.ts';
import { handleVm } from '../../../lib/handlers/devices.ts';

export const dynamic = 'force-dynamic';

export const GET = route(handleVm);
