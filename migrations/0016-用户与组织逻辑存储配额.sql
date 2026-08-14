PRAGMA foreign_keys = ON;

CREATE TABLE logical_storage_quota_policies (
    id TEXT PRIMARY KEY NOT NULL,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('system_default', 'user', 'organization')),
    default_owner_type TEXT CHECK (default_owner_type IS NULL OR default_owner_type IN ('user', 'organization')),
    user_id TEXT,
    organization_id TEXT,
    policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
    limit_bytes INTEGER NOT NULL CHECK (limit_bytes > 0),
    policy_status TEXT NOT NULL CHECK (policy_status IN ('active', 'retired')),
    effective_at INTEGER NOT NULL,
    retired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (owner_type = 'system_default' AND default_owner_type IS NOT NULL AND user_id IS NULL AND organization_id IS NULL)
        OR (owner_type = 'user' AND default_owner_type IS NULL AND user_id IS NOT NULL AND organization_id IS NULL)
        OR (owner_type = 'organization' AND default_owner_type IS NULL AND user_id IS NULL AND organization_id IS NOT NULL)
    ),
    CHECK (
        (policy_status = 'active' AND retired_at IS NULL)
        OR (policy_status = 'retired' AND retired_at IS NOT NULL AND retired_at >= effective_at)
    ),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX logical_storage_quota_policies_system_version_unique
    ON logical_storage_quota_policies (storage_mode, default_owner_type, policy_version)
    WHERE owner_type = 'system_default';
CREATE UNIQUE INDEX logical_storage_quota_policies_user_version_unique
    ON logical_storage_quota_policies (storage_mode, user_id, policy_version)
    WHERE owner_type = 'user';
CREATE UNIQUE INDEX logical_storage_quota_policies_organization_version_unique
    ON logical_storage_quota_policies (storage_mode, organization_id, policy_version)
    WHERE owner_type = 'organization';
CREATE UNIQUE INDEX logical_storage_quota_policies_active_system_unique
    ON logical_storage_quota_policies (storage_mode, default_owner_type)
    WHERE owner_type = 'system_default' AND policy_status = 'active';
CREATE UNIQUE INDEX logical_storage_quota_policies_active_user_unique
    ON logical_storage_quota_policies (storage_mode, user_id)
    WHERE owner_type = 'user' AND policy_status = 'active';
CREATE UNIQUE INDEX logical_storage_quota_policies_active_organization_unique
    ON logical_storage_quota_policies (storage_mode, organization_id)
    WHERE owner_type = 'organization' AND policy_status = 'active';

INSERT INTO logical_storage_quota_policies (
    id, storage_mode, owner_type, default_owner_type, user_id, organization_id, policy_version,
    limit_bytes, policy_status, effective_at, retired_at, created_at, updated_at
) VALUES
    ('logical-storage-kv-user-v1', 'kv', 'system_default', 'user', NULL, NULL, 1, 100000000, 'active', 0, NULL, 0, 0),
    ('logical-storage-kv-organization-v1', 'kv', 'system_default', 'organization', NULL, NULL, 1, 100000000, 'active', 0, NULL, 0, 0),
    ('logical-storage-r2-user-v1', 'r2', 'system_default', 'user', NULL, NULL, 1, 1000000000, 'active', 0, NULL, 0, 0),
    ('logical-storage-r2-organization-v1', 'r2', 'system_default', 'organization', NULL, NULL, 1, 1000000000, 'active', 0, NULL, 0, 0);

CREATE TABLE logical_storage_usage_accounts (
    id TEXT PRIMARY KEY NOT NULL,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'organization')),
    user_id TEXT,
    organization_id TEXT,
    committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
    reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    usage_version INTEGER NOT NULL DEFAULT 1 CHECK (usage_version >= 1),
    reconciled_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (owner_type = 'user' AND user_id IS NOT NULL AND organization_id IS NULL)
        OR (owner_type = 'organization' AND user_id IS NULL AND organization_id IS NOT NULL)
    ),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX logical_storage_usage_accounts_user_unique
    ON logical_storage_usage_accounts (storage_mode, user_id)
    WHERE owner_type = 'user';
