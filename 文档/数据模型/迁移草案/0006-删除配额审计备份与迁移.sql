-- 澄笺 | Simlettra 第六批迁移草案
-- 状态：草案，未进入正式 migrations 账本，不得直接用于生产升级。
-- 前置：0001 至 0005 迁移草案。
-- 依据：ADR 0013、0031、0032、0033。

PRAGMA foreign_keys = ON;

CREATE TABLE deletion_operations (
    id TEXT PRIMARY KEY NOT NULL,
    operation_kind TEXT NOT NULL CHECK (
        operation_kind IN (
            'user_delete',
            'organization_delete',
            'alias_release',
            'mailbox_entry_delete',
            'organization_mail_delete',
            'domain_delete',
            'backup_delete'
        )
    ),
    target_type TEXT NOT NULL CHECK (
        target_type IN (
            'user',
            'organization',
            'email_address',
            'mailbox_entry',
            'message',
            'mail_domain',
            'backup'
        )
    ),
    target_reference TEXT NOT NULL CHECK (length(target_reference) > 0),
    requested_by_user_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
    is_recoverable INTEGER NOT NULL CHECK (is_recoverable IN (0, 1)),
    requested_at INTEGER NOT NULL,
    recovery_due_at INTEGER,
    impact_mailbox_entry_count INTEGER NOT NULL DEFAULT 0 CHECK (impact_mailbox_entry_count >= 0),
    impact_message_count INTEGER NOT NULL DEFAULT 0 CHECK (impact_message_count >= 0),
    impact_object_count INTEGER NOT NULL DEFAULT 0 CHECK (impact_object_count >= 0),
    impact_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (impact_size_bytes >= 0),
    operation_status TEXT NOT NULL CHECK (
        operation_status IN (
            'blocked',
            'recovery_pending',
            'ready',
            'running',
            'needs_attention',
            'completed',
            'cancelled'
        )
    ),
    last_error_code TEXT,
    last_error_summary TEXT,
    completed_at INTEGER,
    cancelled_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (is_recoverable = 1 AND recovery_due_at IS NOT NULL AND recovery_due_at > requested_at)
        OR (is_recoverable = 0 AND recovery_due_at IS NULL)
    ),
    CHECK (
        operation_status <> 'recovery_pending'
        OR (is_recoverable = 1 AND recovery_due_at IS NOT NULL)
    ),
    CHECK (operation_status <> 'completed' OR completed_at IS NOT NULL),
    CHECK (operation_status <> 'cancelled' OR cancelled_at IS NOT NULL),
    CHECK (
        operation_status IN ('completed', 'cancelled')
        OR (completed_at IS NULL AND cancelled_at IS NULL)
    ),
    FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX deletion_operations_active_target_unique
    ON deletion_operations (target_type, target_reference)
    WHERE operation_status NOT IN ('completed', 'cancelled');

CREATE INDEX deletion_operations_due_index
    ON deletion_operations (operation_status, recovery_due_at, id);

CREATE TABLE deletion_operation_blockers (
    id TEXT PRIMARY KEY NOT NULL,
    deletion_operation_id TEXT NOT NULL,
    blocker_key TEXT NOT NULL CHECK (length(blocker_key) > 0),
    blocker_type TEXT NOT NULL CHECK (
        blocker_type IN ('ownership_transfer', 'active_reference', 'migration_required', 'backup_required', 'other')
    ),
    blocker_reference TEXT,
    blocker_status TEXT NOT NULL CHECK (blocker_status IN ('open', 'resolved', 'waived')),
    resolution_code TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    UNIQUE (deletion_operation_id, blocker_key),
    CHECK (
        (blocker_status = 'open' AND resolved_at IS NULL)
        OR (blocker_status IN ('resolved', 'waived') AND resolved_at IS NOT NULL)
    ),
    FOREIGN KEY (deletion_operation_id) REFERENCES deletion_operations (id) ON DELETE CASCADE
);

CREATE INDEX deletion_operation_blockers_open_index
    ON deletion_operation_blockers (deletion_operation_id, blocker_status, id);

CREATE TRIGGER prevent_deletion_start_with_open_blockers
BEFORE UPDATE OF operation_status ON deletion_operations
WHEN NEW.operation_status IN ('ready', 'running')
  AND EXISTS (
      SELECT 1 FROM deletion_operation_blockers
      WHERE deletion_operation_id = NEW.id AND blocker_status = 'open'
  )
BEGIN
    SELECT RAISE(ABORT, '删除操作仍有未解决阻塞项');
END;

CREATE TABLE deletion_operation_steps (
    id TEXT PRIMARY KEY NOT NULL,
    deletion_operation_id TEXT NOT NULL,
    step_key TEXT NOT NULL CHECK (length(step_key) > 0),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    step_kind TEXT NOT NULL CHECK (
        step_kind IN ('revoke_access', 'database_relations', 'objects', 'search', 'cache', 'reconcile', 'release_identity')
    ),
    is_required INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0, 1)),
    step_status TEXT NOT NULL CHECK (
        step_status IN ('pending', 'running', 'retry_wait', 'needs_attention', 'succeeded', 'skipped')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at INTEGER,
    last_error_code TEXT,
    last_error_summary TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (deletion_operation_id, step_key),
    UNIQUE (deletion_operation_id, sequence_number),
    CHECK (updated_at >= created_at),
    CHECK (step_status NOT IN ('succeeded', 'skipped') OR completed_at IS NOT NULL),
    CHECK (step_status <> 'running' OR started_at IS NOT NULL),
    FOREIGN KEY (deletion_operation_id) REFERENCES deletion_operations (id) ON DELETE CASCADE
);

CREATE INDEX deletion_operation_steps_work_index
    ON deletion_operation_steps (step_status, next_attempt_at, deletion_operation_id, sequence_number);

CREATE TRIGGER prevent_completed_deletion_step_regression
BEFORE UPDATE OF step_status ON deletion_operation_steps
WHEN OLD.step_status IN ('succeeded', 'skipped') AND NEW.step_status <> OLD.step_status
BEGIN
    SELECT RAISE(ABORT, '已完成删除步骤不可倒退');
END;

