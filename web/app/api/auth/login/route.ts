// POST /api/auth/login — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handleLogin } from '../../../../lib/handlers/auth.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleLogin);
