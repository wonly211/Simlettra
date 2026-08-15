-- 澄笺 | Simlettra 第四批迁移草案
-- 状态：草案，未进入正式 migrations 账本，不得直接用于生产升级。
-- 前置：0001-系统身份与地址基础.sql、0002-邮件投递与邮箱视图.sql、0003-草稿与发信状态.sql。
-- 依据：ADR 0002、0003、0008、0009、0010、0013、0022、0023、0024。

PRAGMA foreign_keys = ON;

CREATE TABLE object_registry (
    id TEXT PRIMARY KEY NOT NULL,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
    object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('message', 'draft_attachment')),
    owner_reference TEXT NOT NULL CHECK (length(owner_reference) > 0),
    message_id TEXT,
    draft_attachment_id TEXT,
    object_role TEXT NOT NULL CHECK (
        object_role IN (
            'raw_mime',
            'plain_body',
            'html_body',
            'attachment',
            'inline_resource',
            'final_mime',
            'draft_attachment'
        )
    ),
    logical_part_key TEXT NOT NULL CHECK (length(logical_part_key) > 0),
    sequence_number INTEGER NOT NULL DEFAULT 0 CHECK (sequence_number >= 0),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    required_for_visibility INTEGER NOT NULL DEFAULT 1 CHECK (
        required_for_visibility IN (0, 1)
    ),
    is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
    expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes >= 0),
    expected_sha256 BLOB NOT NULL CHECK (length(expected_sha256) = 32),
    actual_size_bytes INTEGER CHECK (actual_size_bytes >= 0),
    actual_sha256 BLOB CHECK (actual_sha256 IS NULL OR length(actual_sha256) = 32),
    media_type TEXT NOT NULL CHECK (length(media_type) > 0),
    untrusted_file_name TEXT,
    content_disposition TEXT CHECK (
        content_disposition IS NULL OR content_disposition IN ('inline', 'attachment')
    ),
    content_id TEXT,
    producer_version TEXT NOT NULL CHECK (length(producer_version) > 0),
    backend_version_reference TEXT,
    object_status TEXT NOT NULL CHECK (
        object_status IN (
            'write_intent',
            'stored',
            'waiting_consistency',
            'verified',
            'active',
            'superseded',
            'missing',
            'damaged',
            'pending_delete',
            'deleted'
        )
    ),
    stored_at INTEGER,
    verified_at INTEGER,
    consistency_checked_at INTEGER,
    activated_at INTEGER,
    superseded_at INTEGER,
    delete_after INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_kind, owner_reference, object_role, logical_part_key, generation),
    CHECK (updated_at >= created_at),
    CHECK (
        (owner_kind = 'message'
            AND object_role <> 'draft_attachment'
            AND draft_attachment_id IS NULL
            AND (message_id IS NULL OR message_id = owner_reference))
        OR (owner_kind = 'draft_attachment'
            AND object_role = 'draft_attachment'
            AND message_id IS NULL
            AND draft_attachment_id = owner_reference)
    ),
    CHECK (
        (object_role IN ('attachment', 'inline_resource', 'draft_attachment'))
        OR (
            untrusted_file_name IS NULL
            AND content_disposition IS NULL
            AND content_id IS NULL
        )
    ),
    CHECK (
        object_role NOT IN ('attachment', 'draft_attachment')
        OR (
            untrusted_file_name IS NOT NULL
            AND length(untrusted_file_name) > 0
            AND content_disposition = 'attachment'
        )
    ),
    CHECK (
        object_role <> 'inline_resource'
        OR (content_disposition = 'inline' AND content_id IS NOT NULL)
    ),
    CHECK (
        object_status = 'write_intent'
        OR (actual_size_bytes IS NOT NULL AND actual_sha256 IS NOT NULL)
        OR object_status IN ('pending_delete', 'deleted')
    ),
    CHECK (
        object_status NOT IN ('verified', 'active', 'superseded')
        OR (
            actual_size_bytes = expected_size_bytes
            AND actual_sha256 = expected_sha256
            AND verified_at IS NOT NULL
        )
    ),
    CHECK (
        (object_status IN ('write_intent', 'stored', 'waiting_consistency', 'verified')
            AND is_current = 0)
        OR (object_status IN ('active', 'missing', 'damaged') AND is_current = 1)
        OR (object_status IN ('superseded', 'pending_delete', 'deleted') AND is_current = 0)
    ),
    CHECK (
        object_status NOT IN ('stored', 'waiting_consistency', 'verified', 'active', 'superseded', 'missing', 'damaged')
        OR stored_at IS NOT NULL
    ),
    CHECK (
        object_status NOT IN ('active', 'superseded', 'missing', 'damaged')
        OR activated_at IS NOT NULL
    ),
    CHECK (object_status <> 'superseded' OR superseded_at IS NOT NULL),
    CHECK (object_status NOT IN ('pending_delete', 'deleted') OR delete_after IS NOT NULL),
    CHECK (object_status <> 'deleted' OR deleted_at IS NOT NULL),
    CHECK (
        stored_at IS NULL OR stored_at >= created_at
    ),
    CHECK (
        verified_at IS NULL OR (stored_at IS NOT NULL AND verified_at >= stored_at)
    ),
    CHECK (
        consistency_checked_at IS NULL
        OR (stored_at IS NOT NULL AND consistency_checked_at >= stored_at)
    ),
    CHECK (
        activated_at IS NULL OR (verified_at IS NOT NULL AND activated_at >= verified_at)
    ),
    CHECK (
        superseded_at IS NULL OR (activated_at IS NOT NULL AND superseded_at >= activated_at)
    ),
    CHECK (deleted_at IS NULL OR (delete_after IS NOT NULL AND deleted_at >= delete_after)),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (draft_attachment_id) REFERENCES draft_attachments (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX object_registry_current_part_unique
    ON object_registry (owner_kind, owner_reference, object_role, logical_part_key)
    WHERE is_current = 1;

CREATE INDEX object_registry_message_index
    ON object_registry (message_id, object_role, is_current, sequence_number)
    WHERE message_id IS NOT NULL;

CREATE INDEX object_registry_draft_attachment_index
    ON object_registry (draft_attachment_id, object_status, generation DESC)
    WHERE draft_attachment_id IS NOT NULL;

CREATE INDEX object_registry_work_index
    ON object_registry (object_status, storage_mode, updated_at, id);

CREATE INDEX object_registry_delete_index
    ON object_registry (object_status, delete_after, id)
    WHERE object_status IN ('pending_delete', 'deleted');

CREATE TRIGGER validate_draft_attachment_object_insert
BEFORE INSERT ON object_registry
WHEN NEW.owner_kind = 'draft_attachment'
  AND NOT EXISTS (
      SELECT 1
      FROM draft_attachments AS attachment
      WHERE attachment.id = NEW.draft_attachment_id
        AND NEW.owner_reference = attachment.id
        AND NEW.logical_part_key = attachment.id
        AND NEW.sequence_number = attachment.sequence_number
        AND NEW.generation = attachment.content_generation
        AND NEW.expected_size_bytes = attachment.size_bytes
        AND NEW.expected_sha256 = attachment.content_sha256
        AND NEW.media_type = attachment.media_type
        AND NEW.untrusted_file_name = attachment.untrusted_file_name
  )
BEGIN
    SELECT RAISE(ABORT, '草稿附件对象与附件快照不匹配');
END;

CREATE TRIGGER validate_attached_message_object_insert
BEFORE INSERT ON object_registry
WHEN NEW.owner_kind = 'message'
  AND NEW.message_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM messages AS message
      WHERE message.id = NEW.message_id
        AND NEW.owner_reference = message.id
        AND (
            (message.origin_type = 'received'
                AND NEW.object_role IN ('raw_mime', 'plain_body', 'html_body', 'attachment', 'inline_resource'))
            OR (message.origin_type = 'composed'
                AND NEW.object_role IN ('final_mime', 'plain_body', 'html_body', 'attachment', 'inline_resource'))
            OR (message.origin_type = 'migrated'
                AND NEW.object_role IN ('raw_mime', 'plain_body', 'html_body', 'attachment', 'inline_resource', 'final_mime'))
        )
  )