CREATE TRIGGER require_deletion_steps_before_completion
BEFORE UPDATE OF operation_status ON deletion_operations
WHEN NEW.operation_status = 'completed'
  AND (
      NOT EXISTS (
          SELECT 1 FROM deletion_operation_steps
          WHERE deletion_operation_id = NEW.id AND step_kind = 'reconcile' AND step_status = 'succeeded'
      )
      OR EXISTS (
          SELECT 1 FROM deletion_operation_steps
          WHERE deletion_operation_id = NEW.id
            AND is_required = 1
            AND step_status NOT IN ('succeeded', 'skipped')
      )
  )
BEGIN
    SELECT RAISE(ABORT, '删除步骤尚未全部完成或缺少最终对账');
END;

CREATE TABLE quota_policies (
    id TEXT PRIMARY KEY NOT NULL,
    quota_kind TEXT NOT NULL CHECK (
        quota_kind IN ('storage_bytes', 'daily_send_recipients', 'domain_monthly_send_recipients')
    ),
    scope_type TEXT NOT NULL CHECK (scope_type IN ('system_default', 'user', 'organization', 'domain')),
    user_id TEXT,
    organization_id TEXT,
    mail_domain_id TEXT,
    policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
    limit_value INTEGER CHECK (limit_value IS NULL OR limit_value >= 1),
    policy_status TEXT NOT NULL CHECK (policy_status IN ('active', 'retired')),
    effective_at INTEGER NOT NULL,
    retired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (scope_type = 'system_default' AND user_id IS NULL AND organization_id IS NULL AND mail_domain_id IS NULL)
        OR (scope_type = 'user' AND user_id IS NOT NULL AND organization_id IS NULL AND mail_domain_id IS NULL)
        OR (scope_type = 'organization' AND user_id IS NULL AND organization_id IS NOT NULL AND mail_domain_id IS NULL)
        OR (scope_type = 'domain' AND user_id IS NULL AND organization_id IS NULL AND mail_domain_id IS NOT NULL)
    ),
    CHECK (
        (quota_kind = 'storage_bytes' AND scope_type IN ('system_default', 'user', 'organization') AND limit_value IS NOT NULL)
        OR (quota_kind = 'daily_send_recipients' AND scope_type IN ('system_default', 'user') AND limit_value IS NOT NULL)
        OR (quota_kind = 'domain_monthly_send_recipients' AND scope_type IN ('system_default', 'domain'))
    ),
    CHECK (
        (policy_status = 'active' AND retired_at IS NULL)
        OR (policy_status = 'retired' AND retired_at IS NOT NULL AND retired_at >= effective_at)
    ),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    FOREIGN KEY (mail_domain_id) REFERENCES mail_domains (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX quota_policies_system_version_unique
    ON quota_policies (quota_kind, policy_version)
    WHERE scope_type = 'system_default';

CREATE UNIQUE INDEX quota_policies_user_version_unique
    ON quota_policies (quota_kind, user_id, policy_version)
    WHERE scope_type = 'user';

CREATE UNIQUE INDEX quota_policies_organization_version_unique
    ON quota_policies (quota_kind, organization_id, policy_version)
    WHERE scope_type = 'organization';

CREATE UNIQUE INDEX quota_policies_domain_version_unique
    ON quota_policies (quota_kind, mail_domain_id, policy_version)
    WHERE scope_type = 'domain';

CREATE UNIQUE INDEX quota_policies_active_system_unique
    ON quota_policies (quota_kind)
    WHERE scope_type = 'system_default' AND policy_status = 'active';

CREATE UNIQUE INDEX quota_policies_active_user_unique
    ON quota_policies (quota_kind, user_id)
    WHERE scope_type = 'user' AND policy_status = 'active';

CREATE UNIQUE INDEX quota_policies_active_organization_unique
    ON quota_policies (quota_kind, organization_id)
    WHERE scope_type = 'organization' AND policy_status = 'active';

CREATE UNIQUE INDEX quota_policies_active_domain_unique
    ON quota_policies (quota_kind, mail_domain_id)
    WHERE scope_type = 'domain' AND policy_status = 'active';

CREATE TABLE storage_usage_accounts (
    id TEXT PRIMARY KEY NOT NULL,
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

CREATE UNIQUE INDEX storage_usage_accounts_user_unique
    ON storage_usage_accounts (user_id) WHERE owner_type = 'user';

CREATE UNIQUE INDEX storage_usage_accounts_organization_unique
    ON storage_usage_accounts (organization_id) WHERE owner_type = 'organization';

CREATE TABLE storage_reservations (
    id TEXT PRIMARY KEY NOT NULL,
    storage_usage_account_id TEXT NOT NULL,
    quota_policy_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK (
        operation_kind IN ('receive', 'draft_attachment', 'sent_copy', 'migration', 'manual_adjustment')
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
    FOREIGN KEY (storage_usage_account_id) REFERENCES storage_usage_accounts (id) ON DELETE CASCADE,
    FOREIGN KEY (quota_policy_id) REFERENCES quota_policies (id) ON DELETE RESTRICT
);

CREATE INDEX storage_reservations_active_index
    ON storage_reservations (storage_usage_account_id, reservation_status, expires_at, id);

CREATE TRIGGER validate_storage_reservation_capacity
BEFORE INSERT ON storage_reservations
WHEN NEW.reservation_status = 'reserved'
  AND NOT EXISTS (
      SELECT 1
      FROM storage_usage_accounts AS account
      JOIN quota_policies AS policy ON policy.id = NEW.quota_policy_id
      WHERE account.id = NEW.storage_usage_account_id
        AND policy.quota_kind = 'storage_bytes'
        AND policy.policy_status = 'active'
        AND policy.limit_value = NEW.limit_bytes_snapshot
        AND account.committed_bytes + account.reserved_bytes + NEW.reserved_bytes <= NEW.limit_bytes_snapshot
  )
BEGIN
    SELECT RAISE(ABORT, '逻辑存储配额不足或策略不匹配');
END;

CREATE TRIGGER apply_storage_reservation_insert
AFTER INSERT ON storage_reservations
WHEN NEW.reservation_status = 'reserved'
BEGIN
    UPDATE storage_usage_accounts
    SET reserved_bytes = reserved_bytes + NEW.reserved_bytes,
        usage_version = usage_version + 1,
        updated_at = NEW.updated_at
    WHERE id = NEW.storage_usage_account_id;
END;

CREATE TRIGGER validate_storage_reservation_transition
BEFORE UPDATE OF reservation_status ON storage_reservations
WHEN NOT (
    OLD.reservation_status = 'reserved'
    AND NEW.reservation_status IN ('committed', 'released', 'expired')
)
BEGIN
    SELECT RAISE(ABORT, '存储预留状态迁移无效');
END;

CREATE TRIGGER apply_storage_reservation_commit
AFTER UPDATE OF reservation_status ON storage_reservations
WHEN OLD.reservation_status = 'reserved' AND NEW.reservation_status = 'committed'
BEGIN
    UPDATE storage_usage_accounts
    SET reserved_bytes = reserved_bytes - NEW.reserved_bytes,
        committed_bytes = committed_bytes + NEW.reserved_bytes,
        usage_version = usage_version + 1,
        updated_at = NEW.updated_at
    WHERE id = NEW.storage_usage_account_id;
END;

CREATE TRIGGER apply_storage_reservation_release
AFTER UPDATE OF reservation_status ON storage_reservations
WHEN OLD.reservation_status = 'reserved' AND NEW.reservation_status IN ('released', 'expired')
BEGIN
    UPDATE storage_usage_accounts
    SET reserved_bytes = reserved_bytes - NEW.reserved_bytes,
        usage_version = usage_version + 1,
        updated_at = NEW.updated_at
    WHERE id = NEW.storage_usage_account_id;
END;

CREATE TABLE storage_usage_entries (
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
    FOREIGN KEY (storage_usage_account_id) REFERENCES storage_usage_accounts (id) ON DELETE CASCADE,
    FOREIGN KEY (storage_reservation_id) REFERENCES storage_reservations (id) ON DELETE SET NULL
);

CREATE INDEX storage_usage_entries_account_index
    ON storage_usage_entries (storage_usage_account_id, committed_at, id);

CREATE TRIGGER prevent_storage_usage_entry_update
BEFORE UPDATE ON storage_usage_entries
BEGIN
    SELECT RAISE(ABORT, '逻辑用量账本不可修改');
END;

CREATE TABLE platform_resource_thresholds (
    id TEXT PRIMARY KEY NOT NULL,
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'kv', 'r2')),
    threshold_version INTEGER NOT NULL CHECK (threshold_version >= 1),
    warning_ratio_bps INTEGER NOT NULL CHECK (warning_ratio_bps BETWEEN 1 AND 10000),
    stop_ratio_bps INTEGER NOT NULL CHECK (stop_ratio_bps BETWEEN 1 AND 10000),
    threshold_status TEXT NOT NULL CHECK (threshold_status IN ('active', 'retired')),
    effective_at INTEGER NOT NULL,
    retired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (resource_kind, threshold_version),
    CHECK (warning_ratio_bps <= stop_ratio_bps),
    CHECK (
        (threshold_status = 'active' AND retired_at IS NULL)
        OR (threshold_status = 'retired' AND retired_at IS NOT NULL AND retired_at >= effective_at)
    )
);

CREATE UNIQUE INDEX platform_resource_thresholds_active_unique
    ON platform_resource_thresholds (resource_kind)
    WHERE threshold_status = 'active';

CREATE TABLE platform_resource_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'kv', 'r2')),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account', 'database', 'namespace', 'bucket', 'local_only')),
    scope_reference TEXT NOT NULL CHECK (length(scope_reference) > 0),
    free_limit_bytes INTEGER CHECK (free_limit_bytes IS NULL OR free_limit_bytes > 0),
    account_used_bytes INTEGER CHECK (account_used_bytes IS NULL OR account_used_bytes >= 0),
    simlettra_used_bytes INTEGER CHECK (simlettra_used_bytes IS NULL OR simlettra_used_bytes >= 0),
    remaining_bytes INTEGER CHECK (remaining_bytes IS NULL OR remaining_bytes >= 0),
    item_count INTEGER CHECK (item_count IS NULL OR item_count >= 0),
    data_source TEXT NOT NULL CHECK (data_source IN ('cloudflare_api', 'local_estimate')),
    fetch_status TEXT NOT NULL CHECK (
        fetch_status IN ('success', 'stale', 'unavailable', 'permission_denied')
    ),
    observed_at INTEGER,
    fetched_at INTEGER NOT NULL,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    CHECK (
        (fetch_status IN ('success', 'stale')
            AND free_limit_bytes IS NOT NULL
            AND account_used_bytes IS NOT NULL
            AND simlettra_used_bytes IS NOT NULL
            AND remaining_bytes IS NOT NULL
            AND simlettra_used_bytes <= account_used_bytes
            AND remaining_bytes = CASE
                WHEN account_used_bytes >= free_limit_bytes THEN 0
                ELSE free_limit_bytes - account_used_bytes
            END
            AND observed_at IS NOT NULL)
        OR (fetch_status IN ('unavailable', 'permission_denied')
            AND account_used_bytes IS NULL
            AND simlettra_used_bytes IS NULL
            AND remaining_bytes IS NULL
            AND observed_at IS NULL
            AND error_code IS NOT NULL)
    )
);

