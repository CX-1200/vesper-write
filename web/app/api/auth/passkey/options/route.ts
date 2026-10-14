// POST /api/auth/passkey/options — see lib/handlers for the logic.
import { route } from '../../../../../lib/app.ts';
import { handlePasskeyOptions } from '../../../../../lib/handlers/auth.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handlePasskeyOptions);