BEGIN
    SELECT RAISE(ABORT, '邮件对象角色与物理邮件来源不匹配');
END;

CREATE TRIGGER prevent_object_registry_identity_change
BEFORE UPDATE OF
    storage_mode,
    object_key,
    owner_kind,
    owner_reference,
    draft_attachment_id,
    object_role,
    logical_part_key,
    sequence_number,
    generation,
    required_for_visibility,
    expected_size_bytes,
    expected_sha256,
    media_type,
    untrusted_file_name,
    content_disposition,
    content_id,
    producer_version,
    created_at
ON object_registry
BEGIN
    SELECT RAISE(ABORT, '对象登记身份与预期内容不可修改');
END;

CREATE TRIGGER validate_object_message_attachment
BEFORE UPDATE OF message_id ON object_registry
WHEN NEW.message_id IS NOT OLD.message_id
  AND NOT (
      OLD.owner_kind = 'message'
      AND OLD.message_id IS NULL
            AND NEW.message_id = OLD.owner_reference
            AND EXISTS (
          SELECT 1
          FROM messages AS message
          WHERE message.id = NEW.message_id
            AND (
                (message.origin_type = 'received'
                    AND OLD.object_role IN ('raw_mime', 'plain_body', 'html_body', 'attachment', 'inline_resource'))
                OR (message.origin_type = 'composed'
                    AND OLD.object_role IN ('final_mime', 'plain_body', 'html_body', 'attachment', 'inline_resource'))
                OR (message.origin_type = 'migrated'
                    AND OLD.object_role IN ('raw_mime', 'plain_body', 'html_body', 'attachment', 'inline_resource', 'final_mime'))
            )
      )
  )
BEGIN
    SELECT RAISE(ABORT, '邮件对象只能一次附着到预留物理邮件');
END;

CREATE TRIGGER prevent_object_actual_content_change
BEFORE UPDATE OF actual_size_bytes, actual_sha256 ON object_registry
WHEN (OLD.actual_size_bytes IS NOT NULL AND NEW.actual_size_bytes IS NOT OLD.actual_size_bytes)
  OR (OLD.actual_sha256 IS NOT NULL AND NEW.actual_sha256 IS NOT OLD.actual_sha256)
BEGIN
    SELECT RAISE(ABORT, '已记录的对象实际大小与哈希不可修改');
END;

CREATE TRIGGER validate_object_status_transition
BEFORE UPDATE OF object_status ON object_registry
WHEN NEW.object_status <> OLD.object_status
  AND NOT (
      (OLD.object_status = 'write_intent' AND NEW.object_status IN ('stored', 'pending_delete'))
      OR (OLD.object_status = 'stored' AND NEW.object_status IN ('waiting_consistency', 'verified', 'pending_delete'))
      OR (OLD.object_status = 'waiting_consistency' AND NEW.object_status IN ('verified', 'pending_delete'))
      OR (OLD.object_status = 'verified' AND NEW.object_status IN ('active', 'pending_delete'))
      OR (OLD.object_status = 'active' AND NEW.object_status IN ('superseded', 'missing', 'damaged', 'pending_delete'))
      OR (OLD.object_status IN ('missing', 'damaged') AND NEW.object_status IN ('superseded', 'pending_delete'))
      OR (OLD.object_status = 'superseded' AND NEW.object_status = 'pending_delete')
      OR (OLD.object_status = 'pending_delete' AND NEW.object_status = 'deleted')
  )
BEGIN
    SELECT RAISE(ABORT, '对象状态不能倒退或跳过校验');
END;

CREATE TRIGGER validate_active_object_insert
BEFORE INSERT ON object_registry
WHEN NEW.object_status = 'active'
  AND (
      NEW.is_current <> 1
      OR NEW.actual_size_bytes <> NEW.expected_size_bytes
      OR NEW.actual_sha256 <> NEW.expected_sha256
      OR (
          NEW.owner_kind = 'message'
          AND (
              NEW.message_id IS NULL
              OR NEW.message_id <> NEW.owner_reference
          )
      )
  )
BEGIN
    SELECT RAISE(ABORT, '活动对象必须完整校验并附着到所有者');
END;

