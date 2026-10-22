// POST /api/devices/[id]/remove — see lib/handlers for the logic.
import { route } from '../../../../../lib/app.ts';
import { handleDeviceRemove } from '../../../../../lib/handlers/devices.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleDeviceRemove);