CREATE INDEX platform_resource_snapshots_latest_index
    ON platform_resource_snapshots (resource_kind, fetched_at DESC, id DESC);

CREATE TRIGGER prevent_platform_resource_snapshot_update
BEFORE UPDATE ON platform_resource_snapshots
BEGIN
    SELECT RAISE(ABORT, '平台资源快照不可修改');
END;

CREATE TABLE platform_capacity_reservations (
    id TEXT PRIMARY KEY NOT NULL,
    platform_resource_snapshot_id TEXT NOT NULL,
    platform_resource_threshold_id TEXT NOT NULL,
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'kv', 'r2')),
    operation_kind TEXT NOT NULL CHECK (
        operation_kind IN ('receive', 'draft_attachment', 'sent_copy', 'migration', 'backup_temporary', 'export_temporary')
    ),
    operation_reference TEXT NOT NULL CHECK (length(operation_reference) > 0),
    estimated_bytes INTEGER NOT NULL CHECK (estimated_bytes > 0),
    safety_margin_bytes INTEGER NOT NULL DEFAULT 0 CHECK (safety_margin_bytes >= 0),
    stop_limit_bytes_snapshot INTEGER NOT NULL CHECK (stop_limit_bytes_snapshot > 0),
    reservation_key_digest BLOB NOT NULL UNIQUE CHECK (length(reservation_key_digest) = 32),
    reservation_status TEXT NOT NULL CHECK (
        reservation_status IN ('reserved', 'committed_pending_snapshot', 'reconciled', 'released', 'expired')
    ),
    expires_at INTEGER NOT NULL,
    committed_at INTEGER,
    reconciled_at INTEGER,
    released_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (expires_at > created_at),
    CHECK (
        (reservation_status = 'reserved' AND committed_at IS NULL AND reconciled_at IS NULL AND released_at IS NULL)
        OR (reservation_status = 'committed_pending_snapshot' AND committed_at IS NOT NULL AND reconciled_at IS NULL AND released_at IS NULL)
        OR (reservation_status = 'reconciled' AND committed_at IS NOT NULL AND reconciled_at IS NOT NULL AND released_at IS NULL)
        OR (reservation_status IN ('released', 'expired') AND reconciled_at IS NULL AND released_at IS NOT NULL)
    ),
    FOREIGN KEY (platform_resource_snapshot_id) REFERENCES platform_resource_snapshots (id) ON DELETE RESTRICT,
    FOREIGN KEY (platform_resource_threshold_id) REFERENCES platform_resource_thresholds (id) ON DELETE RESTRICT
);

