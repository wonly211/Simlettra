-- 澄笺 | Simlettra 管理员备份与恢复正式迁移
-- 依据：需求 11.10、11.11，已接受 ADR 0013、0033，以及第六批数据模型。

PRAGMA foreign_keys = ON;

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
    last_error_code TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (encryption_mode = 'authenticated' AND encryption_format IS NOT NULL AND kdf_name IS NOT NULL)
        OR (encryption_mode = 'none' AND encryption_format IS NULL AND kdf_name IS NULL)
    ),
    CHECK (
        (backup_status = 'succeeded'
            AND completed_at IS NOT NULL AND manifest_sha256 IS NOT NULL AND last_error_code IS NULL)
        OR (backup_status = 'failed' AND completed_at IS NOT NULL AND last_error_code IS NOT NULL)
        OR (backup_status = 'cancelled' AND completed_at IS NOT NULL)
        OR (backup_status IN ('planned', 'running', 'paused') AND completed_at IS NULL)
    )
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
    CHECK (updated_at >= created_at),
    CHECK (written_count <= scanned_count),
    CHECK (
        (checkpoint_status = 'failed' AND last_error_code IS NOT NULL)
        OR (checkpoint_status <> 'failed' AND last_error_code IS NULL)
    ),
    FOREIGN KEY (backup_run_id) REFERENCES backup_runs (id) ON DELETE CASCADE
);

CREATE INDEX backup_checkpoints_run_status_index
    ON backup_checkpoints (backup_run_id, checkpoint_status, source_kind, source_name);

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
        (entry_kind = 'd1_table' AND row_count IS NOT NULL AND size_bytes IS NOT NULL)
        OR (entry_kind = 'object' AND row_count IS NULL AND size_bytes IS NOT NULL)
    ),
    FOREIGN KEY (backup_run_id) REFERENCES backup_runs (id) ON DELETE CASCADE
);

CREATE INDEX backup_manifest_entries_run_index
    ON backup_manifest_entries (backup_run_id, entry_kind, logical_key);

CREATE TRIGGER prevent_backup_manifest_entry_update
BEFORE UPDATE ON backup_manifest_entries
BEGIN
    SELECT RAISE(ABORT, '备份清单不可修改');
END;

CREATE TABLE backup_required_key_versions (
    backup_run_id TEXT NOT NULL,
    key_purpose TEXT NOT NULL CHECK (key_purpose = 'config_encryption'),
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
    last_error_code TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (target_mode = 'empty'
            AND maintenance_mode_enabled = 0
            AND pre_restore_backup_reference IS NULL
            AND overwrite_confirmation_digest IS NULL)
        OR (target_mode = 'overwrite'
            AND maintenance_mode_enabled = 1
            AND pre_restore_backup_reference IS NOT NULL
            AND overwrite_confirmation_digest IS NOT NULL)
    ),
    CHECK (
        (restore_status = 'succeeded'
            AND completed_at IS NOT NULL AND current_stage = 'completed' AND last_error_code IS NULL)
        OR (restore_status = 'failed' AND completed_at IS NOT NULL AND last_error_code IS NOT NULL)
        OR (restore_status = 'cancelled' AND completed_at IS NOT NULL)
        OR (restore_status IN ('planned', 'validating', 'running') AND completed_at IS NULL)
    )
);

CREATE INDEX restore_runs_status_index
    ON restore_runs (restore_status, created_at DESC, id DESC);

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
    CHECK (updated_at >= created_at),
    CHECK (
        (checkpoint_status = 'failed' AND last_error_code IS NOT NULL)
        OR (checkpoint_status <> 'failed' AND last_error_code IS NULL)
    ),
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
    CHECK (updated_at >= created_at),
    CHECK (
        (check_status = 'pending' AND checked_at IS NULL AND failure_code IS NULL)
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
