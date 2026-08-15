-- 澄笺 | Simlettra 第一批迁移草案
-- 状态：草案，未进入正式 migrations 账本，不得直接用于生产升级。
-- 依据：ADR 0011、0012、0014、0015、0034。

PRAGMA foreign_keys = ON;

CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'disabled', 'deletion_pending', 'deleting', 'deleted')
    ),
    display_name TEXT NOT NULL,
    timezone TEXT,
    invitation_policy TEXT NOT NULL DEFAULT 'manual' CHECK (
        invitation_policy IN ('reject_all', 'manual', 'auto_accept')
    ),
    deletion_requested_at INTEGER,
    deletion_due_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        status <> 'deletion_pending'
        OR (
            deletion_requested_at IS NOT NULL
            AND deletion_due_at IS NOT NULL
            AND deletion_due_at > deletion_requested_at
        )
    ),
    CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);

CREATE INDEX users_status_index ON users (status, id);

CREATE TABLE password_credentials (
    user_id TEXT PRIMARY KEY NOT NULL,
    format_version INTEGER NOT NULL CHECK (format_version >= 1),
    algorithm TEXT NOT NULL CHECK (length(algorithm) > 0),
    iterations INTEGER NOT NULL CHECK (iterations >= 600000),
    salt BLOB NOT NULL CHECK (length(salt) = 16),
    derived_key BLOB NOT NULL CHECK (length(derived_key) = 32),
    must_change INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0, 1)),
    temporary_expires_at INTEGER,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    token_digest BLOB NOT NULL UNIQUE CHECK (length(token_digest) = 32),
    csrf_token_digest BLOB NOT NULL CHECK (length(csrf_token_digest) = 32),
    client_label TEXT,
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
    PRIMARY KEY (scope_type, scope_key_digest)
);

CREATE INDEX login_rate_limits_expiry_index
    ON login_rate_limits (blocked_until, updated_at);

CREATE TABLE mail_domains (
    id TEXT PRIMARY KEY NOT NULL,
    canonical_name TEXT COLLATE NOCASE NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'paused', 'deleting')
    ),
    catch_all_mode TEXT NOT NULL DEFAULT 'reject' CHECK (
        catch_all_mode IN ('reject', 'unallocated')
    ),
    paused_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at)
);

CREATE TRIGGER prevent_mail_domain_canonical_change
BEFORE UPDATE OF canonical_name ON mail_domains
WHEN NEW.canonical_name COLLATE BINARY <> OLD.canonical_name COLLATE BINARY
BEGIN
    SELECT RAISE(ABORT, '规范域名不可修改');
END;

CREATE TABLE organizations (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(name) > 0),
    creator_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'deletion_pending', 'deleting')
    ),
    members_can_send INTEGER NOT NULL DEFAULT 0 CHECK (members_can_send IN (0, 1)),
    deletion_requested_at INTEGER,
    deletion_due_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        status <> 'deletion_pending'
        OR (
            deletion_requested_at IS NOT NULL
            AND deletion_due_at IS NOT NULL
            AND deletion_due_at > deletion_requested_at
        )
    ),
    FOREIGN KEY (creator_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX organizations_creator_index
    ON organizations (creator_user_id, status, id);

CREATE TABLE email_addresses (
    id TEXT PRIMARY KEY NOT NULL,
    domain_id TEXT NOT NULL,
    display_address TEXT NOT NULL,
    canonical_address TEXT COLLATE NOCASE NOT NULL,
    public_label TEXT,
    created_at INTEGER NOT NULL,
    retired_at INTEGER,
    UNIQUE (id, canonical_address),
    CHECK (retired_at IS NULL OR retired_at >= created_at),
    FOREIGN KEY (domain_id) REFERENCES mail_domains (id) ON DELETE RESTRICT
);

CREATE INDEX email_addresses_domain_index
    ON email_addresses (domain_id, id);

CREATE INDEX email_addresses_canonical_history_index
    ON email_addresses (canonical_address, created_at, id);

CREATE TRIGGER prevent_email_address_identity_change
BEFORE UPDATE OF domain_id, display_address, canonical_address ON email_addresses
WHEN NEW.domain_id <> OLD.domain_id
    OR NEW.display_address <> OLD.display_address
    OR NEW.canonical_address COLLATE BINARY <> OLD.canonical_address COLLATE BINARY
BEGIN
    SELECT RAISE(ABORT, '邮箱地址身份不可修改');
END;

CREATE TABLE address_claims (
    canonical_address TEXT COLLATE NOCASE PRIMARY KEY NOT NULL,
    address_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'reserved')),
    reserved_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (status = 'active' AND reserved_until IS NULL)
        OR (status = 'reserved' AND reserved_until IS NOT NULL)
    ),
    FOREIGN KEY (address_id, canonical_address)
        REFERENCES email_addresses (id, canonical_address)
        ON DELETE RESTRICT
);