CREATE INDEX platform_capacity_reservations_active_index
    ON platform_capacity_reservations (resource_kind, reservation_status, expires_at, id);

CREATE TRIGGER validate_platform_capacity_reservation
BEFORE INSERT ON platform_capacity_reservations
WHEN NEW.reservation_status = 'reserved'
  AND NOT EXISTS (
      SELECT 1
      FROM platform_resource_snapshots AS snapshot
      JOIN platform_resource_thresholds AS threshold
        ON threshold.id = NEW.platform_resource_threshold_id
       AND threshold.resource_kind = NEW.resource_kind
       AND threshold.threshold_status = 'active'
      WHERE snapshot.id = NEW.platform_resource_snapshot_id
        AND snapshot.resource_kind = NEW.resource_kind
        AND snapshot.fetch_status IN ('success', 'stale')
        AND snapshot.account_used_bytes IS NOT NULL
        AND snapshot.free_limit_bytes IS NOT NULL
        AND NEW.stop_limit_bytes_snapshot <= snapshot.free_limit_bytes
        AND snapshot.account_used_bytes
            + COALESCE((
                SELECT SUM(existing.estimated_bytes + existing.safety_margin_bytes)
                FROM platform_capacity_reservations AS existing
                WHERE existing.resource_kind = NEW.resource_kind
                  AND existing.reservation_status IN ('reserved', 'committed_pending_snapshot')
            ), 0)
            + NEW.estimated_bytes
            + NEW.safety_margin_bytes
            <= NEW.stop_limit_bytes_snapshot
  )
BEGIN
    SELECT RAISE(ABORT, '平台免费容量不足、快照不可用或停止策略不匹配');
END;

CREATE TRIGGER validate_platform_capacity_transition
BEFORE UPDATE OF reservation_status ON platform_capacity_reservations
WHEN NOT (
    (OLD.reservation_status = 'reserved'
        AND NEW.reservation_status IN ('committed_pending_snapshot', 'released', 'expired'))
    OR (OLD.reservation_status = 'committed_pending_snapshot'
        AND NEW.reservation_status IN ('reconciled', 'released'))
)
BEGIN
    SELECT RAISE(ABORT, '平台容量预留状态迁移无效');
END;

CREATE TABLE domain_monthly_usage_periods (
    id TEXT PRIMARY KEY NOT NULL,
    mail_domain_id TEXT NOT NULL,
    period_start_at INTEGER NOT NULL,
    period_end_at INTEGER NOT NULL,
    timezone_name TEXT NOT NULL CHECK (length(timezone_name) > 0),
    quota_policy_id TEXT NOT NULL,
    quota_limit_snapshot INTEGER CHECK (quota_limit_snapshot IS NULL OR quota_limit_snapshot >= 1),
    committed_units INTEGER NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
    reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
    unknown_held_units INTEGER NOT NULL DEFAULT 0 CHECK (unknown_held_units >= 0),
    period_status TEXT NOT NULL CHECK (period_status IN ('open', 'closed')),
    closed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (mail_domain_id, period_start_at),
    CHECK (period_end_at > period_start_at),
    CHECK (updated_at >= created_at),
    CHECK (
        (period_status = 'open' AND closed_at IS NULL)
        OR (period_status = 'closed' AND closed_at IS NOT NULL AND closed_at >= period_end_at)
    ),
    FOREIGN KEY (mail_domain_id) REFERENCES mail_domains (id) ON DELETE CASCADE,
    FOREIGN KEY (quota_policy_id) REFERENCES quota_policies (id) ON DELETE RESTRICT
);

CREATE INDEX domain_monthly_usage_periods_open_index
    ON domain_monthly_usage_periods (period_status, period_end_at, mail_domain_id);

CREATE TABLE domain_monthly_usage_reservations (
    id TEXT PRIMARY KEY NOT NULL,
    domain_monthly_usage_period_id TEXT NOT NULL,
    send_recipient_id TEXT NOT NULL UNIQUE,
    usage_status TEXT NOT NULL CHECK (
        usage_status IN ('reserved', 'committed', 'released', 'unknown_held')
    ),
    reserved_at INTEGER NOT NULL,
    committed_at INTEGER,
    released_at INTEGER,
    unknown_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (usage_status = 'reserved' AND committed_at IS NULL AND released_at IS NULL AND unknown_at IS NULL)
        OR (usage_status = 'committed' AND committed_at IS NOT NULL AND released_at IS NULL)
        OR (usage_status = 'released' AND committed_at IS NULL AND released_at IS NOT NULL)
        OR (usage_status = 'unknown_held' AND committed_at IS NULL AND released_at IS NULL AND unknown_at IS NOT NULL)
    ),
    FOREIGN KEY (domain_monthly_usage_period_id) REFERENCES domain_monthly_usage_periods (id) ON DELETE CASCADE,
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE CASCADE
);

CREATE INDEX domain_monthly_usage_reservations_period_index
    ON domain_monthly_usage_reservations (domain_monthly_usage_period_id, usage_status, id);

