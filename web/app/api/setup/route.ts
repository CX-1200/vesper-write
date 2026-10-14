// POST /api/setup — see lib/handlers for the logic.
import { route } from '../../../lib/app.ts';
import { handleSetup } from '../../../lib/handlers/setup.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleSetup);
