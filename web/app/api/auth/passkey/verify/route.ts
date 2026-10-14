// POST /api/auth/passkey/verify — see lib/handlers for the logic.
import { route } from '../../../../../lib/app.ts';
import { handlePasskeyVerify } from '../../../../../lib/handlers/auth.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handlePasskeyVerify);