CREATE UNIQUE INDEX logical_storage_usage_accounts_organization_unique
    ON logical_storage_usage_accounts (storage_mode, organization_id)
    WHERE owner_type = 'organization';

CREATE TABLE logical_storage_reservations (
    id TEXT PRIMARY KEY NOT NULL,
    storage_usage_account_id TEXT NOT NULL,
    quota_policy_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK (
        operation_kind IN ('receive', 'draft', 'sent_copy', 'migration', 'manual_adjustment')
    ),
    operation_reference TEXT NOT NULL CHECK (length(operation_reference) > 0),
    reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes > 0),
    limit_bytes_snapshot INTEGER NOT NULL CHECK (limit_bytes_snapshot > 0),
    reservation_key_digest BLOB NOT NULL UNIQUE CHECK (length(reservation_key_digest) = 32),
    reservation_status TEXT NOT NULL CHECK (
        reservation_status IN ('reserved', 'committed', 'released', 'expired')
    ),
    expires_at INTEGER NOT NULL,
    committed_at INTEGER,
    released_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (reserved_bytes <= limit_bytes_snapshot),
    CHECK (expires_at > created_at),
    CHECK (updated_at >= created_at),
    CHECK (
        (reservation_status = 'reserved' AND committed_at IS NULL AND released_at IS NULL)
        OR (reservation_status = 'committed' AND committed_at IS NOT NULL AND released_at IS NULL)
        OR (reservation_status IN ('released', 'expired') AND committed_at IS NULL AND released_at IS NOT NULL)
    ),
    FOREIGN KEY (storage_usage_account_id) REFERENCES logical_storage_usage_accounts (id) ON DELETE CASCADE,
    FOREIGN KEY (quota_policy_id) REFERENCES logical_storage_quota_policies (id) ON DELETE RESTRICT
);

CREATE INDEX logical_storage_reservations_active_index
    ON logical_storage_reservations (storage_usage_account_id, reservation_status, expires_at, id);
CREATE INDEX logical_storage_reservations_operation_index
    ON logical_storage_reservations (operation_kind, operation_reference, reservation_status);
CREATE UNIQUE INDEX logical_storage_reservations_active_operation_unique
    ON logical_storage_reservations (
        storage_usage_account_id, operation_kind, operation_reference
    )
    WHERE reservation_status = 'reserved';

CREATE TRIGGER validate_logical_storage_reservation_capacity
BEFORE INSERT ON logical_storage_reservations
WHEN NEW.reservation_status = 'reserved'
  AND NOT EXISTS (
      SELECT 1
      FROM logical_storage_usage_accounts AS account
      JOIN logical_storage_quota_policies AS policy
        ON policy.id = NEW.quota_policy_id
       AND policy.storage_mode = account.storage_mode
       AND policy.policy_status = 'active'
      WHERE account.id = NEW.storage_usage_account_id
        AND policy.limit_bytes = NEW.limit_bytes_snapshot
        AND account.committed_bytes + account.reserved_bytes + NEW.reserved_bytes <= NEW.limit_bytes_snapshot
  )
BEGIN
    SELECT RAISE(ABORT, '逻辑存储配额不足或策略不匹配');
END;

CREATE TRIGGER apply_logical_storage_reservation_insert
AFTER INSERT ON logical_storage_reservations
WHEN NEW.reservation_status = 'reserved'
BEGIN
    UPDATE logical_storage_usage_accounts
    SET reserved_bytes = reserved_bytes + NEW.reserved_bytes,
        usage_version = usage_version + 1,
        updated_at = MAX(updated_at, NEW.updated_at)
    WHERE id = NEW.storage_usage_account_id;
END;

CREATE TRIGGER validate_logical_storage_reservation_transition
BEFORE UPDATE OF reservation_status ON logical_storage_reservations
WHEN NOT (
    OLD.reservation_status = 'reserved'
    AND NEW.reservation_status IN ('committed', 'released', 'expired')
)
BEGIN
    SELECT RAISE(ABORT, '逻辑存储预留状态迁移无效');
END;

