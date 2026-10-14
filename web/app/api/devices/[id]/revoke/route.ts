// POST /api/devices/[id]/revoke — see lib/handlers for the logic.
import { route } from '../../../../../lib/app.ts';
import { handleDeviceRevoke } from '../../../../../lib/handlers/devices.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleDeviceRevoke);