CREATE TRIGGER validate_active_object_update
BEFORE UPDATE OF object_status, is_current, message_id ON object_registry
WHEN NEW.object_status = 'active'
  AND (
      NEW.is_current <> 1
      OR NEW.actual_size_bytes <> NEW.expected_size_bytes
      OR NEW.actual_sha256 <> NEW.expected_sha256
      OR (
          NEW.owner_kind = 'message'
          AND (
              NEW.message_id IS NULL
              OR NEW.message_id <> NEW.owner_reference
          )
      )
  )
BEGIN
    SELECT RAISE(ABORT, '活动对象必须完整校验并附着到所有者');
END;

CREATE TABLE message_integrity_states (
    message_id TEXT PRIMARY KEY NOT NULL,
    source_completeness TEXT NOT NULL CHECK (
        source_completeness IN ('raw_mime', 'final_mime', 'structured_only')
    ),
    integrity_status TEXT NOT NULL CHECK (
        integrity_status IN ('ready', 'repairing', 'damaged', 'pending_delete')
    ),
    object_set_version INTEGER NOT NULL DEFAULT 1 CHECK (object_set_version >= 1),
    ready_at INTEGER,
    hidden_since INTEGER,
    damage_code TEXT,
    damage_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (integrity_status = 'ready'
            AND ready_at IS NOT NULL
            AND hidden_since IS NULL
            AND damage_code IS NULL
            AND damage_summary IS NULL)
        OR (integrity_status = 'repairing'
            AND hidden_since IS NOT NULL)
        OR (integrity_status = 'damaged'
            AND hidden_since IS NOT NULL
            AND damage_code IS NOT NULL)
        OR (integrity_status = 'pending_delete'
            AND hidden_since IS NOT NULL)
    ),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT
);

CREATE INDEX message_integrity_status_index
    ON message_integrity_states (integrity_status, updated_at, message_id);

