PRAGMA foreign_keys = ON;

-- 早期开发数据库曾使用不含 default_owner_type 的共享默认策略表。
-- 本迁移只读取两个表形状共有的列，再按当前正式结构重建直接依赖表。
CREATE TABLE logical_storage_quota_policies_0024_snapshot AS
SELECT id, storage_mode, owner_type, user_id, organization_id, policy_version,
       limit_bytes, policy_status, effective_at, retired_at, created_at, updated_at
FROM logical_storage_quota_policies;

CREATE TABLE logical_storage_reservations_0024_snapshot AS
SELECT * FROM logical_storage_reservations;

-- 最早的开发数据库尚未建立用量明细表；先补空表，统一后续快照与重建路径。
CREATE TABLE IF NOT EXISTS logical_storage_usage_entries (
    id TEXT PRIMARY KEY NOT NULL,
    storage_usage_account_id TEXT NOT NULL,
    storage_reservation_id TEXT,
    entry_kind TEXT NOT NULL CHECK (
        entry_kind IN (
            'message', 'draft', 'sent_copy', 'deletion', 'migration',
            'reconciliation', 'manual_adjustment'
        )
    ),
    owner_reference TEXT NOT NULL CHECK (length(owner_reference) > 0),
    bytes_delta INTEGER NOT NULL CHECK (bytes_delta <> 0),
    idempotency_key_digest BLOB NOT NULL UNIQUE CHECK (length(idempotency_key_digest) = 32),
    committed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (storage_usage_account_id)
        REFERENCES logical_storage_usage_accounts (id) ON DELETE CASCADE,
    FOREIGN KEY (storage_reservation_id)
        REFERENCES logical_storage_reservations (id) ON DELETE SET NULL
);

CREATE TABLE logical_storage_usage_entries_0024_snapshot AS
SELECT * FROM logical_storage_usage_entries;

CREATE TABLE logical_storage_default_scopes_0024_snapshot AS
SELECT policy.id,
       CASE
           WHEN policy.id IN ('logical-storage-kv-user-v1', 'logical-storage-r2-user-v1')
               THEN 'user'
           WHEN policy.id IN (
               'logical-storage-kv-organization-v1',
               'logical-storage-r2-organization-v1'
           ) THEN 'organization'
           ELSE (
               SELECT CASE
                   WHEN audit.target_reference = policy.storage_mode || ':user' THEN 'user'
                   WHEN audit.target_reference = policy.storage_mode || ':organization'
                       THEN 'organization'
                   ELSE NULL
               END
               FROM audit_events AS audit
               WHERE audit.action_name = 'storage_quota.default_updated'
                 AND audit.occurred_at = policy.created_at
                 AND audit.target_reference IN (
                     policy.storage_mode || ':user',
                     policy.storage_mode || ':organization'
                 )
               ORDER BY audit.id
               LIMIT 1
           )
       END AS default_owner_type
FROM logical_storage_quota_policies_0024_snapshot AS policy
WHERE policy.owner_type = 'system_default';

DROP TABLE logical_storage_usage_entries;
DROP TABLE logical_storage_reservations;
DROP TABLE logical_storage_quota_policies;

CREATE TABLE logical_storage_quota_policies (
    id TEXT PRIMARY KEY NOT NULL,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('system_default', 'user', 'organization')),
    default_owner_type TEXT CHECK (
        default_owner_type IS NULL OR default_owner_type IN ('user', 'organization')
    ),
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
        (owner_type = 'system_default' AND default_owner_type IS NOT NULL
            AND user_id IS NULL AND organization_id IS NULL)
        OR (owner_type = 'user' AND default_owner_type IS NULL
            AND user_id IS NOT NULL AND organization_id IS NULL)
        OR (owner_type = 'organization' AND default_owner_type IS NULL
            AND user_id IS NULL AND organization_id IS NOT NULL)
    ),
    CHECK (
        (policy_status = 'active' AND retired_at IS NULL)
        OR (policy_status = 'retired' AND retired_at IS NOT NULL AND retired_at >= effective_at)
    ),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
);

