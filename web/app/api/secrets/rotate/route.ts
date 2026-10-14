// POST /api/secrets/rotate — see lib/handlers for the logic.
import { route } from '../../../../lib/app.ts';
import { handleSecretsRotate } from '../../../../lib/handlers/misc.ts';

export const dynamic = 'force-dynamic';

export const POST = route(handleSecretsRotate);
