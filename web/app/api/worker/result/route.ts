// POST /api/worker/result — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handleWorkerResult } from '../../../../lib/handlers/worker.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleWorkerResult);
