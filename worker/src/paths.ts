// §5.2 VM-local layout (all under the worker user's ~/.local/share/vesper).

import { join } from 'node:path';

export interface Paths {
  root: string;
  keysDir: string;
  signKey: string;
  encKey: string;
  pendingWorkerToken: string;
  trustedDevices: string;
  revokedDevices: string;
  stateDir: string;
  latch: string;
  pendingDevices: string;
  status: string;
  outboxDir: string;
  logDir: string;
  ticketLog: string;
  claudeHome: string;
  claudeCwd: string;
}

export function paths(dataDir: string): Paths {
  const stateDir = join(dataDir, 'state');
  return {
    root: dataDir,
    keysDir: join(dataDir, 'keys'),
    signKey: join(dataDir, 'keys', 'vm-sign.jwk'),
    encKey: join(dataDir, 'keys', 'vm-enc.jwk'),
    pendingWorkerToken: join(dataDir, 'keys', 'worker-token.pending'),
    trustedDevices: join(dataDir, 'trusted-devices.json'),
    revokedDevices: join(dataDir, 'revoked-devices.json'),
    stateDir,
    latch: join(stateDir, 'latch'),
    pendingDevices: join(stateDir, 'pending-devices.json'),
    status: join(stateDir, 'worker-status.json'),
    outboxDir: join(stateDir, 'device-outbox'),
    logDir: join(dataDir, 'log'),
    ticketLog: join(dataDir, 'log', 'tickets.jsonl'),
    claudeHome: join(dataDir, 'claude-home'),
    claudeCwd: join(dataDir, 'claude-cwd'),
  };
}
