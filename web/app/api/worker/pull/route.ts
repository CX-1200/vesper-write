// POST /api/worker/pull — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handleWorkerPull } from '../../../../lib/handlers/worker.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleWorkerPull);
