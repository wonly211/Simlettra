-- 澄笺 | Simlettra 旧系统数据迁移正式迁移
-- 依据：需求 11.01 至 11.06，已接受 ADR 0033、0041，以及第六批数据模型。

PRAGMA foreign_keys = ON;

-- 收信邮件需要原始 MIME，系统生成邮件需要最终 MIME；只有迁移邮件可以使用完整的结构化正文和附件。
DROP TRIGGER validate_message_ready_insert;

CREATE TRIGGER validate_message_ready_insert
BEFORE INSERT ON message_integrity_states
WHEN NEW.integrity_status = 'ready'
AND (
    NEW.source_completeness NOT IN ('raw_mime', 'final_mime', 'structured_only')
    OR (
        NEW.source_completeness = 'raw_mime'
        AND NOT EXISTS (
            SELECT 1 FROM object_registry
            WHERE message_id = NEW.message_id AND object_role = 'raw_mime'
              AND is_current = 1 AND object_status = 'active'
        )
    )
    OR (
        NEW.source_completeness = 'final_mime'
        AND NOT EXISTS (
            SELECT 1 FROM object_registry
            WHERE message_id = NEW.message_id AND object_role = 'final_mime'
              AND is_current = 1 AND object_status = 'active'
        )
    )
    OR (
        NEW.source_completeness = 'structured_only'
        AND NOT EXISTS (
            SELECT 1 FROM messages
            WHERE id = NEW.message_id AND origin_type = 'migrated'
        )
    )
    OR NOT EXISTS (
        SELECT 1 FROM object_registry
        WHERE message_id = NEW.message_id AND object_role IN ('plain_body', 'html_body')
          AND is_current = 1 AND object_status = 'active'
    )
    OR EXISTS (
        SELECT 1 FROM object_registry
        WHERE message_id = NEW.message_id AND required_for_visibility = 1
          AND (is_current <> 1 OR object_status <> 'active')
    )
    OR (
        SELECT attachment_count FROM messages WHERE id = NEW.message_id
    ) <> (
        SELECT COUNT(*) FROM object_registry
        WHERE message_id = NEW.message_id AND object_role = 'attachment'
          AND is_current = 1 AND object_status = 'active'
    )
)
BEGIN
    SELECT RAISE(ABORT, '邮件必要对象尚未完整，不能进入就绪状态');
END;

CREATE TABLE migration_runs (
    id TEXT PRIMARY KEY NOT NULL,
    run_mode TEXT NOT NULL CHECK (run_mode IN ('rehearsal', 'formal')),
    source_system TEXT NOT NULL CHECK (length(source_system) > 0),
    source_version TEXT NOT NULL CHECK (length(source_version) > 0),
    source_reference_commit TEXT NOT NULL CHECK (length(source_reference_commit) > 0),
    source_snapshot_sha256 BLOB NOT NULL CHECK (length(source_snapshot_sha256) = 32),
    snapshot_format_version INTEGER NOT NULL CHECK (snapshot_format_version >= 1),
    migration_rules_version INTEGER NOT NULL CHECK (migration_rules_version >= 1),
    target_version TEXT NOT NULL CHECK (length(target_version) > 0),
    rehearsal_run_id TEXT,
    rehearsal_report_sha256 BLOB CHECK (
        rehearsal_report_sha256 IS NULL OR length(rehearsal_report_sha256) = 32
    ),
    run_status TEXT NOT NULL CHECK (
        run_status IN ('planned', 'running', 'paused', 'failed', 'succeeded', 'cancelled')
    ),
    last_error_code TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (run_mode = 'rehearsal'
            AND rehearsal_run_id IS NULL AND rehearsal_report_sha256 IS NULL)
        OR (run_mode = 'formal'
            AND rehearsal_run_id IS NOT NULL AND rehearsal_report_sha256 IS NOT NULL)
    ),
    CHECK (
        (run_status = 'succeeded'
            AND completed_at IS NOT NULL AND last_error_code IS NULL)
        OR (run_status = 'failed'
            AND completed_at IS NOT NULL AND last_error_code IS NOT NULL)
        OR (run_status = 'cancelled' AND completed_at IS NOT NULL)
        OR (run_status IN ('planned', 'running', 'paused') AND completed_at IS NULL)
    ),
    FOREIGN KEY (rehearsal_run_id) REFERENCES migration_runs (id) ON DELETE RESTRICT
);

CREATE INDEX migration_runs_source_index
    ON migration_runs (
        source_system, source_snapshot_sha256, migration_rules_version,
        run_mode, created_at DESC, id DESC
    );

