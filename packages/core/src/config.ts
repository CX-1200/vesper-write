// All tunable thresholds in one place (§12: "所有阈值都写成可设定的常数，集中放在一个设定文件里").
// OD1–OD7 are the user's decisions from Build Spec §20 (see docs/decisions.md).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const CONFIG = {
  /** Display timezone; storage is always UTC milliseconds. */
  timezone: 'Asia/Kuala_Lumpur',

  // ---- user decisions (§20) ----
  /** OD3: SUSPICIOUS → LOCKDOWN after T */
  lockdownTimeoutMs: 20 * MINUTE,
  /** OD4: delete finished tickets on Vercel after N days (v2) */
  retentionDays: 3,
  /** OD5: inactive hours 00:00–07:00 Asia/Kuala_Lumpur (v2, R5) */
  inactiveHours: { startHour: 0, endHour: 7 },
  /** OD6: tickets per calendar day (Asia/Kuala_Lumpur) */
  dailyTicketCap: 50,
  /** OD7: a pending ticket becomes stale after this long */
  staleAfterMs: 72 * HOUR,

  // ---- tickets (§6.1) ----
  /** awaiting_review → expired after 12 h */
  reviewWindowMs: 12 * HOUR,
  /** processing lease */
  leaseMs: 5 * MINUTE,
  /** failed once attempts reach this */
  maxAttempts: 3,
  /** max characters of raw input a device may submit */
  maxRawInputChars: 20_000,

  // ---- auth ----
  sessionTtlMs: 12 * HOUR,
  /** §8.4 ±60 s */
  signatureWindowMs: 60_000,
  /** nonces are remembered at least this long (must exceed 2× the signature window) */
  nonceRetentionMs: 10 * MINUTE,
  passwordMinLength: 12,
  passwordMaxLength: 256,

  // ---- detection rules (§12) ----
  /** R3: ≥5 auth failures in 10 min → block the source for 15 min */
  r3: { windowMs: 10 * MINUTE, maxFailures: 5, blockMs: 15 * MINUTE },
  /** R5 (v2): step-up must succeed within 5 min */
  r5StepUpTimeoutMs: 5 * MINUTE,
  /** R6 (v2): more than 10 tickets in 10 min → SUSPICIOUS */
  r6: { windowMs: 10 * MINUTE, maxTickets: 10 },

  // ---- rate limits (requests per minute, fixed window) ----
  rateLimits: {
    devicePerIp: 120,
    authPerIp: 20,
    workerPerIp: 30,
    killPerIp: 10,
  },

  // ---- worker / VM ----
  workerPollIntervalMs: 30_000,
  /** tickets claimed per pull */
  workerClaimMax: 2,
  claudeTimeoutMs: 120_000,
  /** after N consecutive connection failures, back off exponentially */
  workerBackoff: { failuresBeforeBackoff: 5, baseMs: 30_000, maxMs: 15 * MINUTE },
  /** the VM counts as online if it pulled within this window */
  vmOnlineThresholdMs: 3 * 30_000,
  // a revoked device stays listed this long before it can be removed from the list
  revokedDeviceRetentionMs: 72 * 60 * 60_000,

  // ---- audit (§14) ----
  auditRetentionDays: 90,
  auditSimpleLimit: 50,
} as const;

export type Config = typeof CONFIG;
