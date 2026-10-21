// POST /api/devices/[id]/rename — see lib/handlers for the logic.
import { route } from '../../../../../lib/app.ts';
import { handleDeviceRename } from '../../../../../lib/handlers/devices.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleDeviceRename);
