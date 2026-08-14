-- 澄笺 | Simlettra 正式迁移 0005
-- 依据：需求 4.08、4.10、11.08，ADR 0003、0014、0024、0031、0035、0037。

PRAGMA foreign_keys = ON;

CREATE TABLE address_policy_settings (
    singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
    minimum_local_part_length INTEGER NOT NULL DEFAULT 1 CHECK (
        minimum_local_part_length BETWEEN 1 AND 64
    ),
    alias_retention_days INTEGER NOT NULL DEFAULT 0 CHECK (
        alias_retention_days BETWEEN 0 AND 30
    ),
    policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
    updated_by_user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

INSERT INTO address_policy_settings (
    singleton_id, minimum_local_part_length, alias_retention_days,
    policy_version, updated_by_user_id, created_at, updated_at
) VALUES (1, 1, 0, 1, NULL, 0, 0);

CREATE TABLE address_policy_terms (
    id TEXT PRIMARY KEY NOT NULL,
    term_kind TEXT NOT NULL CHECK (
        term_kind IN ('blocked_substring', 'reserved_name')
    ),
    normalized_value TEXT COLLATE NOCASE NOT NULL CHECK (
        length(normalized_value) BETWEEN 1 AND 64
        AND normalized_value = lower(normalized_value)
        AND instr(normalized_value, '@') = 0
    ),
    created_by_user_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (term_kind, normalized_value),
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX address_policy_terms_kind_index
    ON address_policy_terms (term_kind, normalized_value, id);

CREATE TRIGGER validate_new_email_address_policy
BEFORE INSERT ON email_addresses
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

CREATE TABLE deletion_operations (
    id TEXT PRIMARY KEY NOT NULL,
    operation_kind TEXT NOT NULL CHECK (
        operation_kind IN (
            'user_delete', 'organization_delete', 'alias_release',
            'mailbox_entry_delete', 'organization_mail_delete',
            'domain_delete', 'backup_delete'
        )
    ),
    target_type TEXT NOT NULL CHECK (
        target_type IN (
            'user', 'organization', 'email_address', 'mailbox_entry',
            'message', 'mail_domain', 'backup'
        )
    ),
    target_reference TEXT NOT NULL CHECK (length(target_reference) > 0),
    requested_by_user_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
    is_recoverable INTEGER NOT NULL CHECK (is_recoverable IN (0, 1)),
    requested_at INTEGER NOT NULL,
    recovery_due_at INTEGER,
    impact_mailbox_entry_count INTEGER NOT NULL DEFAULT 0 CHECK (
        impact_mailbox_entry_count >= 0
    ),
    impact_message_count INTEGER NOT NULL DEFAULT 0 CHECK (impact_message_count >= 0),
    impact_object_count INTEGER NOT NULL DEFAULT 0 CHECK (impact_object_count >= 0),
    impact_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (impact_size_bytes >= 0),
    operation_status TEXT NOT NULL CHECK (
        operation_status IN (
            'blocked', 'recovery_pending', 'ready', 'running',
            'needs_attention', 'completed', 'cancelled'
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
        blocker_type IN (
            'ownership_transfer', 'active_reference', 'migration_required',
            'backup_required', 'other'
        )
    ),
    blocker_reference TEXT,
    blocker_status TEXT NOT NULL CHECK (
        blocker_status IN ('open', 'resolved', 'waived')
    ),
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
        step_kind IN (
            'revoke_access', 'database_relations', 'objects',
            'search', 'cache', 'reconcile', 'release_identity'
        )
    ),
    is_required INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0, 1)),
    step_status TEXT NOT NULL CHECK (
        step_status IN (
            'pending', 'running', 'retry_wait',
            'needs_attention', 'succeeded', 'skipped'
        )
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
    ON deletion_operation_steps (
        step_status, next_attempt_at, deletion_operation_id, sequence_number
    );

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
          WHERE deletion_operation_id = NEW.id
            AND step_kind = 'reconcile'
            AND step_status = 'succeeded'
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

CREATE TABLE background_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    task_type TEXT NOT NULL CHECK (length(task_type) > 0),
    target_type TEXT NOT NULL CHECK (length(target_type) > 0),
    target_reference TEXT NOT NULL CHECK (length(target_reference) > 0),
    input_version INTEGER NOT NULL CHECK (input_version >= 1),
    task_key_digest BLOB NOT NULL UNIQUE CHECK (length(task_key_digest) = 32),
    task_status TEXT NOT NULL CHECK (
        task_status IN (
            'pending', 'running', 'retry_wait',
            'needs_attention', 'succeeded', 'cancelled'
        )
    ),
    priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
    next_attempt_at INTEGER,
    lease_owner_reference TEXT,
    lease_token INTEGER NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
    lease_expires_at INTEGER,
    last_error_code TEXT,
    last_error_summary TEXT,
    last_error_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (attempt_count <= max_attempts),
    CHECK (
        (task_status IN ('pending', 'retry_wait')
            AND next_attempt_at IS NOT NULL
            AND lease_owner_reference IS NULL
            AND lease_expires_at IS NULL
            AND completed_at IS NULL)
        OR (task_status = 'running'
            AND next_attempt_at IS NULL
            AND lease_owner_reference IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND completed_at IS NULL)
        OR (task_status = 'needs_attention'
            AND next_attempt_at IS NULL
            AND lease_owner_reference IS NULL
            AND lease_expires_at IS NULL
            AND completed_at IS NULL
            AND last_error_code IS NOT NULL)
        OR (task_status IN ('succeeded', 'cancelled')
            AND next_attempt_at IS NULL
            AND lease_owner_reference IS NULL
            AND lease_expires_at IS NULL
            AND completed_at IS NOT NULL)
    ),
    CHECK (
        last_error_at IS NULL
        OR (last_error_code IS NOT NULL AND last_error_at >= created_at)
    )
);

CREATE INDEX background_tasks_due_index
    ON background_tasks (task_status, next_attempt_at, priority, id);

CREATE INDEX background_tasks_lease_index
    ON background_tasks (task_status, lease_expires_at, id)
    WHERE task_status = 'running';

CREATE INDEX background_tasks_target_index
    ON background_tasks (target_type, target_reference, task_type, input_version);

CREATE TRIGGER validate_background_task_insert
BEFORE INSERT ON background_tasks
WHEN NEW.task_status <> 'pending'
  OR NEW.attempt_count <> 0
  OR NEW.lease_token <> 0
BEGIN
    SELECT RAISE(ABORT, '新后台任务必须从等待状态开始');
END;

CREATE TRIGGER prevent_background_task_identity_change
BEFORE UPDATE OF
    task_type, target_type, target_reference,
    input_version, task_key_digest, max_attempts, created_at
ON background_tasks
BEGIN
    SELECT RAISE(ABORT, '后台任务身份与策略快照不可修改');
END;

CREATE TRIGGER validate_background_task_transition
BEFORE UPDATE OF task_status, attempt_count, lease_token ON background_tasks
WHEN (
    NEW.task_status <> OLD.task_status
    OR NEW.attempt_count <> OLD.attempt_count
    OR NEW.lease_token <> OLD.lease_token
)
AND NOT (
    (
        NEW.task_status = 'running'
        AND OLD.task_status IN ('pending', 'retry_wait')
        AND OLD.next_attempt_at IS NOT NULL
        AND OLD.next_attempt_at <= NEW.updated_at
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND NEW.lease_token = OLD.lease_token + 1
        AND NEW.attempt_count <= OLD.max_attempts
    )
    OR (
        NEW.task_status = 'running'
        AND OLD.task_status = 'running'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_token = OLD.lease_token
        AND NEW.lease_owner_reference = OLD.lease_owner_reference
        AND NEW.lease_expires_at >= OLD.lease_expires_at
    )
    OR (
        NEW.task_status = 'running'
        AND OLD.task_status = 'running'
        AND OLD.lease_expires_at IS NOT NULL
        AND OLD.lease_expires_at <= NEW.updated_at
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND NEW.lease_token = OLD.lease_token + 1
        AND NEW.attempt_count <= OLD.max_attempts
    )
    OR (
        OLD.task_status = 'running'
        AND NEW.task_status IN (
            'retry_wait', 'needs_attention', 'succeeded', 'cancelled'
        )
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_token = OLD.lease_token
    )
    OR (
        OLD.task_status IN ('pending', 'retry_wait')
        AND NEW.task_status = 'cancelled'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_token = OLD.lease_token
    )
    OR (
        OLD.task_status = 'needs_attention'
        AND NEW.task_status IN ('pending', 'cancelled')
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_token = OLD.lease_token
    )
)
BEGIN
    SELECT RAISE(ABORT, '后台任务状态、尝试次数或领取令牌无效');
END;

CREATE TABLE background_task_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    lease_token INTEGER NOT NULL CHECK (lease_token >= 1),
    worker_reference TEXT NOT NULL CHECK (length(worker_reference) > 0),
    attempt_status TEXT NOT NULL CHECK (
        attempt_status IN (
            'running', 'succeeded', 'retry_scheduled',
            'needs_attention', 'cancelled', 'abandoned'
        )
    ),
    retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
    error_code TEXT,
    error_summary TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (task_id, attempt_number),
    UNIQUE (task_id, lease_token),
    CHECK (
        (attempt_status = 'running'
            AND retryable IS NULL
            AND finished_at IS NULL)
        OR (attempt_status <> 'running'
            AND retryable IS NOT NULL
            AND finished_at IS NOT NULL
            AND finished_at >= started_at)
    ),
    CHECK (
        error_code IS NULL
        OR attempt_status IN ('retry_scheduled', 'needs_attention', 'abandoned')
    ),
    FOREIGN KEY (task_id) REFERENCES background_tasks (id) ON DELETE CASCADE
);

