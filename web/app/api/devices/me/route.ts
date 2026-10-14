// GET /api/devices/me — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handleDeviceMe } from '../../../../lib/handlers/devices.ts';

export const dynamic = 'force-dynamic';

export const GET = route(handleDeviceMe);
