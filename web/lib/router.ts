// The same endpoint table as app/api/**/route.ts, as data. Used by tests to
// call handlers through a fetch-compatible function (no HTTP server needed);
// a test checks this table and the route files stay in sync.

import type { AppContext } from './context.ts';
import { handleSetup } from './handlers/setup.ts';
import { handleLogin, handleLogout, handlePasskeyOptions, handlePasskeyVerify } from './handlers/auth.ts';
import { handleDeviceList, handleDeviceMe, handleDeviceRemove, handleDeviceRename, handleDeviceRevoke, handleEnrollStart, handleVm } from './handlers/devices.ts';
import { handleTicketCreate, handleTicketGet, handleTicketList, handleTicketReject, handleTicketReviewed, handleTicketUsed } from './handlers/tickets.ts';
import { handleAlerts, handleAudit, handleConfig, handleKill, handlePushSubscribe, handleSecretsRotate } from './handlers/misc.ts';
import { handleWorkerAlert, handleWorkerDeviceApproval, handleWorkerPull, handleWorkerRegister, handleWorkerResult } from './handlers/worker.ts';

type Handler = (req: Request, ctx: AppContext, params: { id: string }) => Promise<Response>;

export const ROUTES: Array<{ method: 'GET' | 'POST'; path: string; handler: Handler }> = [
  { method: 'POST', path: '/api/setup', handler: handleSetup },
  { method: 'POST', path: '/api/auth/login', handler: handleLogin },
  { method: 'POST', path: '/api/auth/logout', handler: handleLogout },
  { method: 'POST', path: '/api/auth/passkey/options', handler: handlePasskeyOptions },
  { method: 'POST', path: '/api/auth/passkey/verify', handler: handlePasskeyVerify },
  { method: 'GET', path: '/api/devices', handler: handleDeviceList },
  { method: 'GET', path: '/api/devices/me', handler: handleDeviceMe },
  { method: 'POST', path: '/api/devices/enroll/start', handler: handleEnrollStart },
  { method: 'POST', path: '/api/devices/[id]/revoke', handler: handleDeviceRevoke },
  { method: 'POST', path: '/api/devices/[id]/rename', handler: handleDeviceRename },
  { method: 'POST', path: '/api/devices/[id]/remove', handler: handleDeviceRemove },
  { method: 'GET', path: '/api/vm', handler: handleVm },
  { method: 'GET', path: '/api/tickets', handler: handleTicketList },
  { method: 'POST', path: '/api/tickets', handler: handleTicketCreate },
  { method: 'GET', path: '/api/tickets/[id]', handler: handleTicketGet },
  { method: 'POST', path: '/api/tickets/[id]/used', handler: handleTicketUsed },
  { method: 'POST', path: '/api/tickets/[id]/reject', handler: handleTicketReject },
  { method: 'POST', path: '/api/tickets/[id]/reviewed', handler: handleTicketReviewed },
  { method: 'POST', path: '/api/kill', handler: handleKill },
  { method: 'POST', path: '/api/push/subscribe', handler: handlePushSubscribe },
  { method: 'GET', path: '/api/audit', handler: handleAudit },
  { method: 'GET', path: '/api/config', handler: handleConfig },
  { method: 'GET', path: '/api/alerts', handler: handleAlerts },
  { method: 'POST', path: '/api/secrets/rotate', handler: handleSecretsRotate },
  { method: 'POST', path: '/api/worker/register', handler: handleWorkerRegister },
  { method: 'POST', path: '/api/worker/pull', handler: handleWorkerPull },
  { method: 'POST', path: '/api/worker/result', handler: handleWorkerResult },
  { method: 'POST', path: '/api/worker/device-approval', handler: handleWorkerDeviceApproval },
  { method: 'POST', path: '/api/worker/alert', handler: handleWorkerAlert },
];

function compile(path: string): RegExp {
  return new RegExp('^' + path.replace(/\[id\]/g, '([^/]+)') + '$');
}

const COMPILED = ROUTES.map((r) => ({ ...r, re: compile(r.path) }));

export async function dispatch(req: Request, ctx: AppContext): Promise<Response> {
  const { pathname } = new URL(req.url);
  for (const r of COMPILED) {
    const m = r.re.exec(pathname);
    if (m && r.method === req.method.toUpperCase()) return r.handler(req, ctx, { id: decodeURIComponent(m[1] ?? '') });
  }
  return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
}
