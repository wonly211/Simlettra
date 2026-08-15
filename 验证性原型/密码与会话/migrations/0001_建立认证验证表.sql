CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'deletion_pending')),
  password_record TEXT NOT NULL,
  password_changed_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE,
  csrf_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revocation_reason TEXT,
  user_agent TEXT NOT NULL
);

CREATE INDEX sessions_user_id_index ON sessions(user_id, created_at DESC);

CREATE TABLE login_limits (
  scope_key TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL
);

CREATE TABLE prototype_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL
);
