// POST /api/worker/device-approval — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handleWorkerDeviceApproval } from '../../../../lib/handlers/worker.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleWorkerDeviceApproval);
