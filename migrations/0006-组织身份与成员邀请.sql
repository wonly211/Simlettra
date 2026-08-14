-- 澄笺 | Simlettra 正式迁移 0006
-- 依据：需求 8.01 至 8.16、11.15，需求变更 0008，ADR 0015、0038。

PRAGMA foreign_keys = ON;

CREATE TABLE user_organization_policies (
    user_id TEXT PRIMARY KEY NOT NULL,
    organization_limit INTEGER NOT NULL DEFAULT 5 CHECK (
        organization_limit BETWEEN 0 AND 1000
    ),
    updated_by_user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX user_organization_policies_updated_index
    ON user_organization_policies (updated_at, user_id);

INSERT INTO user_organization_policies (
    user_id, organization_limit, updated_by_user_id, created_at, updated_at
)
SELECT id, 5, NULL, created_at, updated_at
FROM users;

CREATE TABLE organization_memberships (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    left_reason TEXT CHECK (
        left_reason IS NULL OR left_reason IN (
            'member_exited', 'creator_transferred', 'organization_deleted'
        )
    ),
    CHECK (
        (left_at IS NULL AND left_reason IS NULL)
        OR (left_at IS NOT NULL AND left_at >= joined_at AND left_reason IS NOT NULL)
    ),
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX organization_memberships_current_unique
    ON organization_memberships (organization_id, user_id)
    WHERE left_at IS NULL;

CREATE INDEX organization_memberships_current_user_index
    ON organization_memberships (user_id, organization_id, id)
    WHERE left_at IS NULL;

CREATE INDEX organization_memberships_history_index
    ON organization_memberships (organization_id, joined_at, id);

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
        (status = 'pending' AND accepted_membership_id IS NULL AND resolved_at IS NULL)
        OR (status = 'accepted' AND accepted_membership_id IS NOT NULL AND resolved_at IS NOT NULL)
        OR (status IN ('rejected', 'revoked')
            AND accepted_membership_id IS NULL AND resolved_at IS NOT NULL)
    ),
    CHECK (resolved_at IS NULL OR resolved_at >= created_at),
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    FOREIGN KEY (invited_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (invited_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (accepted_membership_id)
        REFERENCES organization_memberships (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX organization_invitations_pending_unique
    ON organization_invitations (organization_id, invited_user_id)
    WHERE status = 'pending';

CREATE INDEX organization_invitations_user_index
    ON organization_invitations (invited_user_id, status, created_at, id);

CREATE INDEX organization_invitations_organization_index
    ON organization_invitations (organization_id, status, created_at, id);

CREATE TRIGGER validate_organization_creation
BEFORE INSERT ON organizations
BEGIN
    SELECT CASE WHEN NEW.status <> 'active'
        OR NEW.deletion_requested_at IS NOT NULL
        OR NEW.deletion_due_at IS NOT NULL
        THEN RAISE(ABORT, '新组织必须从正常状态建立') END;

    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM users
        JOIN user_organization_policies
          ON user_organization_policies.user_id = users.id
        WHERE users.id = NEW.creator_user_id
          AND users.status = 'active'
    ) THEN RAISE(ABORT, '创建者没有可用的组织策略') END;

    SELECT CASE WHEN (
        SELECT COUNT(*)
        FROM organizations
        WHERE creator_user_id = NEW.creator_user_id
    ) >= (
        SELECT organization_limit
        FROM user_organization_policies
        WHERE user_id = NEW.creator_user_id
    ) THEN RAISE(ABORT, '组织创建额度已用完') END;
END;

CREATE TRIGGER validate_organization_creator_transfer
BEFORE UPDATE OF creator_user_id ON organizations
WHEN NEW.creator_user_id <> OLD.creator_user_id
BEGIN
    SELECT CASE WHEN OLD.status <> 'active' OR NEW.status <> 'active'
        THEN RAISE(ABORT, '只能在正常组织中转移创建者') END;

    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM users
        JOIN organization_memberships
          ON organization_memberships.user_id = users.id
         AND organization_memberships.organization_id = NEW.id
         AND organization_memberships.left_at IS NULL
        WHERE users.id = NEW.creator_user_id
          AND users.status = 'active'
    ) THEN RAISE(ABORT, '继承者必须是当前有效组织成员') END;

    SELECT CASE WHEN (
        SELECT COUNT(*)
        FROM organizations
        WHERE creator_user_id = NEW.creator_user_id
          AND id <> NEW.id
    ) >= (
        SELECT organization_limit
        FROM user_organization_policies
        WHERE user_id = NEW.creator_user_id
    ) THEN RAISE(ABORT, '继承者的组织创建额度已用完') END;
END;

CREATE TRIGGER validate_organization_membership_insert
BEFORE INSERT ON organization_memberships
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM organizations
        WHERE id = NEW.organization_id AND status = 'active'
    ) THEN RAISE(ABORT, '组织当前不能增加成员') END;

    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM users
        WHERE id = NEW.user_id AND status = 'active'
    ) THEN RAISE(ABORT, '用户当前不能加入组织') END;
