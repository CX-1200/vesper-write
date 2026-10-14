// POST /api/auth/logout — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handleLogout } from '../../../../lib/handlers/auth.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleLogout);