CREATE TRIGGER validate_domain_monthly_reservation_insert
BEFORE INSERT ON domain_monthly_usage_reservations
WHEN NOT EXISTS (
    SELECT 1
    FROM domain_monthly_usage_periods AS period
    JOIN send_recipients AS recipient ON recipient.id = NEW.send_recipient_id
    JOIN send_operations AS operation ON operation.id = recipient.send_operation_id
    JOIN email_addresses AS sender ON sender.id = operation.sender_address_id
    WHERE period.id = NEW.domain_monthly_usage_period_id
      AND period.period_status = 'open'
      AND sender.domain_id = period.mail_domain_id
      AND (
          period.quota_limit_snapshot IS NULL
          OR period.committed_units + period.reserved_units + period.unknown_held_units + 1
             <= period.quota_limit_snapshot
      )
)
BEGIN
    SELECT RAISE(ABORT, '域名月度发件配额不足或发件域名不匹配');
END;

CREATE TRIGGER apply_domain_monthly_reservation_insert
AFTER INSERT ON domain_monthly_usage_reservations
WHEN NEW.usage_status = 'reserved'
BEGIN
    UPDATE domain_monthly_usage_periods
    SET reserved_units = reserved_units + 1,
        updated_at = NEW.updated_at
    WHERE id = NEW.domain_monthly_usage_period_id;
END;

CREATE TRIGGER validate_domain_monthly_usage_transition
BEFORE UPDATE OF usage_status ON domain_monthly_usage_reservations
WHEN NOT (
    (OLD.usage_status = 'reserved' AND NEW.usage_status IN ('committed', 'released', 'unknown_held'))
    OR (OLD.usage_status = 'unknown_held' AND NEW.usage_status IN ('committed', 'released'))
)
BEGIN
    SELECT RAISE(ABORT, '域名月度用量状态迁移无效');
END;

CREATE TRIGGER apply_domain_monthly_reserved_transition
AFTER UPDATE OF usage_status ON domain_monthly_usage_reservations
WHEN OLD.usage_status = 'reserved'
BEGIN
    UPDATE domain_monthly_usage_periods
    SET reserved_units = reserved_units - 1,
        committed_units = committed_units + CASE WHEN NEW.usage_status = 'committed' THEN 1 ELSE 0 END,
        unknown_held_units = unknown_held_units + CASE WHEN NEW.usage_status = 'unknown_held' THEN 1 ELSE 0 END,
        updated_at = NEW.updated_at
    WHERE id = NEW.domain_monthly_usage_period_id;
END;

CREATE TRIGGER apply_domain_monthly_unknown_transition
AFTER UPDATE OF usage_status ON domain_monthly_usage_reservations
WHEN OLD.usage_status = 'unknown_held'
BEGIN
    UPDATE domain_monthly_usage_periods
    SET unknown_held_units = unknown_held_units - 1,
        committed_units = committed_units + CASE WHEN NEW.usage_status = 'committed' THEN 1 ELSE 0 END,
        updated_at = NEW.updated_at
    WHERE id = NEW.domain_monthly_usage_period_id;
END;

CREATE TABLE audit_events (
    id TEXT PRIMARY KEY NOT NULL,
    occurred_at INTEGER NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'deleted_user')),
    actor_user_id TEXT,
    action_name TEXT NOT NULL CHECK (length(action_name) > 0),
    target_type TEXT NOT NULL CHECK (length(target_type) > 0),
    target_reference TEXT NOT NULL CHECK (length(target_reference) > 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied')),
    reason_code TEXT,
    request_trace_id TEXT NOT NULL CHECK (length(request_trace_id) > 0),
    source_ip_text TEXT,
    browser_family TEXT,
    created_at INTEGER NOT NULL,
    CHECK (
        (actor_type = 'user' AND actor_user_id IS NOT NULL)
        OR (actor_type IN ('system', 'deleted_user'))
    ),
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX audit_events_time_index
    ON audit_events (occurred_at DESC, id DESC);

CREATE INDEX audit_events_target_index
    ON audit_events (target_type, target_reference, occurred_at DESC, id DESC);

CREATE TRIGGER prevent_audit_event_update
BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, '审计事件不可修改');
END;

CREATE TABLE retention_policies (
    id TEXT PRIMARY KEY NOT NULL,
    record_kind TEXT NOT NULL CHECK (
        record_kind IN ('audit', 'task_attempt', 'notification_attempt', 'forward_attempt', 'verification_record')
    ),
    policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
    retention_days INTEGER NOT NULL CHECK (retention_days >= 1),
    policy_status TEXT NOT NULL CHECK (policy_status IN ('active', 'retired')),
    effective_at INTEGER NOT NULL,
    retired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (record_kind, policy_version),
    CHECK (record_kind <> 'audit' OR retention_days BETWEEN 30 AND 365),
    CHECK (
        (policy_status = 'active' AND retired_at IS NULL)
        OR (policy_status = 'retired' AND retired_at IS NOT NULL AND retired_at >= effective_at)
    )
);

CREATE UNIQUE INDEX retention_policies_active_unique
    ON retention_policies (record_kind) WHERE policy_status = 'active';

CREATE TABLE history_cleanup_runs (
    id TEXT PRIMARY KEY NOT NULL,
    retention_policy_id TEXT NOT NULL,
    cutoff_at INTEGER NOT NULL,
    run_status TEXT NOT NULL CHECK (
        run_status IN ('planned', 'running', 'paused', 'failed', 'succeeded', 'cancelled')
    ),
    scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
    deleted_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    last_error_code TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (deleted_count + failed_count <= scanned_count),
    CHECK (run_status NOT IN ('succeeded', 'cancelled') OR completed_at IS NOT NULL),
    FOREIGN KEY (retention_policy_id) REFERENCES retention_policies (id) ON DELETE RESTRICT
);

