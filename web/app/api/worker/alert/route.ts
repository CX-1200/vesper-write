// POST /api/worker/alert — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handleWorkerAlert } from '../../../../lib/handlers/worker.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleWorkerAlert);
