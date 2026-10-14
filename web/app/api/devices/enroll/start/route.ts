// POST /api/devices/enroll/start — see lib/handlers for the logic.
import { route } from '../../../../../lib/app.ts';
import { handleEnrollStart } from '../../../../../lib/handlers/devices.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleEnrollStart);