CREATE TRIGGER apply_logical_storage_reservation_commit
AFTER UPDATE OF reservation_status ON logical_storage_reservations
WHEN OLD.reservation_status = 'reserved' AND NEW.reservation_status = 'committed'
BEGIN
    UPDATE logical_storage_usage_accounts
    SET reserved_bytes = reserved_bytes - NEW.reserved_bytes,
        committed_bytes = committed_bytes + NEW.reserved_bytes,
        usage_version = usage_version + 1,
        updated_at = MAX(updated_at, NEW.updated_at)
    WHERE id = NEW.storage_usage_account_id;
END;

CREATE TRIGGER apply_logical_storage_reservation_release
AFTER UPDATE OF reservation_status ON logical_storage_reservations
WHEN OLD.reservation_status = 'reserved' AND NEW.reservation_status IN ('released', 'expired')
BEGIN
    UPDATE logical_storage_usage_accounts
    SET reserved_bytes = reserved_bytes - NEW.reserved_bytes,
        usage_version = usage_version + 1,
        updated_at = MAX(updated_at, NEW.updated_at)
    WHERE id = NEW.storage_usage_account_id;
END;

CREATE TABLE logical_storage_usage_entries (
    id TEXT PRIMARY KEY NOT NULL,
    storage_usage_account_id TEXT NOT NULL,
    storage_reservation_id TEXT,
    entry_kind TEXT NOT NULL CHECK (
        entry_kind IN ('message', 'draft', 'sent_copy', 'deletion', 'migration', 'reconciliation', 'manual_adjustment')
    ),
    owner_reference TEXT NOT NULL CHECK (length(owner_reference) > 0),
    bytes_delta INTEGER NOT NULL CHECK (bytes_delta <> 0),
    idempotency_key_digest BLOB NOT NULL UNIQUE CHECK (length(idempotency_key_digest) = 32),
    committed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (storage_usage_account_id) REFERENCES logical_storage_usage_accounts (id) ON DELETE CASCADE,
    FOREIGN KEY (storage_reservation_id) REFERENCES logical_storage_reservations (id) ON DELETE SET NULL
);

CREATE INDEX logical_storage_usage_entries_account_index
    ON logical_storage_usage_entries (storage_usage_account_id, committed_at, id);

CREATE TRIGGER validate_logical_storage_usage_entry
BEFORE INSERT ON logical_storage_usage_entries
WHEN NOT EXISTS (
    SELECT 1 FROM logical_storage_usage_accounts AS account
    WHERE account.id = NEW.storage_usage_account_id
      AND (
        NEW.storage_reservation_id IS NOT NULL
        OR account.committed_bytes + NEW.bytes_delta >= 0
      )
) OR (
    NEW.storage_reservation_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM logical_storage_reservations AS reservation
        WHERE reservation.id = NEW.storage_reservation_id
          AND reservation.storage_usage_account_id = NEW.storage_usage_account_id
          AND reservation.reservation_status = 'committed'
          AND reservation.reserved_bytes = NEW.bytes_delta
    )
)
BEGIN
    SELECT RAISE(ABORT, '逻辑存储用量变更无效');
END;

CREATE TRIGGER apply_logical_storage_usage_entry
AFTER INSERT ON logical_storage_usage_entries
WHEN NEW.storage_reservation_id IS NULL
BEGIN
    UPDATE logical_storage_usage_accounts
    SET committed_bytes = committed_bytes + NEW.bytes_delta,
        usage_version = usage_version + 1,
        updated_at = MAX(updated_at, NEW.created_at)
    WHERE id = NEW.storage_usage_account_id;
END;

CREATE TRIGGER prevent_logical_storage_usage_entry_update
BEFORE UPDATE ON logical_storage_usage_entries
BEGIN
    SELECT RAISE(ABORT, '逻辑存储用量账本不可修改');
END;

CREATE TRIGGER prevent_logical_storage_usage_entry_delete
BEFORE DELETE ON logical_storage_usage_entries
BEGIN
    SELECT RAISE(ABORT, '逻辑存储用量账本不可删除');
END;