CREATE TRIGGER validate_message_integrity_source_insert
BEFORE INSERT ON message_integrity_states
WHEN NOT EXISTS (
    SELECT 1
    FROM messages AS message
    WHERE message.id = NEW.message_id
      AND (
          (message.origin_type = 'received' AND NEW.source_completeness = 'raw_mime')
          OR (message.origin_type = 'composed' AND NEW.source_completeness = 'final_mime')
          OR (
              message.origin_type = 'migrated'
              AND NEW.source_completeness IN ('raw_mime', 'final_mime', 'structured_only')
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, '邮件来源与内容完整度不匹配');
END;

CREATE TRIGGER validate_message_ready_insert
BEFORE INSERT ON message_integrity_states
WHEN NEW.integrity_status = 'ready'
  AND (
      NOT EXISTS (
          SELECT 1
          FROM object_registry AS object
          WHERE object.message_id = NEW.message_id
            AND object.is_current = 1
            AND object.required_for_visibility = 1
            AND object.object_status = 'active'
      )
      OR EXISTS (
          SELECT 1
          FROM object_registry AS object
          WHERE object.message_id = NEW.message_id
            AND object.is_current = 1
            AND object.required_for_visibility = 1
            AND object.object_status <> 'active'
      )
      OR (
          NEW.source_completeness = 'raw_mime'
          AND NOT EXISTS (
              SELECT 1
              FROM object_registry AS object
              WHERE object.message_id = NEW.message_id
                AND object.object_role = 'raw_mime'
                AND object.is_current = 1
                AND object.object_status = 'active'
          )
      )
      OR (
          NEW.source_completeness = 'final_mime'
          AND NOT EXISTS (
              SELECT 1
              FROM object_registry AS object
              WHERE object.message_id = NEW.message_id
                AND object.object_role = 'final_mime'
                AND object.is_current = 1
                AND object.object_status = 'active'
          )
      )
      OR NOT EXISTS (
          SELECT 1
          FROM object_registry AS object
          WHERE object.message_id = NEW.message_id
            AND object.object_role IN ('plain_body', 'html_body')
            AND object.is_current = 1
            AND object.object_status = 'active'
      )
      OR NOT EXISTS (
          SELECT 1
          FROM messages AS message
          WHERE message.id = NEW.message_id
            AND message.attachment_count = (
                SELECT COUNT(*)
                FROM object_registry AS object
                WHERE object.message_id = NEW.message_id
                  AND object.object_role = 'attachment'
                  AND object.is_current = 1
                  AND object.object_status = 'active'
            )
      )
  )
BEGIN
    SELECT RAISE(ABORT, '邮件必要对象尚未完整，不能进入就绪状态');
END;

CREATE TRIGGER validate_message_ready_update
BEFORE UPDATE OF integrity_status, object_set_version ON message_integrity_states
WHEN NEW.integrity_status = 'ready'
  AND (
      NOT EXISTS (
          SELECT 1
          FROM object_registry AS object
          WHERE object.message_id = NEW.message_id
            AND object.is_current = 1
            AND object.required_for_visibility = 1
            AND object.object_status = 'active'
      )
      OR EXISTS (
          SELECT 1
          FROM object_registry AS object
          WHERE object.message_id = NEW.message_id
            AND object.is_current = 1
            AND object.required_for_visibility = 1
            AND object.object_status <> 'active'
      )
      OR (
          NEW.source_completeness = 'raw_mime'
          AND NOT EXISTS (
              SELECT 1
              FROM object_registry AS object
              WHERE object.message_id = NEW.message_id
                AND object.object_role = 'raw_mime'
                AND object.is_current = 1
                AND object.object_status = 'active'
          )
      )
      OR (
          NEW.source_completeness = 'final_mime'
          AND NOT EXISTS (
              SELECT 1
              FROM object_registry AS object
              WHERE object.message_id = NEW.message_id
                AND object.object_role = 'final_mime'
                AND object.is_current = 1
                AND object.object_status = 'active'
          )
      )
      OR NOT EXISTS (
          SELECT 1
          FROM object_registry AS object
          WHERE object.message_id = NEW.message_id
            AND object.object_role IN ('plain_body', 'html_body')
            AND object.is_current = 1
            AND object.object_status = 'active'
      )
      OR NOT EXISTS (
          SELECT 1
          FROM messages AS message
          WHERE message.id = NEW.message_id
            AND message.attachment_count = (
                SELECT COUNT(*)
                FROM object_registry AS object
                WHERE object.message_id = NEW.message_id
                  AND object.object_role = 'attachment'
                  AND object.is_current = 1
                  AND object.object_status = 'active'
            )
      )
  )
BEGIN
    SELECT RAISE(ABORT, '邮件必要对象尚未完整，不能恢复就绪状态');
END;

CREATE TRIGGER prevent_message_integrity_identity_change
BEFORE UPDATE OF message_id, source_completeness, created_at
ON message_integrity_states
BEGIN
    SELECT RAISE(ABORT, '邮件完整性身份不可修改');
END;

CREATE TRIGGER validate_message_integrity_transition
BEFORE UPDATE OF integrity_status, object_set_version ON message_integrity_states
WHEN NEW.integrity_status <> OLD.integrity_status
  AND (
      NEW.object_set_version <> OLD.object_set_version + 1
      OR NOT (
          (OLD.integrity_status = 'ready' AND NEW.integrity_status IN ('repairing', 'damaged', 'pending_delete'))
          OR (OLD.integrity_status = 'repairing' AND NEW.integrity_status IN ('ready', 'damaged', 'pending_delete'))
          OR (OLD.integrity_status = 'damaged' AND NEW.integrity_status IN ('repairing', 'pending_delete'))
      )
  )
BEGIN
    SELECT RAISE(ABORT, '邮件完整性状态或对象集合版本无效');
END;

CREATE TRIGGER prevent_message_integrity_version_drift
BEFORE UPDATE OF object_set_version ON message_integrity_states
WHEN NEW.integrity_status = OLD.integrity_status
  AND NEW.object_set_version <> OLD.object_set_version
BEGIN
    SELECT RAISE(ABORT, '对象集合版本只能随完整性状态切换递增');
END;

CREATE TRIGGER prevent_message_object_deactivation_while_ready
BEFORE UPDATE OF object_status ON object_registry
WHEN OLD.object_status = 'active'
  AND NEW.object_status IN ('superseded', 'missing', 'damaged', 'pending_delete')
  AND OLD.message_id IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM message_integrity_states AS integrity
      WHERE integrity.message_id = OLD.message_id
        AND integrity.integrity_status = 'ready'
  )
BEGIN
    SELECT RAISE(ABORT, '停用当前对象前必须先隐藏完整邮件');
END;

CREATE TRIGGER validate_mailbox_entry_message_ready
BEFORE INSERT ON mailbox_entries
WHEN NOT EXISTS (
    SELECT 1
    FROM message_integrity_states AS integrity
    WHERE integrity.message_id = NEW.message_id
      AND integrity.integrity_status = 'ready'
)
BEGIN
    SELECT RAISE(ABORT, '非就绪邮件不能建立邮箱条目');
END;

CREATE TABLE receive_operations (
    id TEXT PRIMARY KEY NOT NULL,
    source_kind TEXT NOT NULL CHECK (length(source_kind) > 0),
    source_event_reference TEXT,
    deduplication_kind TEXT NOT NULL CHECK (
        deduplication_kind IN ('provider_event', 'bounded_fingerprint')
    ),
    deduplication_key_digest BLOB NOT NULL CHECK (
        length(deduplication_key_digest) = 32
    ),
    deduplication_window_started_at INTEGER,
    deduplication_expires_at INTEGER,
    message_reference TEXT NOT NULL CHECK (length(message_reference) > 0),
    message_id TEXT UNIQUE,
    raw_object_id TEXT UNIQUE,
    raw_size_bytes INTEGER NOT NULL CHECK (raw_size_bytes >= 0),
    raw_sha256 BLOB NOT NULL CHECK (length(raw_sha256) = 32),
    envelope_sender_text TEXT NOT NULL,
    operation_status TEXT NOT NULL CHECK (
        operation_status IN (
            'intent',
            'raw_stored',
            'parsing',
            'derived_stored',
            'waiting_consistency',
            'committing',
            'visible',
            'parse_failed',
            'damaged',
            'rejected',
            'needs_attention'
        )
    ),
    parser_version TEXT,
    parsed_part_count INTEGER CHECK (parsed_part_count >= 0),
    error_code TEXT,
    error_summary TEXT,
    accepted_at INTEGER NOT NULL,
    visible_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source_kind, deduplication_key_digest),
    CHECK (updated_at >= created_at),
    CHECK (
        (deduplication_kind = 'provider_event'
            AND source_event_reference IS NOT NULL
            AND deduplication_window_started_at IS NULL
            AND deduplication_expires_at IS NULL)
        OR (deduplication_kind = 'bounded_fingerprint'
            AND deduplication_window_started_at IS NOT NULL
            AND deduplication_expires_at IS NOT NULL
            AND deduplication_expires_at > deduplication_window_started_at)
    ),
    CHECK (message_id IS NULL OR message_id = message_reference),
    CHECK (
        operation_status IN ('intent', 'rejected')
        OR raw_object_id IS NOT NULL
    ),
    CHECK (
        (operation_status = 'visible'
            AND message_id IS NOT NULL
            AND visible_at IS NOT NULL
            AND completed_at IS NOT NULL)
        OR (operation_status IN ('parse_failed', 'damaged', 'rejected', 'needs_attention')
            AND visible_at IS NULL
            AND error_code IS NOT NULL
            AND completed_at IS NOT NULL)
        OR (operation_status IN (
                'intent',
                'raw_stored',
                'parsing',
                'derived_stored',
                'waiting_consistency',
                'committing'
            )
            AND visible_at IS NULL
            AND completed_at IS NULL)
    ),
    CHECK (visible_at IS NULL OR visible_at >= accepted_at),
    CHECK (completed_at IS NULL OR completed_at >= accepted_at),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (raw_object_id) REFERENCES object_registry (id) ON DELETE RESTRICT
);

CREATE INDEX receive_operations_work_index
    ON receive_operations (operation_status, updated_at, id);

CREATE INDEX receive_operations_message_reference_index
    ON receive_operations (message_reference, id);