CREATE INDEX migration_runs_status_index
    ON migration_runs (run_status, updated_at, id);

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
        AND rehearsal.snapshot_format_version = NEW.snapshot_format_version
        AND rehearsal.migration_rules_version = NEW.migration_rules_version
        AND rehearsal.target_version = NEW.target_version
  )
BEGIN
    SELECT RAISE(ABORT, '正式迁移缺少同来源同规则的成功演练');
END;

CREATE TRIGGER prevent_migration_run_identity_change
BEFORE UPDATE OF
    run_mode, source_system, source_version, source_reference_commit,
    source_snapshot_sha256, snapshot_format_version, migration_rules_version,
    target_version, rehearsal_run_id, rehearsal_report_sha256, created_at
ON migration_runs
BEGIN
    SELECT RAISE(ABORT, '迁移运行身份不可修改');
END;

CREATE TRIGGER validate_migration_run_transition
BEFORE UPDATE OF run_status ON migration_runs
WHEN NEW.run_status <> OLD.run_status
AND NOT (
    (OLD.run_status = 'planned' AND NEW.run_status IN ('running', 'cancelled'))
    OR (OLD.run_status = 'running' AND NEW.run_status IN ('paused', 'failed', 'succeeded', 'cancelled'))
    OR (OLD.run_status = 'paused' AND NEW.run_status IN ('running', 'failed', 'cancelled'))
    OR (OLD.run_status = 'failed' AND NEW.run_status = 'running')
)
BEGIN
    SELECT RAISE(ABORT, '迁移运行状态不能倒退或跳过必要阶段');
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
    CHECK (updated_at >= created_at),
    CHECK (succeeded_count + skipped_count + failed_count <= scanned_count),
    CHECK (
        (checkpoint_status = 'failed' AND last_error_code IS NOT NULL)
        OR (checkpoint_status <> 'failed' AND last_error_code IS NULL)
    ),
    FOREIGN KEY (migration_run_id) REFERENCES migration_runs (id) ON DELETE CASCADE
);

CREATE INDEX migration_checkpoints_run_index
    ON migration_checkpoints (migration_run_id, checkpoint_status, entity_type);

CREATE TABLE migration_source_mappings (
    id TEXT PRIMARY KEY NOT NULL,
    source_system TEXT NOT NULL CHECK (length(source_system) > 0),
    source_snapshot_sha256 BLOB NOT NULL CHECK (length(source_snapshot_sha256) = 32),
    source_entity_type TEXT NOT NULL CHECK (length(source_entity_type) > 0),
    source_entity_id TEXT NOT NULL CHECK (length(source_entity_id) > 0),
    source_content_sha256 BLOB CHECK (
        source_content_sha256 IS NULL OR length(source_content_sha256) = 32
    ),
    target_entity_type TEXT NOT NULL CHECK (length(target_entity_type) > 0),
    target_entity_reference TEXT NOT NULL CHECK (length(target_entity_reference) > 0),
    created_by_migration_run_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (source_system, source_snapshot_sha256, source_entity_type, source_entity_id),
    FOREIGN KEY (created_by_migration_run_id) REFERENCES migration_runs (id) ON DELETE RESTRICT
);

CREATE INDEX migration_source_mappings_target_index
    ON migration_source_mappings (target_entity_type, target_entity_reference);

CREATE TRIGGER prevent_migration_source_mapping_update
BEFORE UPDATE ON migration_source_mappings
BEGIN
    SELECT RAISE(ABORT, '迁移来源映射不可修改');
END;

-- 历史地址已经由迁移工具按当前 ASCII、统一小写和 IDNA 规则校验。
-- 它们仍受地址唯一性与结构约束保护，但不受部署者后来设置的“新地址申请策略”影响。
DROP TRIGGER validate_new_email_address_policy;

CREATE TRIGGER validate_new_email_address_policy
BEFORE INSERT ON email_addresses
WHEN NOT EXISTS (
    SELECT 1 FROM migration_source_mappings
    WHERE source_system = 'simletter'
      AND source_entity_type = 'address'
      AND target_entity_type = 'email_address'
      AND target_entity_reference = NEW.id
)
BEGIN
    SELECT CASE WHEN instr(NEW.canonical_address, '@') <= 1
        THEN RAISE(ABORT, '邮箱地址缺少有效前缀') END;

    SELECT CASE WHEN length(substr(
        NEW.canonical_address, 1, instr(NEW.canonical_address, '@') - 1
    )) < (
        SELECT minimum_local_part_length
        FROM address_policy_settings WHERE singleton_id = 1
    ) THEN RAISE(ABORT, '邮箱前缀短于系统当前最短长度') END;

    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM address_policy_terms
        WHERE term_kind = 'blocked_substring'
          AND instr(
              substr(NEW.canonical_address, 1, instr(NEW.canonical_address, '@') - 1),
              normalized_value
          ) > 0
    ) THEN RAISE(ABORT, '邮箱前缀包含系统禁止文字') END;

    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM address_policy_terms
        WHERE term_kind = 'reserved_name'
          AND normalized_value = substr(
              NEW.canonical_address, 1, instr(NEW.canonical_address, '@') - 1
          ) COLLATE NOCASE
    ) THEN RAISE(ABORT, '邮箱前缀属于系统保留名称') END;
