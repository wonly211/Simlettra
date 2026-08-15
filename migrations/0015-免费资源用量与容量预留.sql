PRAGMA foreign_keys = ON;

CREATE TABLE cloudflare_resource_configurations (
    singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
    account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 16 AND 64),
    d1_database_id TEXT NOT NULL CHECK (length(d1_database_id) BETWEEN 16 AND 64),
    storage_resource_reference TEXT NOT NULL CHECK (length(storage_resource_reference) BETWEEN 1 AND 256),
    api_token_ciphertext BLOB NOT NULL CHECK (length(api_token_ciphertext) > 0),
    api_token_nonce BLOB NOT NULL CHECK (length(api_token_nonce) = 12),
    credential_algorithm TEXT NOT NULL CHECK (credential_algorithm = 'AES-GCM-256'),
    credential_key_version INTEGER NOT NULL CHECK (credential_key_version >= 1),
    configuration_version INTEGER NOT NULL CHECK (configuration_version >= 1),
    configuration_status TEXT NOT NULL CHECK (configuration_status IN ('active', 'deleted')),
    last_tested_at INTEGER,
    last_test_result TEXT CHECK (last_test_result IS NULL OR last_test_result IN ('success', 'failed')),
    last_test_summary TEXT,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (configuration_status = 'active' AND deleted_at IS NULL)
        OR (configuration_status = 'deleted' AND deleted_at IS NOT NULL)
    )
);

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

INSERT INTO platform_resource_thresholds (
    id, resource_kind, threshold_version, warning_ratio_bps, stop_ratio_bps,
    threshold_status, effective_at, retired_at, created_at, updated_at
) VALUES
    ('00000000-0000-4000-8000-000000000151', 'd1', 1, 8000, 9500, 'active', 0, NULL, 0, 0),
    ('00000000-0000-4000-8000-000000000152', 'kv', 1, 8000, 9500, 'active', 0, NULL, 0, 0),
    ('00000000-0000-4000-8000-000000000153', 'r2', 1, 8000, 9500, 'active', 0, NULL, 0, 0);

CREATE TABLE platform_resource_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'kv', 'r2')),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account', 'local_only')),
    scope_reference TEXT NOT NULL CHECK (length(scope_reference) > 0),
    free_limit_bytes INTEGER NOT NULL CHECK (free_limit_bytes > 0),
    current_resource_limit_bytes INTEGER NOT NULL CHECK (current_resource_limit_bytes > 0),
    account_used_bytes INTEGER CHECK (account_used_bytes IS NULL OR account_used_bytes >= 0),
    simlettra_used_bytes INTEGER CHECK (simlettra_used_bytes IS NULL OR simlettra_used_bytes >= 0),
    remaining_bytes INTEGER CHECK (remaining_bytes IS NULL OR remaining_bytes >= 0),
    current_resource_remaining_bytes INTEGER CHECK (
        current_resource_remaining_bytes IS NULL OR current_resource_remaining_bytes >= 0
    ),
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
            AND account_used_bytes IS NOT NULL
            AND simlettra_used_bytes IS NOT NULL
            AND remaining_bytes IS NOT NULL
            AND simlettra_used_bytes <= account_used_bytes
            AND remaining_bytes = CASE
                WHEN account_used_bytes >= free_limit_bytes THEN 0
                ELSE free_limit_bytes - account_used_bytes
            END
            AND current_resource_remaining_bytes = CASE
                WHEN simlettra_used_bytes >= current_resource_limit_bytes THEN 0
                ELSE current_resource_limit_bytes - simlettra_used_bytes
            END
            AND observed_at IS NOT NULL
        )
        OR (fetch_status IN ('unavailable', 'permission_denied')
            AND account_used_bytes IS NULL
            AND simlettra_used_bytes IS NULL
            AND remaining_bytes IS NULL
            AND current_resource_remaining_bytes IS NULL
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
        operation_kind IN ('receive', 'draft_attachment', 'sent_copy')
    ),
    operation_reference TEXT NOT NULL CHECK (length(operation_reference) > 0),
    estimated_bytes INTEGER NOT NULL CHECK (estimated_bytes > 0),
    safety_margin_bytes INTEGER NOT NULL DEFAULT 0 CHECK (safety_margin_bytes >= 0),
    stop_limit_bytes_snapshot INTEGER NOT NULL CHECK (stop_limit_bytes_snapshot > 0),
    current_resource_stop_limit_bytes_snapshot INTEGER NOT NULL CHECK (
        current_resource_stop_limit_bytes_snapshot > 0
    ),
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

CREATE INDEX platform_capacity_reservations_operation_index
    ON platform_capacity_reservations (operation_kind, operation_reference, resource_kind);

CREATE UNIQUE INDEX platform_capacity_reservations_active_operation_unique
    ON platform_capacity_reservations (operation_kind, operation_reference, resource_kind)
    WHERE reservation_status IN ('reserved', 'committed_pending_snapshot');

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
        AND snapshot.simlettra_used_bytes IS NOT NULL
        AND NEW.stop_limit_bytes_snapshot <= snapshot.free_limit_bytes
        AND NEW.current_resource_stop_limit_bytes_snapshot <= snapshot.current_resource_limit_bytes
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
        AND snapshot.simlettra_used_bytes
            + COALESCE((
                SELECT SUM(existing.estimated_bytes + existing.safety_margin_bytes)
                FROM platform_capacity_reservations AS existing
                WHERE existing.resource_kind = NEW.resource_kind
                  AND existing.reservation_status IN ('reserved', 'committed_pending_snapshot')
            ), 0)
            + NEW.estimated_bytes
            + NEW.safety_margin_bytes
            <= NEW.current_resource_stop_limit_bytes_snapshot
  )
BEGIN
    SELECT RAISE(ABORT, '平台免费容量不足、快照不可用或停止策略不匹配');
END;

CREATE TRIGGER prevent_platform_capacity_identity_change
BEFORE UPDATE OF
    platform_resource_snapshot_id, platform_resource_threshold_id, resource_kind,
    operation_kind, operation_reference, estimated_bytes, safety_margin_bytes,
    stop_limit_bytes_snapshot, current_resource_stop_limit_bytes_snapshot,
    reservation_key_digest, created_at
ON platform_capacity_reservations
BEGIN
    SELECT RAISE(ABORT, '平台容量预留身份与策略快照不可修改');
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
