-- 澄笺 | Simlettra 正式迁移 0020
-- 依据：需求 3.11、8.13 至 8.15、9.07 至 9.09、11.09、11.14、11.15，
-- 数据-99 至数据-107，ADR 0011、0015、0033、0042。

PRAGMA foreign_keys = ON;

CREATE TABLE account_recovery_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    token_digest BLOB NOT NULL UNIQUE CHECK (length(token_digest) = 32),
    csrf_token_digest BLOB NOT NULL CHECK (length(csrf_token_digest) = 32),
    client_label TEXT NOT NULL CHECK (length(client_label) BETWEEN 1 AND 120),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    consumed_at INTEGER,
    revoked_at INTEGER,
    revoked_reason TEXT,
    CHECK (expires_at > created_at),
    CHECK (last_activity_at >= created_at),
    CHECK (last_activity_at <= expires_at),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    CHECK (consumed_at IS NULL OR revoked_at IS NULL),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX account_recovery_sessions_user_active_index
    ON account_recovery_sessions (user_id, expires_at, id)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TRIGGER validate_account_recovery_session_insert
BEFORE INSERT ON account_recovery_sessions
WHEN NOT EXISTS (
    SELECT 1 FROM users
    WHERE users.id = NEW.user_id
      AND users.status = 'deletion_pending'
      AND users.deletion_due_at IS NOT NULL
      AND users.deletion_due_at > NEW.created_at
      AND NOT EXISTS (
          SELECT 1 FROM system_instances
          WHERE current_admin_user_id = users.id
      )
)
BEGIN
    SELECT RAISE(ABORT, '注销恢复会话只能为冷静期内的非管理员用户建立');
END;

CREATE TRIGGER prevent_account_recovery_session_identity_change
BEFORE UPDATE OF user_id, token_digest, csrf_token_digest, client_label,
    created_at, expires_at
ON account_recovery_sessions
BEGIN
    SELECT RAISE(ABORT, '注销恢复会话身份不可修改');
END;

CREATE TABLE account_deletion_membership_snapshots (
    deletion_operation_id TEXT NOT NULL,
    membership_id TEXT NOT NULL UNIQUE,
    organization_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (deletion_operation_id, membership_id),
    FOREIGN KEY (deletion_operation_id)
        REFERENCES deletion_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (membership_id)
        REFERENCES organization_memberships (id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE
);

CREATE INDEX account_deletion_membership_snapshots_organization_index
    ON account_deletion_membership_snapshots (organization_id, deletion_operation_id);

CREATE TABLE lifecycle_cleanup_checkpoints (
    deletion_operation_id TEXT NOT NULL,
    checkpoint_key TEXT NOT NULL CHECK (length(checkpoint_key) > 0),
    cursor_reference TEXT,
    processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (deletion_operation_id, checkpoint_key),
    CHECK (updated_at >= created_at),
    CHECK (completed_at IS NULL OR completed_at >= created_at),
    FOREIGN KEY (deletion_operation_id)
        REFERENCES deletion_operations (id) ON DELETE CASCADE
);

CREATE INDEX lifecycle_cleanup_checkpoints_work_index
    ON lifecycle_cleanup_checkpoints (completed_at, updated_at, deletion_operation_id);

CREATE TABLE lifecycle_cleanup_children (
    parent_deletion_operation_id TEXT NOT NULL,
    child_deletion_operation_id TEXT NOT NULL UNIQUE,
    child_target_type TEXT NOT NULL CHECK (child_target_type = 'message'),
    child_target_reference TEXT NOT NULL CHECK (length(child_target_reference) > 0),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_deletion_operation_id, child_deletion_operation_id),
    FOREIGN KEY (parent_deletion_operation_id)
        REFERENCES deletion_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (child_deletion_operation_id)
        REFERENCES deletion_operations (id) ON DELETE CASCADE
);

CREATE INDEX lifecycle_cleanup_children_parent_index
    ON lifecycle_cleanup_children (
        parent_deletion_operation_id, child_target_type, child_target_reference
    );

CREATE TRIGGER validate_user_lifecycle_transition
BEFORE UPDATE OF status ON users
WHEN NEW.status <> OLD.status
  AND NOT (
      (OLD.status = 'active' AND NEW.status IN ('disabled', 'deletion_pending'))
      OR (OLD.status = 'disabled' AND NEW.status = 'active')
      OR (OLD.status = 'deletion_pending' AND NEW.status IN ('active', 'deleting'))
      OR (OLD.status = 'deleting' AND NEW.status = 'deleted')
  )
