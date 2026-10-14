// POST /api/worker/register — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handleWorkerRegister } from '../../../../lib/handlers/worker.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleWorkerRegister);