-- 当前结构的四个初始默认策略优先沿用自身事实；早期共享策略则复制为两种主体默认值。
INSERT INTO logical_storage_quota_policies (
    id, storage_mode, owner_type, default_owner_type, user_id, organization_id,
    policy_version, limit_bytes, policy_status, effective_at,
    retired_at, created_at, updated_at
)
SELECT seed.id, seed.storage_mode, 'system_default', seed.default_owner_type, NULL, NULL,
       COALESCE(current.policy_version, legacy.policy_version, 1),
       COALESCE(current.limit_bytes, legacy.limit_bytes, seed.limit_bytes),
       COALESCE(current.policy_status, legacy.policy_status, 'active'),
       COALESCE(current.effective_at, legacy.effective_at, 0),
       COALESCE(current.retired_at, legacy.retired_at),
       COALESCE(current.created_at, legacy.created_at, 0),
       COALESCE(current.updated_at, legacy.updated_at, 0)
FROM (
    SELECT 'logical-storage-kv-user-v1' AS id, 'kv' AS storage_mode,
           'user' AS default_owner_type, 100000000 AS limit_bytes,
           'logical-storage-kv-system-v1' AS legacy_id
    UNION ALL
    SELECT 'logical-storage-kv-organization-v1', 'kv', 'organization', 100000000,
           'logical-storage-kv-system-v1'
    UNION ALL
    SELECT 'logical-storage-r2-user-v1', 'r2', 'user', 1000000000,
           'logical-storage-r2-system-v1'
    UNION ALL
    SELECT 'logical-storage-r2-organization-v1', 'r2', 'organization', 1000000000,
           'logical-storage-r2-system-v1'
) AS seed
LEFT JOIN logical_storage_quota_policies_0024_snapshot AS current ON current.id = seed.id
LEFT JOIN logical_storage_quota_policies_0024_snapshot AS legacy ON legacy.id = seed.legacy_id;

-- 当前结构中由管理员建立的默认策略通过审计目标恢复个人或组织范围。
INSERT INTO logical_storage_quota_policies (
    id, storage_mode, owner_type, default_owner_type, user_id, organization_id,
    policy_version, limit_bytes, policy_status, effective_at,
    retired_at, created_at, updated_at
)
SELECT policy.id, policy.storage_mode, 'system_default', scope.default_owner_type,
       NULL, NULL, policy.policy_version, policy.limit_bytes, policy.policy_status,
       policy.effective_at, policy.retired_at, policy.created_at, policy.updated_at
FROM logical_storage_quota_policies_0024_snapshot AS policy
JOIN logical_storage_default_scopes_0024_snapshot AS scope ON scope.id = policy.id
WHERE policy.owner_type = 'system_default'
  AND scope.default_owner_type IN ('user', 'organization')
  AND policy.id NOT IN (
      'logical-storage-kv-user-v1',
      'logical-storage-kv-organization-v1',
      'logical-storage-r2-user-v1',
      'logical-storage-r2-organization-v1'
  );

-- 没有范围事实的早期共享策略复制为个人与组织两份，避免静默丢失历史版本。
INSERT INTO logical_storage_quota_policies (
    id, storage_mode, owner_type, default_owner_type, user_id, organization_id,
    policy_version, limit_bytes, policy_status, effective_at,
    retired_at, created_at, updated_at
)
SELECT policy.id || '-0024-' || scope.owner_type,
       policy.storage_mode, 'system_default', scope.owner_type, NULL, NULL,
       policy.policy_version, policy.limit_bytes, policy.policy_status,
       policy.effective_at, policy.retired_at, policy.created_at, policy.updated_at
FROM logical_storage_quota_policies_0024_snapshot AS policy
JOIN logical_storage_default_scopes_0024_snapshot AS known ON known.id = policy.id
CROSS JOIN (
    SELECT 'user' AS owner_type
    UNION ALL SELECT 'organization'
) AS scope
WHERE policy.owner_type = 'system_default'
  AND known.default_owner_type IS NULL
  AND policy.id NOT IN ('logical-storage-kv-system-v1', 'logical-storage-r2-system-v1');