CREATE TABLE backup_runs (
    id TEXT PRIMARY KEY NOT NULL,
    backup_format_version INTEGER NOT NULL CHECK (backup_format_version >= 1),
    migration_version TEXT NOT NULL CHECK (length(migration_version) > 0),
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
    encryption_mode TEXT NOT NULL CHECK (encryption_mode IN ('authenticated', 'none')),
    encryption_format TEXT,
    kdf_name TEXT,
    backup_status TEXT NOT NULL CHECK (
        backup_status IN ('planned', 'running', 'paused', 'failed', 'succeeded', 'cancelled')
    ),
    table_count INTEGER NOT NULL DEFAULT 0 CHECK (table_count >= 0),
    object_count INTEGER NOT NULL DEFAULT 0 CHECK (object_count >= 0),
    total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
    manifest_sha256 BLOB CHECK (manifest_sha256 IS NULL OR length(manifest_sha256) = 32),
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (encryption_mode = 'authenticated' AND encryption_format IS NOT NULL AND kdf_name IS NOT NULL)
        OR (encryption_mode = 'none' AND encryption_format IS NULL AND kdf_name IS NULL)
    ),
    CHECK (backup_status <> 'succeeded' OR (completed_at IS NOT NULL AND manifest_sha256 IS NOT NULL)),
    CHECK (backup_status NOT IN ('succeeded', 'cancelled') OR completed_at IS NOT NULL)
);

CREATE INDEX backup_runs_status_index
    ON backup_runs (backup_status, created_at DESC, id DESC);

CREATE TABLE backup_checkpoints (
    id TEXT PRIMARY KEY NOT NULL,
    backup_run_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('d1_table', 'object_store')),
    source_name TEXT NOT NULL CHECK (length(source_name) > 0),
    cursor_value TEXT,
    scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
    written_count INTEGER NOT NULL DEFAULT 0 CHECK (written_count >= 0),
    written_bytes INTEGER NOT NULL DEFAULT 0 CHECK (written_bytes >= 0),
    checkpoint_status TEXT NOT NULL CHECK (
        checkpoint_status IN ('pending', 'running', 'completed', 'failed')
    ),
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (backup_run_id, source_kind, source_name),
    CHECK (written_count <= scanned_count),
    FOREIGN KEY (backup_run_id) REFERENCES backup_runs (id) ON DELETE CASCADE
);

CREATE TABLE backup_manifest_entries (
    id TEXT PRIMARY KEY NOT NULL,
    backup_run_id TEXT NOT NULL,
    entry_kind TEXT NOT NULL CHECK (entry_kind IN ('d1_table', 'object')),
    logical_key TEXT NOT NULL CHECK (length(logical_key) > 0),
    row_count INTEGER CHECK (row_count IS NULL OR row_count >= 0),
    size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
    content_sha256 BLOB NOT NULL CHECK (length(content_sha256) = 32),
    created_at INTEGER NOT NULL,
    UNIQUE (backup_run_id, entry_kind, logical_key),
    CHECK (
        (entry_kind = 'd1_table' AND row_count IS NOT NULL)
        OR (entry_kind = 'object' AND size_bytes IS NOT NULL)
    ),
    FOREIGN KEY (backup_run_id) REFERENCES backup_runs (id) ON DELETE CASCADE
);

CREATE TRIGGER prevent_backup_manifest_entry_update
BEFORE UPDATE ON backup_manifest_entries
BEGIN
    SELECT RAISE(ABORT, '备份清单不可修改');
END;

CREATE TABLE backup_required_key_versions (
    backup_run_id TEXT NOT NULL,
    key_purpose TEXT NOT NULL CHECK (key_purpose IN ('config_encryption')),
    key_version INTEGER NOT NULL CHECK (key_version >= 1),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (backup_run_id, key_purpose, key_version),
    FOREIGN KEY (backup_run_id) REFERENCES backup_runs (id) ON DELETE CASCADE
);

CREATE TABLE restore_runs (
    id TEXT PRIMARY KEY NOT NULL,
    source_backup_reference TEXT NOT NULL CHECK (length(source_backup_reference) > 0),
    source_manifest_sha256 BLOB NOT NULL CHECK (length(source_manifest_sha256) = 32),
    target_mode TEXT NOT NULL CHECK (target_mode IN ('empty', 'overwrite')),
    maintenance_mode_enabled INTEGER NOT NULL CHECK (maintenance_mode_enabled IN (0, 1)),
    pre_restore_backup_reference TEXT,
    overwrite_confirmation_digest BLOB CHECK (
        overwrite_confirmation_digest IS NULL OR length(overwrite_confirmation_digest) = 32
    ),
    restore_status TEXT NOT NULL CHECK (
        restore_status IN ('planned', 'validating', 'running', 'failed', 'succeeded', 'cancelled')
    ),
    current_stage TEXT NOT NULL CHECK (
        current_stage IN ('manifest', 'd1', 'objects', 'migrations', 'search', 'final_checks', 'completed')
    ),
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (target_mode = 'empty' AND pre_restore_backup_reference IS NULL AND overwrite_confirmation_digest IS NULL)
        OR (target_mode = 'overwrite'
            AND maintenance_mode_enabled = 1
            AND pre_restore_backup_reference IS NOT NULL
            AND overwrite_confirmation_digest IS NOT NULL)
    ),
    CHECK (restore_status <> 'succeeded' OR (completed_at IS NOT NULL AND current_stage = 'completed'))
);

CREATE TABLE restore_checkpoints (
    id TEXT PRIMARY KEY NOT NULL,
    restore_run_id TEXT NOT NULL,
    stage_kind TEXT NOT NULL CHECK (
        stage_kind IN ('manifest', 'd1', 'objects', 'migrations', 'search', 'final_checks')
    ),
    cursor_value TEXT,
    processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    checkpoint_status TEXT NOT NULL CHECK (
        checkpoint_status IN ('pending', 'running', 'completed', 'failed')
    ),
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (restore_run_id, stage_kind),
    FOREIGN KEY (restore_run_id) REFERENCES restore_runs (id) ON DELETE CASCADE
);

CREATE TABLE restore_checks (
    id TEXT PRIMARY KEY NOT NULL,
    restore_run_id TEXT NOT NULL,
    check_kind TEXT NOT NULL CHECK (
        check_kind IN ('manifest_hash', 'table_counts', 'object_hashes', 'foreign_keys', 'object_references', 'search_rebuild')
    ),
    check_status TEXT NOT NULL CHECK (check_status IN ('pending', 'passed', 'failed')),
    expected_count INTEGER CHECK (expected_count IS NULL OR expected_count >= 0),
    actual_count INTEGER CHECK (actual_count IS NULL OR actual_count >= 0),
    failure_code TEXT,
    checked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (restore_run_id, check_kind),
    CHECK (
        (check_status = 'pending' AND checked_at IS NULL)
        OR (check_status = 'passed' AND checked_at IS NOT NULL AND failure_code IS NULL)
        OR (check_status = 'failed' AND checked_at IS NOT NULL AND failure_code IS NOT NULL)
    ),
    FOREIGN KEY (restore_run_id) REFERENCES restore_runs (id) ON DELETE CASCADE
);