CREATE INDEX receive_operations_window_expiry_index
    ON receive_operations (deduplication_expires_at, id)
    WHERE deduplication_expires_at IS NOT NULL;

CREATE TRIGGER validate_receive_raw_object_insert
BEFORE INSERT ON receive_operations
WHEN NEW.raw_object_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM object_registry AS object
      WHERE object.id = NEW.raw_object_id
        AND object.owner_kind = 'message'
        AND object.owner_reference = NEW.message_reference
        AND object.object_role = 'raw_mime'
        AND object.expected_size_bytes = NEW.raw_size_bytes
        AND object.expected_sha256 = NEW.raw_sha256
        AND object.object_status IN ('verified', 'active')
  )
BEGIN
    SELECT RAISE(ABORT, '收信操作的原始对象无效');
END;

CREATE TRIGGER validate_receive_raw_object_update
BEFORE UPDATE OF raw_object_id ON receive_operations
WHEN NEW.raw_object_id IS NOT OLD.raw_object_id
  AND NOT (
      OLD.raw_object_id IS NULL
      AND EXISTS (
          SELECT 1
          FROM object_registry AS object
          WHERE object.id = NEW.raw_object_id
            AND object.owner_kind = 'message'
            AND object.owner_reference = OLD.message_reference
            AND object.object_role = 'raw_mime'
            AND object.expected_size_bytes = OLD.raw_size_bytes
            AND object.expected_sha256 = OLD.raw_sha256
            AND object.object_status IN ('verified', 'active')
      )
  )
BEGIN
    SELECT RAISE(ABORT, '收信原始对象只能一次关联且必须完整');
END;

CREATE TRIGGER prevent_receive_operation_identity_change
BEFORE UPDATE OF
    source_kind,
    source_event_reference,
    deduplication_kind,
    deduplication_key_digest,
    deduplication_window_started_at,
    deduplication_expires_at,
    message_reference,
    raw_size_bytes,
    raw_sha256,
    envelope_sender_text,
    accepted_at,
    created_at
ON receive_operations
BEGIN
    SELECT RAISE(ABORT, '收信操作身份与原始快照不可修改');
END;

CREATE TRIGGER validate_receive_message_attachment
BEFORE UPDATE OF message_id ON receive_operations
WHEN NEW.message_id IS NOT OLD.message_id
  AND NOT (
      OLD.message_id IS NULL
      AND NEW.message_id = OLD.message_reference
      AND EXISTS (
          SELECT 1
          FROM messages AS message
          WHERE message.id = NEW.message_id
            AND message.origin_type = 'received'
      )
  )
BEGIN
    SELECT RAISE(ABORT, '收信操作只能关联预留的收信物理邮件');
END;

CREATE TRIGGER validate_receive_operation_transition
BEFORE UPDATE OF operation_status ON receive_operations
WHEN NEW.operation_status <> OLD.operation_status
  AND NOT (
      (OLD.operation_status = 'intent' AND NEW.operation_status IN ('raw_stored', 'rejected', 'needs_attention'))
      OR (OLD.operation_status = 'raw_stored' AND NEW.operation_status IN ('parsing', 'damaged', 'needs_attention'))
      OR (OLD.operation_status = 'parsing' AND NEW.operation_status IN ('derived_stored', 'parse_failed', 'damaged', 'needs_attention'))
      OR (OLD.operation_status = 'derived_stored' AND NEW.operation_status IN ('waiting_consistency', 'committing', 'damaged', 'needs_attention'))
      OR (OLD.operation_status = 'waiting_consistency' AND NEW.operation_status IN ('committing', 'damaged', 'needs_attention'))
      OR (OLD.operation_status = 'committing' AND NEW.operation_status IN ('visible', 'damaged', 'needs_attention'))
      OR (OLD.operation_status = 'parse_failed' AND NEW.operation_status IN ('parsing', 'needs_attention'))
      OR (OLD.operation_status = 'needs_attention' AND NEW.operation_status IN ('raw_stored', 'parsing', 'waiting_consistency', 'committing', 'rejected', 'damaged'))
  )
BEGIN
    SELECT RAISE(ABORT, '收信操作状态不能倒退或跳过必要阶段');
END;