-- 用户和组织覆盖策略的共有列在两个历史表形状中完全一致。
INSERT INTO logical_storage_quota_policies (
    id, storage_mode, owner_type, default_owner_type, user_id, organization_id,
    policy_version, limit_bytes, policy_status, effective_at,
    retired_at, created_at, updated_at
)
SELECT id, storage_mode, owner_type, NULL, user_id, organization_id,
       policy_version, limit_bytes, policy_status, effective_at,
       retired_at, created_at, updated_at
FROM logical_storage_quota_policies_0024_snapshot
WHERE owner_type IN ('user', 'organization');

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
        OR (reservation_status IN ('released', 'expired')
            AND committed_at IS NULL AND released_at IS NOT NULL)
    ),
    FOREIGN KEY (storage_usage_account_id)
        REFERENCES logical_storage_usage_accounts (id) ON DELETE CASCADE,
    FOREIGN KEY (quota_policy_id)
        REFERENCES logical_storage_quota_policies (id) ON DELETE RESTRICT
);

INSERT INTO logical_storage_reservations (
    id, storage_usage_account_id, quota_policy_id, operation_kind, operation_reference,
    reserved_bytes, limit_bytes_snapshot, reservation_key_digest, reservation_status,
    expires_at, committed_at, released_at, created_at, updated_at
)
SELECT reservation.id, reservation.storage_usage_account_id,
       CASE
           WHEN policy.id = 'logical-storage-kv-system-v1'
               THEN 'logical-storage-kv-' || account.owner_type || '-v1'
           WHEN policy.id = 'logical-storage-r2-system-v1'
               THEN 'logical-storage-r2-' || account.owner_type || '-v1'
           WHEN policy.owner_type = 'system_default'
             AND NOT EXISTS (
                 SELECT 1 FROM logical_storage_quota_policies AS current
                 WHERE current.id = policy.id
             ) THEN policy.id || '-0024-' || account.owner_type
           ELSE policy.id
       END,
       reservation.operation_kind, reservation.operation_reference,
       reservation.reserved_bytes, reservation.limit_bytes_snapshot,
       reservation.reservation_key_digest, reservation.reservation_status,
       reservation.expires_at, reservation.committed_at, reservation.released_at,
       reservation.created_at, reservation.updated_at
FROM logical_storage_reservations_0024_snapshot AS reservation
JOIN logical_storage_usage_accounts AS account
  ON account.id = reservation.storage_usage_account_id
JOIN logical_storage_quota_policies_0024_snapshot AS policy
  ON policy.id = reservation.quota_policy_id;

CREATE INDEX logical_storage_reservations_active_index
    ON logical_storage_reservations (
        storage_usage_account_id, reservation_status, expires_at, id
    );
CREATE INDEX logical_storage_reservations_operation_index
    ON logical_storage_reservations (
        operation_kind, operation_reference, reservation_status
    );
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
        AND account.committed_bytes + account.reserved_bytes + NEW.reserved_bytes
            <= NEW.limit_bytes_snapshot
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
WHEN OLD.reservation_status = 'reserved'
  AND NEW.reservation_status IN ('released', 'expired')
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
        entry_kind IN (
            'message', 'draft', 'sent_copy', 'deletion', 'migration',
            'reconciliation', 'manual_adjustment'
        )
    ),
    owner_reference TEXT NOT NULL CHECK (length(owner_reference) > 0),
    bytes_delta INTEGER NOT NULL CHECK (bytes_delta <> 0),
    idempotency_key_digest BLOB NOT NULL UNIQUE CHECK (length(idempotency_key_digest) = 32),
    committed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (storage_usage_account_id)
        REFERENCES logical_storage_usage_accounts (id) ON DELETE CASCADE,
    FOREIGN KEY (storage_reservation_id)
        REFERENCES logical_storage_reservations (id) ON DELETE SET NULL
);

INSERT INTO logical_storage_usage_entries
SELECT * FROM logical_storage_usage_entries_0024_snapshot;

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

DROP TABLE logical_storage_usage_entries_0024_snapshot;
DROP TABLE logical_storage_reservations_0024_snapshot;
DROP TABLE logical_storage_default_scopes_0024_snapshot;
DROP TABLE logical_storage_quota_policies_0024_snapshot;
