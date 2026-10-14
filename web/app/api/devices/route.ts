// GET /api/devices — see lib/handlers for the logic.
import { route } from '../../../lib/app.ts';
import { handleDeviceList } from '../../../lib/handlers/devices.ts';

export const dynamic = 'force-dynamic';

export const GET = route(handleDeviceList);
