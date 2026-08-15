-- 澄笺 | Simlettra 正式迁移 0002
-- 依据：需求 3.03、3.04、3.07、9.11、9.13，ADR 0011。

PRAGMA foreign_keys = ON;

CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    token_digest BLOB NOT NULL UNIQUE CHECK (length(token_digest) = 32),
    csrf_token_digest BLOB NOT NULL CHECK (length(csrf_token_digest) = 32),
    client_label TEXT NOT NULL CHECK (length(client_label) BETWEEN 1 AND 120),
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    idle_expires_at INTEGER NOT NULL,
    absolute_expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revoked_reason TEXT,
    CHECK (last_activity_at >= created_at),
    CHECK (idle_expires_at > created_at),
    CHECK (absolute_expires_at > created_at),
    CHECK (idle_expires_at <= absolute_expires_at),
    CHECK (
        (revoked_at IS NULL AND revoked_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
    ),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX sessions_user_active_index
    ON sessions (user_id, absolute_expires_at, id)
    WHERE revoked_at IS NULL;

CREATE TABLE login_rate_limits (
    scope_type TEXT NOT NULL CHECK (scope_type IN ('account', 'source')),
    scope_key_digest BLOB NOT NULL CHECK (length(scope_key_digest) = 32),
    window_started_at INTEGER NOT NULL,
    failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
    blocked_until INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_type, scope_key_digest),
    CHECK (updated_at >= window_started_at)
);

CREATE INDEX login_rate_limits_expiry_index
    ON login_rate_limits (blocked_until, updated_at);