CREATE TRIGGER require_restore_checks_before_success
BEFORE UPDATE OF restore_status ON restore_runs
WHEN NEW.restore_status = 'succeeded'
  AND (
      SELECT COUNT(*) FROM restore_checks
      WHERE restore_run_id = NEW.id AND check_status = 'passed'
  ) <> 6
BEGIN
    SELECT RAISE(ABORT, '恢复检查未全部通过');
END;

CREATE TABLE export_runs (
    id TEXT PRIMARY KEY NOT NULL,
    requested_by_user_id TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('personal', 'organization')),
    organization_id TEXT,
    scope_digest BLOB NOT NULL CHECK (length(scope_digest) = 32),
    frozen_message_count INTEGER NOT NULL CHECK (frozen_message_count >= 0),
    output_format TEXT NOT NULL CHECK (output_format = 'zip_eml'),
    export_status TEXT NOT NULL CHECK (
        export_status IN ('planned', 'running', 'failed', 'succeeded', 'expired', 'deleted')
    ),
    artifact_sha256 BLOB CHECK (artifact_sha256 IS NULL OR length(artifact_sha256) = 32),
    expires_at INTEGER NOT NULL,
    completed_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (scope_type = 'personal' AND organization_id IS NULL)
        OR (scope_type = 'organization' AND organization_id IS NOT NULL)
    ),
    CHECK (expires_at > created_at),
    CHECK (export_status <> 'succeeded' OR (completed_at IS NOT NULL AND artifact_sha256 IS NOT NULL)),
    CHECK (export_status <> 'deleted' OR deleted_at IS NOT NULL),
    FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
);

CREATE TRIGGER validate_organization_export_requester
BEFORE INSERT ON export_runs
WHEN NEW.scope_type = 'organization'
  AND NOT EXISTS (
      SELECT 1 FROM organizations
      WHERE id = NEW.organization_id AND creator_user_id = NEW.requested_by_user_id
  )
BEGIN
    SELECT RAISE(ABORT, '只有组织创建者可以导出组织邮件');
END;

CREATE TABLE export_items (
    id TEXT PRIMARY KEY NOT NULL,
    export_run_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    source_quality TEXT NOT NULL CHECK (source_quality IN ('original_mime', 'reconstructed_structured')),
    item_status TEXT NOT NULL CHECK (item_status IN ('pending', 'written', 'failed')),
    output_size_bytes INTEGER CHECK (output_size_bytes IS NULL OR output_size_bytes >= 0),
    output_sha256 BLOB CHECK (output_sha256 IS NULL OR length(output_sha256) = 32),
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (export_run_id, sequence_number),
    UNIQUE (export_run_id, message_id),
    CHECK (
        item_status <> 'written'
        OR (output_size_bytes IS NOT NULL AND output_sha256 IS NOT NULL AND error_code IS NULL)
    ),
    CHECK (item_status <> 'failed' OR error_code IS NOT NULL),
    FOREIGN KEY (export_run_id) REFERENCES export_runs (id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT
);

CREATE TRIGGER validate_export_item_scope
BEFORE INSERT ON export_items
WHEN NOT EXISTS (
    SELECT 1
    FROM export_runs AS run
    WHERE run.id = NEW.export_run_id
      AND (
          (run.scope_type = 'personal' AND EXISTS (
              SELECT 1 FROM mailbox_entries AS entry
              WHERE entry.message_id = NEW.message_id
                AND entry.mailbox_type = 'user'
                AND entry.user_id = run.requested_by_user_id
          ))
          OR (run.scope_type = 'organization' AND EXISTS (
              SELECT 1 FROM mailbox_entries AS entry
              WHERE entry.message_id = NEW.message_id
                AND entry.mailbox_type = 'organization'
                AND entry.organization_id = run.organization_id
          ))
      )
)
BEGIN
    SELECT RAISE(ABORT, '导出邮件不属于冻结授权范围');
END;

CREATE TABLE migration_runs (
    id TEXT PRIMARY KEY NOT NULL,
    run_mode TEXT NOT NULL CHECK (run_mode IN ('rehearsal', 'formal')),
    source_system TEXT NOT NULL CHECK (length(source_system) > 0),
    source_version TEXT NOT NULL CHECK (length(source_version) > 0),
    source_reference_commit TEXT NOT NULL CHECK (length(source_reference_commit) > 0),
    source_snapshot_sha256 BLOB NOT NULL CHECK (length(source_snapshot_sha256) = 32),
    migration_rules_version INTEGER NOT NULL CHECK (migration_rules_version >= 1),
    target_version TEXT NOT NULL CHECK (length(target_version) > 0),
    rehearsal_run_id TEXT,
    run_status TEXT NOT NULL CHECK (
        run_status IN ('planned', 'running', 'paused', 'failed', 'succeeded', 'cancelled')
    ),
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (run_mode = 'rehearsal' AND rehearsal_run_id IS NULL)
        OR (run_mode = 'formal' AND rehearsal_run_id IS NOT NULL)
    ),
    CHECK (run_status NOT IN ('succeeded', 'cancelled') OR completed_at IS NOT NULL),
    FOREIGN KEY (rehearsal_run_id) REFERENCES migration_runs (id) ON DELETE RESTRICT
);

CREATE INDEX migration_runs_source_index
    ON migration_runs (source_system, source_snapshot_sha256, run_mode, created_at, id);

CREATE TRIGGER validate_formal_migration_rehearsal
BEFORE INSERT ON migration_runs
WHEN NEW.run_mode = 'formal'
  AND NOT EXISTS (
      SELECT 1 FROM migration_runs AS rehearsal
      WHERE rehearsal.id = NEW.rehearsal_run_id
        AND rehearsal.run_mode = 'rehearsal'
        AND rehearsal.run_status = 'succeeded'
        AND rehearsal.source_system = NEW.source_system
        AND rehearsal.source_version = NEW.source_version
        AND rehearsal.source_reference_commit = NEW.source_reference_commit
        AND rehearsal.source_snapshot_sha256 = NEW.source_snapshot_sha256
        AND rehearsal.migration_rules_version = NEW.migration_rules_version
  )