CREATE INDEX background_task_attempts_task_index
    ON background_task_attempts (task_id, attempt_number DESC);

CREATE TRIGGER validate_background_task_attempt_insert
BEFORE INSERT ON background_task_attempts
WHEN NOT EXISTS (
    SELECT 1
    FROM background_tasks AS task
    WHERE task.id = NEW.task_id
      AND task.task_status = 'running'
      AND task.attempt_count = NEW.attempt_number
      AND task.lease_token = NEW.lease_token
      AND task.lease_owner_reference = NEW.worker_reference
)
BEGIN
    SELECT RAISE(ABORT, '任务尝试必须匹配当前领取租约');
END;

CREATE TRIGGER prevent_background_task_attempt_identity_change
BEFORE UPDATE OF
    task_id, attempt_number, lease_token,
    worker_reference, started_at, created_at
ON background_task_attempts
BEGIN
    SELECT RAISE(ABORT, '任务尝试身份不可修改');
END;

CREATE TRIGGER validate_background_task_attempt_finish
BEFORE UPDATE OF attempt_status ON background_task_attempts
WHEN NEW.attempt_status <> OLD.attempt_status
  AND NOT (
      OLD.attempt_status = 'running'
      AND NEW.attempt_status IN (
          'succeeded', 'retry_scheduled', 'needs_attention', 'cancelled', 'abandoned'
      )
  )
BEGIN
    SELECT RAISE(ABORT, '任务尝试终态不可重开或重新分类');
END;

CREATE TRIGGER validate_current_background_task_attempt_finish
BEFORE UPDATE OF attempt_status ON background_task_attempts
WHEN NEW.attempt_status <> OLD.attempt_status
  AND NEW.attempt_status <> 'abandoned'
  AND NOT EXISTS (
      SELECT 1
      FROM background_tasks AS task
      WHERE task.id = OLD.task_id
        AND task.task_status = 'running'
        AND task.attempt_count = OLD.attempt_number
        AND task.lease_token = OLD.lease_token
        AND task.lease_owner_reference = OLD.worker_reference
  )
BEGIN
    SELECT RAISE(ABORT, '失去租约的任务尝试只能标记为已放弃');
END;