CREATE TABLE internal_delivery_rejections (
    id TEXT PRIMARY KEY NOT NULL,
    send_operation_id TEXT NOT NULL,
    recipient_role TEXT NOT NULL CHECK (recipient_role IN ('to', 'cc', 'bcc')),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    address_text TEXT NOT NULL CHECK (length(address_text) > 0),
    canonical_address TEXT NOT NULL CHECK (instr(canonical_address, '@') > 1),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'organization')),
    user_id TEXT,
    organization_id TEXT,
    failure_code TEXT NOT NULL CHECK (failure_code = 'storage_quota_exceeded'),
    failure_detail TEXT NOT NULL CHECK (length(failure_detail) > 0),
    created_at INTEGER NOT NULL,
    UNIQUE (send_operation_id, recipient_role, sequence_number),
    CHECK (
        (owner_type = 'user' AND user_id IS NOT NULL AND organization_id IS NULL)
        OR (owner_type = 'organization' AND user_id IS NULL AND organization_id IS NOT NULL)
    ),
    FOREIGN KEY (send_operation_id) REFERENCES send_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT
);

CREATE INDEX internal_delivery_rejections_operation_index
    ON internal_delivery_rejections (send_operation_id, recipient_role, sequence_number, id);

CREATE TRIGGER prevent_internal_delivery_rejection_change
BEFORE UPDATE ON internal_delivery_rejections
BEGIN
    SELECT RAISE(ABORT, '系统内投递拒绝事实不可修改');
END;

CREATE TRIGGER create_logical_storage_user_accounts
AFTER INSERT ON users
BEGIN
    INSERT OR IGNORE INTO logical_storage_usage_accounts (
        id, storage_mode, owner_type, user_id, organization_id,
        committed_bytes, reserved_bytes, usage_version, reconciled_at, created_at, updated_at
    )
    SELECT 'storage-user-' || NEW.id || '-' || system.storage_mode,
           system.storage_mode, 'user', NEW.id, NULL, 0, 0, 1, NULL, NEW.created_at, NEW.updated_at
    FROM system_instances AS system WHERE system.singleton_id = 1;
END;

CREATE TRIGGER create_logical_storage_organization_accounts
AFTER INSERT ON organizations
BEGIN
    INSERT OR IGNORE INTO logical_storage_usage_accounts (
        id, storage_mode, owner_type, user_id, organization_id,
        committed_bytes, reserved_bytes, usage_version, reconciled_at, created_at, updated_at
    )
    SELECT 'storage-organization-' || NEW.id || '-' || system.storage_mode,
           system.storage_mode, 'organization', NULL, NEW.id, 0, 0, 1, NULL, NEW.created_at, NEW.updated_at
    FROM system_instances AS system WHERE system.singleton_id = 1;
END;

CREATE TRIGGER create_logical_storage_accounts_after_initialization
AFTER INSERT ON system_instances
BEGIN
    INSERT OR IGNORE INTO logical_storage_usage_accounts (
        id, storage_mode, owner_type, user_id, organization_id,
        committed_bytes, reserved_bytes, usage_version, reconciled_at, created_at, updated_at
    )
    SELECT 'storage-user-' || user.id || '-' || NEW.storage_mode,
           NEW.storage_mode, 'user', user.id, NULL, 0, 0, 1, NULL, user.created_at, NEW.updated_at
    FROM users AS user;

    INSERT OR IGNORE INTO logical_storage_usage_accounts (
        id, storage_mode, owner_type, user_id, organization_id,
        committed_bytes, reserved_bytes, usage_version, reconciled_at, created_at, updated_at
    )
    SELECT 'storage-organization-' || organization.id || '-' || NEW.storage_mode,
           NEW.storage_mode, 'organization', NULL, organization.id, 0, 0, 1, NULL, organization.created_at, NEW.updated_at
    FROM organizations AS organization;
END;

INSERT INTO logical_storage_usage_accounts (
    id, storage_mode, owner_type, user_id, organization_id,
    committed_bytes, reserved_bytes, usage_version, reconciled_at, created_at, updated_at
)
SELECT 'storage-user-' || user.id || '-' || system.storage_mode,
       system.storage_mode, 'user', user.id, NULL, 0, 0, 1, NULL, user.created_at, user.updated_at
FROM users AS user CROSS JOIN system_instances AS system
WHERE system.singleton_id = 1;