CREATE INDEX address_claims_release_index
    ON address_claims (status, reserved_until, canonical_address);

CREATE TABLE address_bindings (
    id TEXT PRIMARY KEY NOT NULL,
    address_id TEXT NOT NULL,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'organization')),
    user_id TEXT,
    organization_id TEXT,
    address_role TEXT NOT NULL CHECK (address_role IN ('primary', 'alias', 'shared')),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_reason TEXT,
    CHECK (ended_at IS NULL OR ended_at >= started_at),
    CHECK (
        (
            owner_type = 'user'
            AND user_id IS NOT NULL
            AND organization_id IS NULL
            AND address_role IN ('primary', 'alias')
        )
        OR (
            owner_type = 'organization'
            AND user_id IS NULL
            AND organization_id IS NOT NULL
            AND address_role = 'shared'
        )
    ),
    FOREIGN KEY (address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX address_bindings_current_address_unique
    ON address_bindings (address_id)
    WHERE ended_at IS NULL;

CREATE UNIQUE INDEX address_bindings_current_primary_unique
    ON address_bindings (user_id)
    WHERE ended_at IS NULL AND address_role = 'primary';

CREATE UNIQUE INDEX address_bindings_current_organization_unique
    ON address_bindings (organization_id)
    WHERE ended_at IS NULL AND address_role = 'shared';

CREATE INDEX address_bindings_current_user_index
    ON address_bindings (user_id, address_role, address_id)
    WHERE ended_at IS NULL;

CREATE TABLE user_address_preferences (
    user_id TEXT NOT NULL,
    address_id TEXT NOT NULL,
    custom_label TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_default_sender INTEGER NOT NULL DEFAULT 0 CHECK (is_default_sender IN (0, 1)),
    sender_display_name TEXT,
    signature_format TEXT CHECK (signature_format IN ('plain_text', 'html')),
    signature_content TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, address_id),
    CHECK (updated_at >= created_at),
    CHECK (
        (signature_format IS NULL AND signature_content IS NULL)
        OR (signature_format IS NOT NULL AND signature_content IS NOT NULL)
    ),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (address_id) REFERENCES email_addresses (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX user_address_preferences_default_sender_unique
    ON user_address_preferences (user_id)
    WHERE is_default_sender = 1;

CREATE INDEX user_address_preferences_order_index
    ON user_address_preferences (user_id, is_pinned DESC, sort_order, address_id);

CREATE TABLE organization_memberships (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    left_reason TEXT,
    CHECK (left_at IS NULL OR left_at >= joined_at),
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX organization_memberships_current_unique
    ON organization_memberships (organization_id, user_id)
    WHERE left_at IS NULL;

CREATE INDEX organization_memberships_current_user_index
    ON organization_memberships (user_id, organization_id)
    WHERE left_at IS NULL;

CREATE TABLE organization_invitations (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL,
    invited_user_id TEXT NOT NULL,
    invited_by_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'accepted', 'rejected', 'revoked')
    ),
    accepted_membership_id TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    CHECK (
        (status = 'pending' AND resolved_at IS NULL AND accepted_membership_id IS NULL)
        OR (
            status = 'accepted'
            AND resolved_at IS NOT NULL
            AND accepted_membership_id IS NOT NULL
        )
        OR (
            status IN ('rejected', 'revoked')
            AND resolved_at IS NOT NULL
            AND accepted_membership_id IS NULL
        )
    ),
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    FOREIGN KEY (invited_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (invited_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (accepted_membership_id) REFERENCES organization_memberships (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX organization_invitations_pending_unique
    ON organization_invitations (organization_id, invited_user_id)
    WHERE status = 'pending';

CREATE INDEX organization_invitations_user_index
    ON organization_invitations (invited_user_id, status, created_at, id);

CREATE TABLE system_instances (
    singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
    current_admin_user_id TEXT NOT NULL,
    initialized_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    FOREIGN KEY (current_admin_user_id) REFERENCES users (id) ON DELETE RESTRICT
);