END;

CREATE TRIGGER prevent_active_creator_membership_exit
BEFORE UPDATE OF left_at ON organization_memberships
WHEN OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
 AND EXISTS (
     SELECT 1 FROM organizations
     WHERE organizations.id = OLD.organization_id
       AND organizations.status = 'active'
       AND organizations.creator_user_id = OLD.user_id
 )
BEGIN
    SELECT RAISE(ABORT, '创建者退出前必须先完成身份继承');
END;

CREATE TRIGGER validate_organization_invitation_insert
BEFORE INSERT ON organization_invitations
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM organizations
        WHERE id = NEW.organization_id
          AND status = 'active'
          AND creator_user_id = NEW.invited_by_user_id
    ) THEN RAISE(ABORT, '只有当前创建者可以邀请成员') END;

    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM users
        WHERE id = NEW.invited_user_id AND status = 'active'
    ) THEN RAISE(ABORT, '只能邀请当前有效用户') END;

    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM organization_memberships
        WHERE organization_id = NEW.organization_id
          AND user_id = NEW.invited_user_id
          AND left_at IS NULL
    ) AND NEW.status <> 'accepted'
        THEN RAISE(ABORT, '该用户已是组织成员') END;

    SELECT CASE WHEN NEW.status = 'accepted' AND NOT EXISTS (
        SELECT 1 FROM organization_memberships
        WHERE id = NEW.accepted_membership_id
          AND organization_id = NEW.organization_id
          AND user_id = NEW.invited_user_id
          AND left_at IS NULL
    ) THEN RAISE(ABORT, '已接受邀请必须关联匹配的当前成员记录') END;
END;

CREATE TRIGGER prevent_organization_invitation_identity_change
BEFORE UPDATE OF organization_id, invited_user_id, invited_by_user_id, created_at
ON organization_invitations
BEGIN
    SELECT RAISE(ABORT, '组织邀请身份不可修改');
END;

CREATE TRIGGER validate_organization_invitation_transition
BEFORE UPDATE OF status, accepted_membership_id, resolved_at
ON organization_invitations
WHEN NOT (
    OLD.status = 'pending'
    AND NEW.status IN ('accepted', 'rejected', 'revoked')
    AND (
        (NEW.status = 'accepted' AND EXISTS (
            SELECT 1 FROM organization_memberships
            WHERE id = NEW.accepted_membership_id
              AND organization_id = NEW.organization_id
              AND user_id = NEW.invited_user_id
              AND left_at IS NULL
        ))
        OR (NEW.status IN ('rejected', 'revoked') AND NEW.accepted_membership_id IS NULL)
    )
)
BEGIN
    SELECT RAISE(ABORT, '组织邀请状态变化无效');
END;

CREATE TRIGGER validate_current_organization_shared_binding
BEFORE INSERT ON address_bindings
WHEN NEW.owner_type = 'organization'
 AND NEW.address_role = 'shared'
 AND NEW.ended_at IS NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM organizations
        WHERE organizations.id = NEW.organization_id
          AND organizations.status = 'active'
    ) THEN RAISE(ABORT, '组织当前不能绑定共享地址') END;

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
    ) THEN RAISE(ABORT, '组织共享地址不可用') END;
END;