BEGIN
    SELECT RAISE(ABORT, '用户生命周期状态变化无效');
END;

CREATE TRIGGER validate_user_lifecycle_fields
BEFORE UPDATE OF status, deletion_requested_at, deletion_due_at, deleted_at ON users
WHEN NOT (
    (
        NEW.status IN ('active', 'disabled')
        AND NEW.deletion_requested_at IS NULL
        AND NEW.deletion_due_at IS NULL
        AND NEW.deleted_at IS NULL
    )
    OR (
        NEW.status IN ('deletion_pending', 'deleting')
        AND NEW.deletion_requested_at IS NOT NULL
        AND NEW.deletion_due_at IS NOT NULL
        AND NEW.deletion_due_at > NEW.deletion_requested_at
        AND NEW.deleted_at IS NULL
    )
    OR (
        NEW.status = 'deleted'
        AND NEW.deletion_requested_at IS NOT NULL
        AND NEW.deletion_due_at IS NOT NULL
        AND NEW.deleted_at IS NOT NULL
        AND NEW.deleted_at >= NEW.deletion_due_at
    )
)
BEGIN
    SELECT RAISE(ABORT, '用户生命周期时间字段与状态不匹配');
END;

CREATE TRIGGER prevent_current_administrator_deletion
BEFORE UPDATE OF status ON users
WHEN NEW.status IN ('deletion_pending', 'deleting', 'deleted')
  AND EXISTS (
      SELECT 1 FROM system_instances
      WHERE current_admin_user_id = OLD.id
  )
BEGIN
    SELECT RAISE(ABORT, '唯一系统管理员必须先转让管理员身份');
END;

CREATE TRIGGER validate_system_administrator_transfer
BEFORE UPDATE OF current_admin_user_id ON system_instances
WHEN NEW.current_admin_user_id <> OLD.current_admin_user_id
  AND NOT EXISTS (
      SELECT 1 FROM users
      WHERE users.id = NEW.current_admin_user_id
        AND users.status = 'active'
  )
BEGIN
    SELECT RAISE(ABORT, '新系统管理员必须是当前已启用用户');
END;

CREATE TRIGGER validate_organization_lifecycle_transition
BEFORE UPDATE OF status ON organizations
WHEN NEW.status <> OLD.status
  AND NOT (
      (OLD.status = 'active' AND NEW.status = 'deletion_pending')
      OR (OLD.status = 'deletion_pending' AND NEW.status IN ('active', 'deleting'))
  )
BEGIN
    SELECT RAISE(ABORT, '组织生命周期状态变化无效');
END;

CREATE TRIGGER validate_organization_lifecycle_fields
BEFORE UPDATE OF status, deletion_requested_at, deletion_due_at ON organizations
WHEN NOT (
    (
        NEW.status = 'active'
        AND NEW.deletion_requested_at IS NULL
        AND NEW.deletion_due_at IS NULL
    )
    OR (
        NEW.status IN ('deletion_pending', 'deleting')
        AND NEW.deletion_requested_at IS NOT NULL
        AND NEW.deletion_due_at IS NOT NULL
        AND NEW.deletion_due_at > NEW.deletion_requested_at
    )
)
BEGIN
    SELECT RAISE(ABORT, '组织生命周期时间字段与状态不匹配');
END;

DROP TRIGGER prevent_external_email_target_identity_change;

CREATE TRIGGER prevent_external_email_target_identity_change
BEFORE UPDATE OF user_id, canonical_email_address, created_at
ON external_email_targets
WHEN NEW.user_id <> OLD.user_id
  OR NEW.created_at <> OLD.created_at
  OR (
      NEW.canonical_email_address COLLATE BINARY <>
          OLD.canonical_email_address COLLATE BINARY
      AND NOT (
          NEW.target_status = 'deleted'
          AND EXISTS (
              SELECT 1 FROM users
              WHERE users.id = OLD.user_id
                AND users.status IN ('deleting', 'deleted')
          )
      )
  )
BEGIN
    SELECT RAISE(ABORT, '外部邮箱目标身份不可修改');
END;