INSERT INTO logical_storage_usage_accounts (
    id, storage_mode, owner_type, user_id, organization_id,
    committed_bytes, reserved_bytes, usage_version, reconciled_at, created_at, updated_at
)
SELECT 'storage-organization-' || organization.id || '-' || system.storage_mode,
       system.storage_mode, 'organization', NULL, organization.id, 0, 0, 1, NULL, organization.created_at, organization.updated_at
FROM organizations AS organization CROSS JOIN system_instances AS system
WHERE system.singleton_id = 1;

INSERT INTO logical_storage_usage_entries (
    id, storage_usage_account_id, storage_reservation_id, entry_kind,
    owner_reference, bytes_delta, idempotency_key_digest, committed_at, created_at
)
SELECT 'storage-reconcile-user-' || user.id || '-' || system.storage_mode,
       account.id, NULL, 'reconciliation', 'backfill:user:' || user.id,
       COALESCE((
           SELECT SUM(message_size) FROM (
               SELECT DISTINCT entry.message_id, message.raw_size_bytes AS message_size
               FROM mailbox_entries AS entry
               JOIN messages AS message ON message.id = entry.message_id
               WHERE entry.mailbox_type = 'user' AND entry.user_id = user.id
           )
       ), 0) + COALESCE((
           SELECT SUM(object.expected_size_bytes)
           FROM drafts AS draft
           JOIN object_registry AS object
             ON object.owner_kind = 'draft' AND object.owner_reference = draft.id
            AND object.object_status = 'active' AND object.is_current = 1
           WHERE draft.owner_user_id = user.id AND draft.status IN ('active', 'trashed')
             AND object.object_role IN ('draft_body', 'draft_attachment')
       ), 0),
       randomblob(32), account.created_at, account.created_at
FROM users AS user
JOIN logical_storage_usage_accounts AS account
  ON account.user_id = user.id AND account.owner_type = 'user'
JOIN system_instances AS system
  ON system.storage_mode = account.storage_mode AND system.singleton_id = 1
WHERE (
    COALESCE((
        SELECT SUM(message_size) FROM (
            SELECT DISTINCT entry.message_id, message.raw_size_bytes AS message_size
            FROM mailbox_entries AS entry
            JOIN messages AS message ON message.id = entry.message_id
            WHERE entry.mailbox_type = 'user' AND entry.user_id = user.id
        )
    ), 0) + COALESCE((
        SELECT SUM(object.expected_size_bytes)
        FROM drafts AS draft
        JOIN object_registry AS object
          ON object.owner_kind = 'draft' AND object.owner_reference = draft.id
         AND object.object_status = 'active' AND object.is_current = 1
        WHERE draft.owner_user_id = user.id AND draft.status IN ('active', 'trashed')
          AND object.object_role IN ('draft_body', 'draft_attachment')
    ), 0)
) > 0;

INSERT INTO logical_storage_usage_entries (
    id, storage_usage_account_id, storage_reservation_id, entry_kind,
    owner_reference, bytes_delta, idempotency_key_digest, committed_at, created_at
)
SELECT 'storage-reconcile-organization-' || organization.id || '-' || system.storage_mode,
       account.id, NULL, 'reconciliation', 'backfill:organization:' || organization.id,
       COALESCE((
           SELECT SUM(message_size) FROM (
               SELECT DISTINCT entry.message_id, message.raw_size_bytes AS message_size
               FROM mailbox_entries AS entry
               JOIN messages AS message ON message.id = entry.message_id
               WHERE entry.mailbox_type = 'organization' AND entry.organization_id = organization.id
           )
       ), 0),
       randomblob(32), account.created_at, account.created_at
FROM organizations AS organization
JOIN logical_storage_usage_accounts AS account
  ON account.organization_id = organization.id AND account.owner_type = 'organization'
JOIN system_instances AS system
  ON system.storage_mode = account.storage_mode AND system.singleton_id = 1
WHERE COALESCE((
    SELECT SUM(message_size) FROM (
        SELECT DISTINCT entry.message_id, message.raw_size_bytes AS message_size
        FROM mailbox_entries AS entry
        JOIN messages AS message ON message.id = entry.message_id
        WHERE entry.mailbox_type = 'organization' AND entry.organization_id = organization.id
    )
), 0) > 0;