CREATE TABLE receive_operation_routes (
    id TEXT PRIMARY KEY NOT NULL,
    receive_operation_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    envelope_recipient_text TEXT NOT NULL CHECK (length(envelope_recipient_text) > 0),
    canonical_recipient_address TEXT COLLATE NOCASE NOT NULL,
    mail_domain_id TEXT NOT NULL,
    route_kind TEXT NOT NULL CHECK (route_kind IN ('assigned', 'unallocated', 'rejected')),
    address_id TEXT,
    address_binding_id TEXT,
    unallocated_period_id TEXT,
    route_status TEXT NOT NULL CHECK (route_status IN ('accepted', 'rejected', 'committed')),
    rejection_code TEXT,
    message_delivery_id TEXT UNIQUE,
    decided_at INTEGER NOT NULL,
    committed_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (receive_operation_id, sequence_number),
    UNIQUE (receive_operation_id, canonical_recipient_address),
    CHECK (
        (route_kind = 'assigned'
            AND route_status IN ('accepted', 'committed')
            AND address_id IS NOT NULL
            AND address_binding_id IS NOT NULL
            AND unallocated_period_id IS NULL
            AND rejection_code IS NULL)
        OR (route_kind = 'unallocated'
            AND route_status IN ('accepted', 'committed')
            AND address_id IS NULL
            AND address_binding_id IS NULL
            AND unallocated_period_id IS NOT NULL
            AND rejection_code IS NULL)
        OR (route_kind = 'rejected'
            AND route_status = 'rejected'
            AND address_id IS NULL
            AND address_binding_id IS NULL
            AND unallocated_period_id IS NULL
            AND rejection_code IS NOT NULL)
    ),
    CHECK (
        (route_status = 'committed'
            AND message_delivery_id IS NOT NULL
            AND committed_at IS NOT NULL
            AND committed_at >= decided_at)
        OR (route_status <> 'committed'
            AND message_delivery_id IS NULL
            AND committed_at IS NULL)
    ),
    FOREIGN KEY (receive_operation_id) REFERENCES receive_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (mail_domain_id) REFERENCES mail_domains (id) ON DELETE RESTRICT,
    FOREIGN KEY (address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT,
    FOREIGN KEY (address_binding_id) REFERENCES address_bindings (id) ON DELETE RESTRICT,
    FOREIGN KEY (unallocated_period_id) REFERENCES unallocated_address_periods (id) ON DELETE RESTRICT,
    FOREIGN KEY (message_delivery_id) REFERENCES message_deliveries (id) ON DELETE RESTRICT
);

CREATE INDEX receive_operation_routes_target_index
    ON receive_operation_routes (route_kind, address_binding_id, unallocated_period_id);

CREATE INDEX receive_operation_routes_status_index
    ON receive_operation_routes (receive_operation_id, route_status, sequence_number);

CREATE TRIGGER validate_receive_route_insert
BEFORE INSERT ON receive_operation_routes
WHEN (
    NEW.route_kind = 'assigned'
    AND NOT EXISTS (
        SELECT 1
        FROM receive_operations AS operation
        JOIN address_bindings AS binding
          ON binding.id = NEW.address_binding_id
         AND binding.address_id = NEW.address_id
         AND binding.started_at <= operation.accepted_at
         AND (binding.ended_at IS NULL OR binding.ended_at >= operation.accepted_at)
        JOIN email_addresses AS address
          ON address.id = NEW.address_id
         AND address.domain_id = NEW.mail_domain_id
         AND address.canonical_address = NEW.canonical_recipient_address COLLATE NOCASE
         AND (address.retired_at IS NULL OR address.retired_at > operation.accepted_at)
        JOIN mail_domains AS domain
          ON domain.id = NEW.mail_domain_id
         AND domain.status = 'active'
        WHERE operation.id = NEW.receive_operation_id
    )
)
OR (
    NEW.route_kind = 'unallocated'
    AND NOT EXISTS (
        SELECT 1
        FROM receive_operations AS operation
        JOIN unallocated_address_periods AS period
          ON period.id = NEW.unallocated_period_id
         AND period.domain_id = NEW.mail_domain_id
         AND period.canonical_address = NEW.canonical_recipient_address COLLATE NOCASE
         AND period.started_at <= operation.accepted_at
         AND (period.closed_at IS NULL OR period.closed_at >= operation.accepted_at)
        JOIN mail_domains AS domain
          ON domain.id = NEW.mail_domain_id
         AND domain.status = 'active'
        WHERE operation.id = NEW.receive_operation_id
    )
)
BEGIN
    SELECT RAISE(ABORT, '冻结收信路由与接受时地址状态不匹配');
END;

CREATE TRIGGER prevent_receive_route_identity_change
BEFORE UPDATE OF
    receive_operation_id,
    sequence_number,
    envelope_recipient_text,
    canonical_recipient_address,
    mail_domain_id,
    route_kind,
    address_id,
    address_binding_id,
    unallocated_period_id,
    rejection_code,
    decided_at,
    created_at
ON receive_operation_routes
BEGIN
    SELECT RAISE(ABORT, '冻结收信路由不可改指');
END;

CREATE TRIGGER validate_receive_route_commit
BEFORE UPDATE OF route_status, message_delivery_id, committed_at
ON receive_operation_routes
WHEN NEW.route_status = 'committed'
  AND NOT (
      OLD.route_status = 'accepted'
      AND NEW.message_delivery_id IS NOT NULL
      AND EXISTS (
          SELECT 1
          FROM receive_operations AS operation
          JOIN message_deliveries AS delivery
            ON delivery.id = NEW.message_delivery_id
           AND delivery.message_id = operation.message_id
           AND delivery.canonical_recipient_address = NEW.canonical_recipient_address COLLATE NOCASE
           AND delivery.display_recipient_address = NEW.envelope_recipient_text
           AND delivery.delivery_source = 'external_receive'
           AND (
               (NEW.route_kind = 'assigned'
                   AND delivery.target_type = 'assigned'
                   AND delivery.address_binding_id = NEW.address_binding_id)
               OR (NEW.route_kind = 'unallocated'
                   AND delivery.target_type = 'unallocated'
                   AND delivery.unallocated_period_id = NEW.unallocated_period_id)
           )
          WHERE operation.id = NEW.receive_operation_id
            AND operation.message_id IS NOT NULL
      )
  )
BEGIN
    SELECT RAISE(ABORT, '收信路由与最终实际投递不匹配');
END;

CREATE TRIGGER prevent_receive_route_reopen
BEFORE UPDATE OF route_status ON receive_operation_routes
WHEN NEW.route_status <> OLD.route_status
  AND NOT (OLD.route_status = 'accepted' AND NEW.route_status = 'committed')
BEGIN
    SELECT RAISE(ABORT, '收信路由状态不可倒退或重开');
END;

CREATE TABLE background_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    task_type TEXT NOT NULL CHECK (length(task_type) > 0),
    target_type TEXT NOT NULL CHECK (length(target_type) > 0),
    target_reference TEXT NOT NULL CHECK (length(target_reference) > 0),
    input_version INTEGER NOT NULL CHECK (input_version >= 1),
    task_key_digest BLOB NOT NULL UNIQUE CHECK (length(task_key_digest) = 32),
    task_status TEXT NOT NULL CHECK (
        task_status IN ('pending', 'running', 'retry_wait', 'needs_attention', 'succeeded', 'cancelled')
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
    task_type,
    target_type,
    target_reference,
    input_version,
    task_key_digest,
    max_attempts,
    created_at
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
        AND NEW.task_status IN ('retry_wait', 'needs_attention', 'succeeded', 'cancelled')
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
            'running',
            'succeeded',
            'retry_scheduled',
            'needs_attention',
            'cancelled',
            'abandoned'
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
        error_code IS NULL OR attempt_status IN ('retry_scheduled', 'needs_attention', 'abandoned')
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
    task_id,
    attempt_number,
    lease_token,
    worker_reference,
    started_at,
    created_at
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
          'succeeded',
          'retry_scheduled',
          'needs_attention',
          'cancelled',
          'abandoned'
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

CREATE TABLE reconciliation_runs (
    id TEXT PRIMARY KEY NOT NULL,
    background_task_id TEXT,
    reconciliation_kind TEXT NOT NULL CHECK (
        reconciliation_kind IN ('due_tasks', 'object_inventory', 'object_integrity', 'orphan_recheck')
    ),
    storage_mode TEXT CHECK (storage_mode IS NULL OR storage_mode IN ('kv', 'r2')),
    batch_number INTEGER NOT NULL CHECK (batch_number >= 1),
    cursor_before TEXT,
    cursor_after TEXT,
    run_status TEXT NOT NULL CHECK (
        run_status IN ('running', 'paused', 'succeeded', 'failed')
    ),
    scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
    finding_count INTEGER NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
    repaired_count INTEGER NOT NULL DEFAULT 0 CHECK (repaired_count >= 0),
    error_code TEXT,
    error_summary TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (reconciliation_kind = 'due_tasks' AND storage_mode IS NULL)
        OR (reconciliation_kind <> 'due_tasks' AND storage_mode IS NOT NULL)
    ),
    CHECK (
        (run_status = 'running' AND completed_at IS NULL)
        OR (run_status IN ('paused', 'succeeded', 'failed')
            AND completed_at IS NOT NULL
            AND completed_at >= started_at)
    ),
    CHECK (run_status <> 'failed' OR error_code IS NOT NULL),
    FOREIGN KEY (background_task_id) REFERENCES background_tasks (id) ON DELETE SET NULL
);

CREATE INDEX reconciliation_runs_kind_index
    ON reconciliation_runs (reconciliation_kind, storage_mode, started_at DESC, id DESC);

CREATE INDEX reconciliation_runs_status_index
    ON reconciliation_runs (run_status, started_at, id);

CREATE TRIGGER prevent_reconciliation_run_identity_change
BEFORE UPDATE OF
    background_task_id,
    reconciliation_kind,
    storage_mode,
    batch_number,
    cursor_before,
    started_at,
    created_at
ON reconciliation_runs
BEGIN
    SELECT RAISE(ABORT, '对账批次身份与起始游标不可修改');
END;

CREATE TRIGGER validate_reconciliation_run_transition
BEFORE UPDATE OF run_status ON reconciliation_runs
WHEN NEW.run_status <> OLD.run_status
  AND NOT (
      OLD.run_status = 'running'
      AND NEW.run_status IN ('paused', 'succeeded', 'failed')
  )
BEGIN
    SELECT RAISE(ABORT, '对账批次终态不可重开');
END;

CREATE TABLE object_reconciliation_findings (
    id TEXT PRIMARY KEY NOT NULL,
    finding_kind TEXT NOT NULL CHECK (
        finding_kind IN ('orphan', 'missing', 'hash_mismatch')
    ),
    object_registry_id TEXT,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
    observed_object_key TEXT NOT NULL CHECK (length(observed_object_key) > 0),
    finding_status TEXT NOT NULL CHECK (
        finding_status IN ('open', 'resolved', 'delete_scheduled', 'deleted')
    ),
    first_run_id TEXT NOT NULL,
    last_run_id TEXT NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 1 CHECK (observation_count >= 1),
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    protected_until INTEGER,
    delete_scheduled_at INTEGER,
    resolved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (last_observed_at >= first_observed_at),
    CHECK (
        (finding_kind = 'orphan'
            AND object_registry_id IS NULL
            AND protected_until IS NOT NULL)
        OR (finding_kind IN ('missing', 'hash_mismatch')
            AND object_registry_id IS NOT NULL
            AND protected_until IS NULL)
    ),
    CHECK (
        observation_count = 1 OR first_run_id <> last_run_id
    ),
    CHECK (
        (finding_status = 'open'
            AND delete_scheduled_at IS NULL
            AND resolved_at IS NULL)
        OR (finding_status = 'resolved'
            AND delete_scheduled_at IS NULL
            AND resolved_at IS NOT NULL)
        OR (finding_status = 'delete_scheduled'
            AND finding_kind = 'orphan'
            AND observation_count >= 2
            AND first_run_id <> last_run_id
            AND delete_scheduled_at IS NOT NULL
            AND delete_scheduled_at >= protected_until
            AND resolved_at IS NULL)
        OR (finding_status = 'deleted'
            AND finding_kind = 'orphan'
            AND delete_scheduled_at IS NOT NULL
            AND resolved_at IS NOT NULL
            AND resolved_at >= delete_scheduled_at)
    ),
    FOREIGN KEY (object_registry_id) REFERENCES object_registry (id) ON DELETE RESTRICT,
    FOREIGN KEY (first_run_id) REFERENCES reconciliation_runs (id) ON DELETE RESTRICT,
    FOREIGN KEY (last_run_id) REFERENCES reconciliation_runs (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX object_findings_open_orphan_unique
    ON object_reconciliation_findings (storage_mode, observed_object_key)
    WHERE finding_kind = 'orphan' AND finding_status IN ('open', 'delete_scheduled');

CREATE UNIQUE INDEX object_findings_open_registered_unique
    ON object_reconciliation_findings (object_registry_id, finding_kind)
    WHERE object_registry_id IS NOT NULL AND finding_status = 'open';

CREATE INDEX object_findings_status_index
    ON object_reconciliation_findings (finding_status, finding_kind, protected_until, id);

CREATE TRIGGER validate_registered_object_finding_insert
BEFORE INSERT ON object_reconciliation_findings
WHEN NEW.object_registry_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM object_registry AS object
      WHERE object.id = NEW.object_registry_id
        AND object.storage_mode = NEW.storage_mode
        AND object.object_key = NEW.observed_object_key
  )
BEGIN
    SELECT RAISE(ABORT, '对象异常发现与登记对象不匹配');
END;

CREATE TRIGGER prevent_object_finding_identity_change
BEFORE UPDATE OF
    finding_kind,
    object_registry_id,
    storage_mode,
    observed_object_key,
    first_run_id,
    first_observed_at,
    protected_until,
    created_at
ON object_reconciliation_findings
BEGIN
    SELECT RAISE(ABORT, '对象对账发现身份不可修改');
END;

CREATE TRIGGER validate_object_finding_observation_advance
BEFORE UPDATE OF observation_count, last_run_id, last_observed_at
ON object_reconciliation_findings
WHEN NOT (
    (NEW.observation_count = OLD.observation_count
        AND NEW.last_run_id = OLD.last_run_id
        AND NEW.last_observed_at = OLD.last_observed_at)
    OR (OLD.finding_status = 'open'
        AND NEW.observation_count = OLD.observation_count + 1
        AND NEW.last_run_id <> OLD.last_run_id
        AND NEW.last_observed_at >= OLD.last_observed_at)
)
BEGIN
    SELECT RAISE(ABORT, '对象重复观察必须来自新的对账批次并逐次增加');
END;

CREATE TRIGGER validate_object_finding_status_transition
BEFORE UPDATE OF finding_status ON object_reconciliation_findings
WHEN NEW.finding_status <> OLD.finding_status
  AND NOT (
      (OLD.finding_status = 'open' AND NEW.finding_status IN ('resolved', 'delete_scheduled'))
      OR (OLD.finding_status = 'delete_scheduled' AND NEW.finding_status IN ('resolved', 'deleted'))
  )
BEGIN
    SELECT RAISE(ABORT, '对象对账发现状态不能倒退或重开');
END;

ALTER TABLE message_deduplication_keys
    ADD COLUMN receive_operation_id TEXT REFERENCES receive_operations (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX message_deduplication_receive_operation_unique
    ON message_deduplication_keys (receive_operation_id)
    WHERE receive_operation_id IS NOT NULL;

CREATE TRIGGER validate_receive_deduplication_key_insert
BEFORE INSERT ON message_deduplication_keys
WHEN NEW.receive_operation_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM receive_operations AS operation
      WHERE operation.id = NEW.receive_operation_id
        AND operation.source_kind = NEW.source_kind
        AND operation.deduplication_key_digest = NEW.key_digest
        AND operation.message_id = NEW.message_id
        AND operation.operation_status IN ('committing', 'visible')
  )
BEGIN
    SELECT RAISE(ABORT, '最终收信防重关系与收信操作不匹配');
END;

CREATE TRIGGER prevent_receive_deduplication_key_change
BEFORE UPDATE OF receive_operation_id ON message_deduplication_keys
WHEN NEW.receive_operation_id IS NOT OLD.receive_operation_id
BEGIN
    SELECT RAISE(ABORT, '最终收信防重关系不可改指');
END;

CREATE TRIGGER validate_receive_operation_visible
BEFORE UPDATE OF operation_status ON receive_operations
WHEN NEW.operation_status = 'visible'
  AND (
      NEW.message_id IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM message_integrity_states AS integrity
          WHERE integrity.message_id = NEW.message_id
            AND integrity.integrity_status = 'ready'
            AND integrity.source_completeness = 'raw_mime'
      )
      OR NOT EXISTS (
          SELECT 1
          FROM object_registry AS object
          WHERE object.id = NEW.raw_object_id
            AND object.message_id = NEW.message_id
            AND object.object_role = 'raw_mime'
            AND object.is_current = 1
            AND object.object_status = 'active'
      )
      OR NOT EXISTS (
          SELECT 1
          FROM receive_operation_routes AS route
          WHERE route.receive_operation_id = NEW.id
            AND route.route_status = 'committed'
      )
      OR EXISTS (
          SELECT 1
          FROM receive_operation_routes AS route
          WHERE route.receive_operation_id = NEW.id
            AND route.route_status = 'accepted'
      )
      OR NOT EXISTS (
          SELECT 1
          FROM message_deduplication_keys AS deduplication
          WHERE deduplication.receive_operation_id = NEW.id
            AND deduplication.message_id = NEW.message_id
      )
      OR NOT EXISTS (
          SELECT 1
          FROM mailbox_entries AS entry
          WHERE entry.message_id = NEW.message_id
            AND entry.entry_kind = 'received'
      )
      OR NOT EXISTS (
          SELECT 1
          FROM background_tasks AS task
          WHERE task.task_type = 'index_message'
            AND task.target_type = 'message'
            AND task.target_reference = NEW.message_id
            AND task.input_version = (
                SELECT integrity.object_set_version
                FROM message_integrity_states AS integrity
                WHERE integrity.message_id = NEW.message_id
            )
            AND task.task_status IN ('pending', 'running', 'retry_wait', 'needs_attention', 'succeeded')
      )
  )
BEGIN
    SELECT RAISE(ABORT, '收信操作缺少完整对象、投递、防重、邮箱或搜索任务关系');
END;

ALTER TABLE send_operations
    ADD COLUMN final_mime_object_id TEXT REFERENCES object_registry (id) ON DELETE RESTRICT;

ALTER TABLE send_operations
    ADD COLUMN payload_generator_version TEXT;

CREATE UNIQUE INDEX send_operations_final_mime_object_unique
    ON send_operations (final_mime_object_id)
    WHERE final_mime_object_id IS NOT NULL;

CREATE TRIGGER validate_send_operation_final_mime_insert
BEFORE INSERT ON send_operations
WHEN NEW.final_mime_object_id IS NULL
  OR NEW.payload_generator_version IS NULL
  OR length(NEW.payload_generator_version) = 0
  OR NOT EXISTS (
      SELECT 1
      FROM object_registry AS object
      JOIN message_integrity_states AS integrity
        ON integrity.message_id = NEW.message_id
       AND integrity.integrity_status = 'ready'
       AND integrity.source_completeness = 'final_mime'
      WHERE object.id = NEW.final_mime_object_id
        AND object.message_id = NEW.message_id
        AND object.object_role = 'final_mime'
        AND object.is_current = 1
        AND object.object_status = 'active'
        AND object.actual_size_bytes = NEW.payload_size_bytes
        AND object.actual_sha256 = NEW.payload_sha256
        AND object.producer_version = NEW.payload_generator_version
  )
BEGIN
    SELECT RAISE(ABORT, '发送操作必须引用匹配的最终MIME对象');
END;

CREATE TRIGGER prevent_send_operation_final_mime_change
BEFORE UPDATE OF final_mime_object_id, payload_generator_version
ON send_operations
BEGIN
    SELECT RAISE(ABORT, '发送操作的最终MIME快照不可修改');
END;
