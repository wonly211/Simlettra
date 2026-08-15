-- 澄笺 | Simlettra 正式迁移 0004
-- 依据：需求变更 0007、ADR 0014、0015、0035、0036。

PRAGMA foreign_keys = ON;

CREATE TABLE user_alias_policies (
    user_id TEXT PRIMARY KEY NOT NULL,
    alias_limit INTEGER NOT NULL DEFAULT 20 CHECK (alias_limit BETWEEN 0 AND 1000),
    self_creation_enabled INTEGER NOT NULL DEFAULT 1 CHECK (self_creation_enabled IN (0, 1)),
    updated_by_user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX user_alias_policies_updated_index
    ON user_alias_policies (updated_at, user_id);

INSERT INTO user_alias_policies (
    user_id, alias_limit, self_creation_enabled,
    updated_by_user_id, created_at, updated_at
)
SELECT id, 20, 1, NULL, created_at, updated_at
FROM users;

CREATE TRIGGER validate_current_personal_alias_binding
BEFORE INSERT ON address_bindings
WHEN NEW.owner_type = 'user'
 AND NEW.address_role = 'alias'
 AND NEW.ended_at IS NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM users
        JOIN user_alias_policies ON user_alias_policies.user_id = users.id
        WHERE users.id = NEW.user_id
          AND users.status = 'active'
    ) THEN RAISE(ABORT, '用户没有可用的个人别名策略') END;

    SELECT CASE WHEN (
        SELECT COUNT(*)
        FROM address_bindings
        WHERE user_id = NEW.user_id
          AND owner_type = 'user'
          AND address_role = 'alias'
          AND ended_at IS NULL
    ) >= (
        SELECT alias_limit
        FROM user_alias_policies
        WHERE user_id = NEW.user_id
    ) THEN RAISE(ABORT, '个人别名额度已用完') END;

    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM email_addresses
        JOIN mail_domains ON mail_domains.id = email_addresses.domain_id
        JOIN address_claims
          ON address_claims.address_id = email_addresses.id
         AND address_claims.canonical_address = email_addresses.canonical_address
        WHERE email_addresses.id = NEW.address_id
          AND mail_domains.status = 'active'
          AND address_claims.status = 'active'
          AND address_claims.reserved_until IS NULL
    ) THEN RAISE(ABORT, '个人别名地址不可用') END;
END;
