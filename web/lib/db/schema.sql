-- Vesper schema for Cloudflare D1 (SQLite). Build Spec §5.1.
-- All times are UTC milliseconds (INTEGER). No ticket plaintext, preferences
-- or templates are ever stored here: tickets hold only ciphertext envelopes
-- and metadata.

-- Single owner (OD2: password + TOTP). Not in §5.1, required by OD2.
CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,          -- argon2id PHC string
  totp_secret_enc TEXT NOT NULL,        -- AES-256-GCM with TOTP_ENC_KEY (Vercel env)
  totp_confirmed INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,  -- replay protection
  setup_completed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  webauthn_credential_id TEXT,
  webauthn_public_key TEXT,
  sign_count INTEGER NOT NULL DEFAULT 0,
  sign_public_key TEXT NOT NULL,        -- JWK
  enc_public_key TEXT NOT NULL,         -- JWK
  fingerprint TEXT NOT NULL,            -- §8.5
  vm_approved_at INTEGER,
  vm_approval_sig TEXT,                 -- VM signature over the approval record
  enrolled_at INTEGER NOT NULL,
  enrolled_via TEXT NOT NULL CHECK (enrolled_via IN ('setup', 'recovery')),
  last_seen_at INTEGER,
  last_ip TEXT,
  last_country TEXT,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_webauthn ON devices (webauthn_credential_id) WHERE webauthn_credential_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vm_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sign_public_key TEXT NOT NULL,
  enc_public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_ip TEXT,
  latched INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,             -- SHA-256 of the session id; the id itself is only in the cookie
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_device ON sessions (device_id);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,                  -- UUID generated on the device, bound into the AAD
  type TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('claude_ai', 'claude_code')),
  device_id TEXT NOT NULL,
  input_envelope TEXT NOT NULL,         -- device → VM ciphertext
  input_sig TEXT NOT NULL,
  input_nonce TEXT NOT NULL,
  input_ts INTEGER NOT NULL,
  output_envelopes TEXT,                -- VM → devices ciphertexts, { device_id: envelope }
  output_sig TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'awaiting_review', 'used', 'rejected', 'expired', 'failed', 'stale', 'frozen')),
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  reviewed_at INTEGER,
  used_at INTEGER,
  expires_at INTEGER,                   -- entering awaiting_review + 12 h
  stale_at INTEGER NOT NULL,            -- created + OD7
  finished_at INTEGER,                  -- entering a terminal status (for OD4 retention, v2)
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS tickets_status_created ON tickets (status, created_at);
CREATE INDEX IF NOT EXISTS tickets_created ON tickets (created_at);

CREATE TABLE IF NOT EXISTS system_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('NORMAL', 'SUSPICIOUS', 'LOCKDOWN', 'KILLED')),
  since INTEGER NOT NULL,
  trigger_rule TEXT,
  suspicious_device_id TEXT,
  version INTEGER NOT NULL DEFAULT 0    -- optimistic concurrency
);
INSERT OR IGNORE INTO system_state (id, state, since, version) VALUES (1, 'NORMAL', 0, 0);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  device_id TEXT,
  ip TEXT,
  country TEXT,
  created_at INTEGER NOT NULL,
  detail TEXT,                          -- reason code only, never content
  resolved_at INTEGER,
  resolved_by_device_id TEXT,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('confirmed_me', 'killed', 'timeout_lockdown', 'vm_unlock'))
);
CREATE INDEX IF NOT EXISTS alerts_created ON alerts (created_at);

-- §14: append-only. There is no API that updates or deletes rows; the
-- trigger also refuses UPDATE at the database level. (DELETE is reserved for
-- the 90-day retention job in v2.)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  ip TEXT,
  country TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok', 'fail', 'info')),
  detail TEXT                           -- metadata only (JSON); never request bodies or content
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit_log (ts);
CREATE INDEX IF NOT EXISTS audit_ip_ts ON audit_log (ip, ts);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Only slow hashes (argon2id). §5.1, §18.
CREATE TABLE IF NOT EXISTS secrets_meta (
  kind TEXT PRIMARY KEY CHECK (kind IN ('setup', 'recovery', 'break_glass', 'kill_token', 'worker_token')),
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

-- §8.4 replay protection: a nonce may be used once per signer.
CREATE TABLE IF NOT EXISTS nonces (
  scope TEXT NOT NULL,
  nonce TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (scope, nonce)
);
CREATE INDEX IF NOT EXISTS nonces_seen ON nonces (seen_at);

-- fixed-window request counters (per IP and endpoint class)
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- R3 blocks
CREATE TABLE IF NOT EXISTS blocks (
  source TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  rule TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