END;

CREATE TABLE migration_failures (
    id TEXT PRIMARY KEY NOT NULL,
    migration_run_id TEXT NOT NULL,
    source_entity_type TEXT NOT NULL CHECK (length(source_entity_type) > 0),
    source_entity_id TEXT NOT NULL CHECK (length(source_entity_id) > 0),
    failure_code TEXT NOT NULL CHECK (length(failure_code) > 0),
    failure_summary TEXT NOT NULL CHECK (length(failure_summary) BETWEEN 1 AND 500),
    failure_status TEXT NOT NULL CHECK (
        failure_status IN ('pending', 'resolved', 'skipped')
    ),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    first_failed_at INTEGER NOT NULL,
    resolved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (migration_run_id, source_entity_type, source_entity_id, failure_code),
    CHECK (updated_at >= created_at),
    CHECK (
        (failure_status = 'pending' AND resolved_at IS NULL)
        OR (failure_status IN ('resolved', 'skipped')
            AND resolved_at IS NOT NULL AND resolved_at >= first_failed_at)
    ),
    FOREIGN KEY (migration_run_id) REFERENCES migration_runs (id) ON DELETE CASCADE
);

CREATE INDEX migration_failures_pending_index
    ON migration_failures (migration_run_id, failure_status, source_entity_type, source_entity_id);

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
    CHECK (updated_at >= created_at),
    CHECK (succeeded_count + skipped_count + failed_count = scanned_count),
    CHECK (
        (reconciliation_status = 'matched'
            AND expected_count = scanned_count AND failed_count = 0)
        OR reconciliation_status IN ('pending', 'mismatch')
    ),
    FOREIGN KEY (migration_run_id) REFERENCES migration_runs (id) ON DELETE CASCADE
);

CREATE TABLE migrated_message_sources (
    message_id TEXT PRIMARY KEY NOT NULL,
    migration_run_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL CHECK (length(source_message_id) > 0),
    source_quality TEXT NOT NULL CHECK (
        source_quality IN ('raw_mime', 'structured_rebuilt')
    ),
    original_mime_sha256 BLOB CHECK (
        original_mime_sha256 IS NULL OR length(original_mime_sha256) = 32
    ),
    reconstruction_version TEXT,
    created_at INTEGER NOT NULL,
    CHECK (
        (source_quality = 'raw_mime'
            AND original_mime_sha256 IS NOT NULL AND reconstruction_version IS NULL)
        OR (source_quality = 'structured_rebuilt'
            AND original_mime_sha256 IS NULL AND reconstruction_version IS NOT NULL)
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

CREATE TRIGGER prevent_migrated_message_source_update
BEFORE UPDATE ON migrated_message_sources
BEGIN
    SELECT RAISE(ABORT, '迁移邮件来源质量不可修改');
END;

CREATE TABLE migration_user_password_results (
    migration_run_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source_user_id TEXT NOT NULL CHECK (length(source_user_id) > 0),
    password_result TEXT NOT NULL CHECK (
        password_result IN (
            'target_preserved', 'compatible_preserved',
            'reset_required', 'upgraded', 'missing'
        )
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

CREATE TRIGGER require_migration_reconciliations_before_success
BEFORE UPDATE OF run_status ON migration_runs
WHEN NEW.run_status = 'succeeded'
  AND (
      SELECT COUNT(*) FROM migration_reconciliations
      WHERE migration_run_id = NEW.id AND reconciliation_status = 'matched'
  ) <> 7
BEGIN
    SELECT RAISE(ABORT, '迁移分类对账未全部通过');
END;

CREATE TRIGGER reject_migration_run_inserted_as_success
BEFORE INSERT ON migration_runs
WHEN NEW.run_status = 'succeeded'
BEGIN
    SELECT RAISE(ABORT, '迁移运行必须完成执行与分类对账后才能成功');
END;

CREATE TRIGGER reject_pending_migration_failures_before_success
BEFORE UPDATE OF run_status ON migration_runs
WHEN NEW.run_status = 'succeeded'
  AND EXISTS (
      SELECT 1 FROM migration_failures
      WHERE migration_run_id = NEW.id AND failure_status = 'pending'
  )
BEGIN
    SELECT RAISE(ABORT, '迁移仍有待处理失败项');
END;
