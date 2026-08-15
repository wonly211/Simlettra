-- 澄笺 | Simlettra 用户与组织邮件导出正式迁移
-- 依据：需求 11.12，已接受 ADR 0033，以及第二十三批纵向切片验收规则。

PRAGMA foreign_keys = ON;

-- 扩展平台容量预留，使临时导出制品也受 Cloudflare 免费资源停止线保护。
DROP TRIGGER validate_platform_capacity_reservation;
DROP TRIGGER prevent_platform_capacity_identity_change;
DROP TRIGGER validate_platform_capacity_transition;

CREATE TABLE platform_capacity_reservations_before_exports AS
SELECT * FROM platform_capacity_reservations;

DROP TABLE platform_capacity_reservations;

CREATE TABLE platform_capacity_reservations (
    id TEXT PRIMARY KEY NOT NULL,
    platform_resource_snapshot_id TEXT NOT NULL,
    platform_resource_threshold_id TEXT NOT NULL,
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'kv', 'r2')),
    operation_kind TEXT NOT NULL CHECK (
        operation_kind IN ('receive', 'draft_attachment', 'sent_copy', 'mail_export')
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

INSERT INTO platform_capacity_reservations
SELECT * FROM platform_capacity_reservations_before_exports;

DROP TABLE platform_capacity_reservations_before_exports;

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
            + NEW.estimated_bytes + NEW.safety_margin_bytes
            <= NEW.stop_limit_bytes_snapshot
        AND snapshot.simlettra_used_bytes
            + COALESCE((
                SELECT SUM(existing.estimated_bytes + existing.safety_margin_bytes)
                FROM platform_capacity_reservations AS existing
                WHERE existing.resource_kind = NEW.resource_kind
                  AND existing.reservation_status IN ('reserved', 'committed_pending_snapshot')
            ), 0)
            + NEW.estimated_bytes + NEW.safety_margin_bytes
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

CREATE TABLE export_runs (
    id TEXT PRIMARY KEY NOT NULL,
    requested_by_user_id TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('personal', 'organization')),
    organization_id TEXT,
    scope_digest BLOB NOT NULL CHECK (length(scope_digest) = 32),
    frozen_message_count INTEGER NOT NULL CHECK (frozen_message_count >= 0),
    output_format TEXT NOT NULL DEFAULT 'zip_eml' CHECK (output_format = 'zip_eml'),
    export_status TEXT NOT NULL CHECK (
        export_status IN ('planned', 'running', 'failed', 'succeeded', 'expired', 'deleted')
    ),
    artifact_count INTEGER NOT NULL DEFAULT 0 CHECK (artifact_count >= 0),
    completed_at INTEGER,
    expires_at INTEGER NOT NULL,
    deleted_at INTEGER,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (scope_type = 'personal' AND organization_id IS NULL)
        OR (scope_type = 'organization' AND organization_id IS NOT NULL)
    ),
    CHECK (expires_at > created_at),
    CHECK (updated_at >= created_at),
    CHECK (
        (export_status = 'succeeded' AND completed_at IS NOT NULL AND artifact_count > 0 AND last_error_code IS NULL)
        OR (export_status = 'failed' AND completed_at IS NULL AND last_error_code IS NOT NULL)
        OR (export_status = 'deleted' AND deleted_at IS NOT NULL)
        OR (export_status IN ('planned', 'running', 'expired') AND completed_at IS NULL)
    ),
    FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX export_runs_requester_index
    ON export_runs (requested_by_user_id, created_at DESC, id DESC);

CREATE INDEX export_runs_expiry_index
    ON export_runs (export_status, expires_at, id);

CREATE TRIGGER validate_organization_export_requester
BEFORE INSERT ON export_runs
WHEN NEW.scope_type = 'organization'
  AND NOT EXISTS (
      SELECT 1 FROM organizations
      WHERE id = NEW.organization_id
        AND creator_user_id = NEW.requested_by_user_id
        AND status = 'active'
  )
BEGIN
    SELECT RAISE(ABORT, '只有当前组织创建者可以导出组织邮件');
END;