BEGIN
    SELECT RAISE(ABORT, '正式迁移缺少同来源同规则的成功演练');
END;

CREATE TABLE migration_checkpoints (
    id TEXT PRIMARY KEY NOT NULL,
    migration_run_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (
        entity_type IN ('user', 'domain', 'address', 'message', 'body', 'attachment', 'star')
    ),
    cursor_value TEXT,
    scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
    succeeded_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
    skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    checkpoint_status TEXT NOT NULL CHECK (
        checkpoint_status IN ('pending', 'running', 'completed', 'failed')
    ),
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (migration_run_id, entity_type),
    CHECK (succeeded_count + skipped_count + failed_count <= scanned_count),
    FOREIGN KEY (migration_run_id) REFERENCES migration_runs (id) ON DELETE CASCADE
);

CREATE TABLE migration_source_mappings (
    id TEXT PRIMARY KEY NOT NULL,
    source_system TEXT NOT NULL CHECK (length(source_system) > 0),
    source_snapshot_sha256 BLOB NOT NULL CHECK (length(source_snapshot_sha256) = 32),
    source_entity_type TEXT NOT NULL CHECK (length(source_entity_type) > 0),
    source_entity_id TEXT NOT NULL CHECK (length(source_entity_id) > 0),
    source_content_sha256 BLOB CHECK (source_content_sha256 IS NULL OR length(source_content_sha256) = 32),
    target_entity_type TEXT NOT NULL CHECK (length(target_entity_type) > 0),
    target_entity_reference TEXT NOT NULL CHECK (length(target_entity_reference) > 0),
    created_by_migration_run_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (source_system, source_snapshot_sha256, source_entity_type, source_entity_id),
    FOREIGN KEY (created_by_migration_run_id) REFERENCES migration_runs (id) ON DELETE RESTRICT
);

CREATE TRIGGER prevent_migration_source_mapping_update
BEFORE UPDATE ON migration_source_mappings
BEGIN
    SELECT RAISE(ABORT, '迁移来源映射不可修改');
END;

CREATE TABLE migration_failures (
    id TEXT PRIMARY KEY NOT NULL,
    migration_run_id TEXT NOT NULL,
    source_entity_type TEXT NOT NULL CHECK (length(source_entity_type) > 0),
    source_entity_id TEXT NOT NULL CHECK (length(source_entity_id) > 0),
    failure_code TEXT NOT NULL CHECK (length(failure_code) > 0),
    failure_summary TEXT NOT NULL CHECK (length(failure_summary) > 0),
    failure_status TEXT NOT NULL CHECK (failure_status IN ('pending', 'resolved', 'skipped')),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    first_failed_at INTEGER NOT NULL,
    resolved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (migration_run_id, source_entity_type, source_entity_id, failure_code),
    CHECK (
        (failure_status = 'pending' AND resolved_at IS NULL)
        OR (failure_status IN ('resolved', 'skipped') AND resolved_at IS NOT NULL)
    ),
    FOREIGN KEY (migration_run_id) REFERENCES migration_runs (id) ON DELETE CASCADE
);

CREATE TABLE migration_reconciliations (
    id TEXT PRIMARY KEY NOT NULL,
    migration_run_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (
        entity_type IN ('user', 'domain', 'address', 'message', 'body', 'attachment', 'star')
    ),
    expected_count INTEGER NOT NULL CHECK (expected_count >= 0),
    scanned_count INTEGER NOT NULL CHECK (scanned_count >= 0),
    succeeded_count INTEGER NOT NULL CHECK (succeeded_count >= 0),
    skipped_count INTEGER NOT NULL CHECK (skipped_count >= 0),
    failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
    reconciliation_status TEXT NOT NULL CHECK (
        reconciliation_status IN ('pending', 'matched', 'mismatch')
    ),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (migration_run_id, entity_type),
    CHECK (succeeded_count + skipped_count + failed_count = scanned_count),
    CHECK (
        (reconciliation_status = 'matched' AND expected_count = scanned_count AND failed_count = 0)
        OR reconciliation_status IN ('pending', 'mismatch')
    ),
    FOREIGN KEY (migration_run_id) REFERENCES migration_runs (id) ON DELETE CASCADE
);

CREATE TABLE migrated_message_sources (
    message_id TEXT PRIMARY KEY NOT NULL,
    migration_run_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL CHECK (length(source_message_id) > 0),
    source_quality TEXT NOT NULL CHECK (source_quality IN ('raw_mime', 'structured_rebuilt')),
    original_mime_sha256 BLOB CHECK (original_mime_sha256 IS NULL OR length(original_mime_sha256) = 32),
    reconstruction_version TEXT,
    created_at INTEGER NOT NULL,
    CHECK (
        (source_quality = 'raw_mime' AND original_mime_sha256 IS NOT NULL AND reconstruction_version IS NULL)
        OR (source_quality = 'structured_rebuilt' AND original_mime_sha256 IS NULL AND reconstruction_version IS NOT NULL)
    ),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
    FOREIGN KEY (migration_run_id) REFERENCES migration_runs (id) ON DELETE RESTRICT
);

CREATE TRIGGER validate_migrated_message_source
BEFORE INSERT ON migrated_message_sources
WHEN NOT EXISTS (
    SELECT 1 FROM messages
    WHERE id = NEW.message_id AND origin_type = 'migrated'
)
BEGIN
    SELECT RAISE(ABORT, '迁移来源只能关联迁移邮件');
END;

CREATE TABLE migration_user_password_results (
    migration_run_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source_user_id TEXT NOT NULL CHECK (length(source_user_id) > 0),
    password_result TEXT NOT NULL CHECK (
        password_result IN ('compatible_preserved', 'reset_required', 'upgraded', 'missing')
    ),
    source_algorithm TEXT,
    source_parameters_digest BLOB CHECK (
        source_parameters_digest IS NULL OR length(source_parameters_digest) = 32
    ),
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (migration_run_id, user_id),
    CHECK (
        password_result NOT IN ('compatible_preserved', 'upgraded')
        OR source_algorithm IS NOT NULL
    ),
    FOREIGN KEY (migration_run_id) REFERENCES migration_runs (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
