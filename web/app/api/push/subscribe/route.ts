// POST /api/push/subscribe — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handlePushSubscribe } from '../../../../lib/handlers/misc.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handlePushSubscribe);
