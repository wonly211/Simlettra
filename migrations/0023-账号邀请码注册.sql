-- 澄笺 | Simlettra 正式迁移 0023
-- 依据：需求 3.02、9.09、9.13，需求变更 0010，ADR 0046。

PRAGMA foreign_keys = ON;

CREATE TABLE account_registration_invitations (
    id TEXT PRIMARY KEY NOT NULL,
    code_digest BLOB NOT NULL UNIQUE CHECK (length(code_digest) = 32),
    code_ciphertext BLOB NOT NULL CHECK (length(code_ciphertext) > 16),
    code_nonce BLOB NOT NULL CHECK (length(code_nonce) = 12),
    encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'AES-GCM-256'),
    encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version = 1),
    domain_id TEXT,
    domain_name_snapshot TEXT NOT NULL CHECK (length(domain_name_snapshot) BETWEEN 3 AND 253),
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    FOREIGN KEY (domain_id) REFERENCES mail_domains (id) ON DELETE SET NULL,
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX account_registration_invitations_state_index
    ON account_registration_invitations (revoked_at, created_at DESC, id DESC);

CREATE INDEX account_registration_invitations_domain_index
    ON account_registration_invitations (domain_id, created_at DESC, id DESC);

CREATE TABLE account_registration_invitation_consumptions (
    id TEXT PRIMARY KEY NOT NULL,
    invitation_id TEXT NOT NULL UNIQUE,
    user_id TEXT UNIQUE,
    user_display_name_snapshot TEXT NOT NULL CHECK (
        length(user_display_name_snapshot) BETWEEN 1 AND 80
    ),
    primary_address_snapshot TEXT NOT NULL CHECK (
        length(primary_address_snapshot) BETWEEN 3 AND 320
    ),
    consumed_at INTEGER NOT NULL,
    FOREIGN KEY (invitation_id)
        REFERENCES account_registration_invitations (id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TRIGGER validate_account_registration_invitation_consumption
BEFORE INSERT ON account_registration_invitation_consumptions
WHEN NOT EXISTS (
    SELECT 1
    FROM account_registration_invitations AS invitation
    JOIN mail_domains AS domain ON domain.id = invitation.domain_id
    WHERE invitation.id = NEW.invitation_id
      AND invitation.revoked_at IS NULL
      AND domain.status = 'active'
      AND NEW.user_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
      AND NOT EXISTS (
        SELECT 1
        FROM account_registration_invitation_consumptions AS consumption
        WHERE consumption.invitation_id = invitation.id
      )
)
BEGIN
    SELECT RAISE(ABORT, '账号邀请码不可用');
END;

CREATE TRIGGER revoke_account_registration_invitations_before_domain_delete
BEFORE DELETE ON mail_domains
BEGIN
    UPDATE account_registration_invitations
    SET revoked_at = COALESCE(revoked_at, unixepoch('subsec') * 1000)
    WHERE domain_id = OLD.id
      AND revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM account_registration_invitation_consumptions AS consumption
        WHERE consumption.invitation_id = account_registration_invitations.id
      );
END;

CREATE TABLE account_registration_rate_limits (
    source_key_digest BLOB PRIMARY KEY NOT NULL CHECK (length(source_key_digest) = 32),
    window_started_at INTEGER NOT NULL,
    failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
    blocked_until INTEGER,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= window_started_at)
);

CREATE INDEX account_registration_rate_limits_expiry_index
    ON account_registration_rate_limits (blocked_until, updated_at);