CREATE TABLE export_items (
    id TEXT PRIMARY KEY NOT NULL,
    export_run_id TEXT NOT NULL,
    mailbox_entry_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
    source_quality TEXT NOT NULL CHECK (
        source_quality IN ('original_mime', 'reconstructed_structured')
    ),
    source_object_id TEXT,
    item_status TEXT NOT NULL CHECK (item_status IN ('pending', 'written', 'failed')),
    artifact_sequence_number INTEGER,
    output_file_name TEXT,
    output_size_bytes INTEGER CHECK (output_size_bytes IS NULL OR output_size_bytes >= 0),
    output_sha256 BLOB CHECK (output_sha256 IS NULL OR length(output_sha256) = 32),
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (export_run_id, sequence_number),
    UNIQUE (export_run_id, mailbox_entry_id),
    CHECK (updated_at >= created_at),
    CHECK (
        (source_quality = 'original_mime' AND source_object_id IS NOT NULL)
        OR source_quality = 'reconstructed_structured'
    ),
    CHECK (
        (item_status = 'pending'
            AND artifact_sequence_number IS NULL AND output_file_name IS NULL
            AND output_size_bytes IS NULL AND output_sha256 IS NULL AND error_code IS NULL)
        OR (item_status = 'written'
            AND artifact_sequence_number IS NOT NULL AND output_file_name IS NOT NULL
            AND output_size_bytes IS NOT NULL AND output_sha256 IS NOT NULL AND error_code IS NULL)
        OR (item_status = 'failed' AND error_code IS NOT NULL)
    ),
    FOREIGN KEY (export_run_id) REFERENCES export_runs (id) ON DELETE CASCADE
);

CREATE INDEX export_items_run_status_index
    ON export_items (export_run_id, item_status, sequence_number);

CREATE UNIQUE INDEX export_items_run_message_unique
    ON export_items (export_run_id, message_id);

CREATE TRIGGER validate_export_item_scope
BEFORE INSERT ON export_items
WHEN NOT EXISTS (
    SELECT 1
    FROM export_runs AS run
    JOIN mailbox_entries AS entry ON entry.id = NEW.mailbox_entry_id
    WHERE run.id = NEW.export_run_id
      AND entry.message_id = NEW.message_id
      AND (
          (run.scope_type = 'personal'
              AND entry.mailbox_type = 'user'
              AND entry.user_id = run.requested_by_user_id)
          OR (run.scope_type = 'organization'
              AND entry.mailbox_type = 'organization'
              AND entry.organization_id = run.organization_id)
      )
)
BEGIN
    SELECT RAISE(ABORT, '导出邮件不属于冻结授权范围');
END;

CREATE TABLE export_artifacts (
    id TEXT PRIMARY KEY NOT NULL,
    export_run_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
    object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) > 0),
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
    file_name TEXT NOT NULL CHECK (length(file_name) > 0),
    media_type TEXT NOT NULL CHECK (media_type = 'application/zip'),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256 BLOB NOT NULL CHECK (length(sha256) = 32),
    backend_version_reference TEXT,
    artifact_status TEXT NOT NULL CHECK (
        artifact_status IN ('stored', 'active', 'pending_delete', 'deleted')
    ),
    stored_at INTEGER NOT NULL,
    activated_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (export_run_id, sequence_number),
    CHECK (updated_at >= created_at),
    CHECK (artifact_status <> 'active' OR activated_at IS NOT NULL),
    CHECK (artifact_status <> 'deleted' OR deleted_at IS NOT NULL),
    FOREIGN KEY (export_run_id) REFERENCES export_runs (id) ON DELETE CASCADE
);

CREATE INDEX export_artifacts_run_index
    ON export_artifacts (export_run_id, artifact_status, sequence_number);

CREATE TRIGGER prevent_export_artifact_identity_change
BEFORE UPDATE OF
    export_run_id, sequence_number, object_key, storage_mode, file_name,
    media_type, size_bytes, sha256, stored_at, created_at
ON export_artifacts
BEGIN
    SELECT RAISE(ABORT, '导出制品身份与内容摘要不可修改');
END;

CREATE TRIGGER validate_export_run_success
BEFORE UPDATE OF export_status ON export_runs
WHEN NEW.export_status = 'succeeded'
  AND (
      NEW.artifact_count = 0
      OR NEW.artifact_count <> (
          SELECT COUNT(*) FROM export_artifacts
          WHERE export_run_id = NEW.id AND artifact_status = 'active'
      )
      OR EXISTS (
          SELECT 1 FROM export_items
          WHERE export_run_id = NEW.id AND item_status <> 'written'
      )
  )
BEGIN
    SELECT RAISE(ABORT, '导出项目或制品尚未全部完成');
END;
