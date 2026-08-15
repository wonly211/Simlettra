-- 澄笺 | Simlettra 草稿与写信编辑正式迁移
-- 依据：已接受 ADR 0019、0022 和需求 6.01、6.06、7.01 至 7.06。

PRAGMA defer_foreign_keys = ON;

-- 扩展统一对象登记，使草稿正文和草稿附件与邮件对象共用生命周期模型。
DROP TRIGGER validate_message_ready_insert;
DROP TRIGGER validate_receive_raw_object_update;

-- D1 迁移在隐式事务中始终执行外键约束，不能依靠关闭 foreign_keys 重建父表。
-- 先快照并移除对象登记的直接引用链，随后按原结构回填，保留全部历史收信数据。
CREATE TABLE receive_operation_routes_before_drafts AS SELECT * FROM receive_operation_routes;
CREATE TABLE message_deduplication_keys_before_drafts AS SELECT * FROM message_deduplication_keys;
DROP TABLE receive_operation_routes;
DROP TABLE message_deduplication_keys;

CREATE TABLE receive_operations_before_drafts AS SELECT * FROM receive_operations;
DROP TABLE receive_operations;

CREATE TABLE object_registry_before_drafts AS SELECT * FROM object_registry;
DROP TABLE object_registry;

CREATE TABLE object_registry (
    id TEXT PRIMARY KEY NOT NULL,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
    object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('message', 'draft')),
    owner_reference TEXT NOT NULL CHECK (length(owner_reference) > 0),
    message_id TEXT,
    object_role TEXT NOT NULL CHECK (
        object_role IN (
            'raw_mime', 'plain_body', 'html_body', 'attachment', 'inline_resource',
            'final_mime', 'draft_body', 'draft_attachment'
        )
    ),
    logical_part_key TEXT NOT NULL CHECK (length(logical_part_key) > 0),
    sequence_number INTEGER NOT NULL DEFAULT 0 CHECK (sequence_number >= 0),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    required_for_visibility INTEGER NOT NULL DEFAULT 1 CHECK (required_for_visibility IN (0, 1)),
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
            'write_intent', 'stored', 'waiting_consistency', 'verified', 'active',
            'superseded', 'missing', 'damaged', 'pending_delete', 'deleted'
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
        (owner_kind = 'message' AND object_role NOT IN ('draft_body', 'draft_attachment'))
        OR (owner_kind = 'draft' AND object_role IN ('draft_body', 'draft_attachment') AND message_id IS NULL)
    ),
    CHECK (message_id IS NULL OR (owner_kind = 'message' AND message_id = owner_reference)),
    CHECK (
        object_role IN ('attachment', 'inline_resource', 'draft_attachment')
        OR (untrusted_file_name IS NULL AND content_disposition IS NULL AND content_id IS NULL)
    ),
    CHECK (
        object_role NOT IN ('attachment', 'draft_attachment')
        OR (untrusted_file_name IS NOT NULL AND length(untrusted_file_name) > 0 AND content_disposition = 'attachment')
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
        OR (actual_size_bytes = expected_size_bytes AND actual_sha256 = expected_sha256 AND verified_at IS NOT NULL)
    ),
    CHECK (
        (object_status IN ('write_intent', 'stored', 'waiting_consistency', 'verified') AND is_current = 0)
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
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT
);

INSERT INTO object_registry SELECT * FROM object_registry_before_drafts;
DROP TABLE object_registry_before_drafts;

CREATE UNIQUE INDEX object_registry_current_part_unique
    ON object_registry (owner_kind, owner_reference, object_role, logical_part_key)
    WHERE is_current = 1;

CREATE INDEX object_registry_message_index
    ON object_registry (message_id, object_role, is_current, sequence_number)
    WHERE message_id IS NOT NULL;

CREATE INDEX object_registry_work_index
    ON object_registry (object_status, storage_mode, updated_at, id);

CREATE TRIGGER prevent_object_registry_identity_change
BEFORE UPDATE OF
    storage_mode, object_key, owner_kind, owner_reference,
    object_role, logical_part_key, sequence_number, generation,
    required_for_visibility, expected_size_bytes, expected_sha256,
    media_type, untrusted_file_name, content_disposition,
    content_id, producer_version, created_at
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
      AND EXISTS (SELECT 1 FROM messages WHERE id = NEW.message_id)
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
BEFORE UPDATE OF object_status, is_current ON object_registry
WHEN (NEW.object_status <> OLD.object_status OR NEW.is_current <> OLD.is_current)
AND NOT (
    (OLD.object_status = 'write_intent' AND NEW.object_status IN ('stored', 'waiting_consistency', 'verified', 'damaged', 'pending_delete'))
    OR (OLD.object_status = 'stored' AND NEW.object_status IN ('waiting_consistency', 'verified', 'damaged', 'pending_delete'))
    OR (OLD.object_status = 'waiting_consistency' AND NEW.object_status IN ('verified', 'damaged', 'pending_delete'))
    OR (OLD.object_status = 'verified' AND NEW.object_status IN ('active', 'damaged', 'pending_delete'))
    OR (OLD.object_status = 'active' AND NEW.object_status IN ('missing', 'damaged', 'superseded', 'pending_delete'))
    OR (OLD.object_status IN ('missing', 'damaged') AND NEW.object_status IN ('active', 'superseded', 'pending_delete'))
    OR (OLD.object_status = 'superseded' AND NEW.object_status = 'pending_delete')
    OR (OLD.object_status = 'pending_delete' AND NEW.object_status = 'deleted')
)
BEGIN
    SELECT RAISE(ABORT, '对象状态不能倒退或跳过校验');
END;

CREATE TRIGGER validate_message_ready_insert
BEFORE INSERT ON message_integrity_states
WHEN NEW.integrity_status = 'ready'
AND (
    NEW.source_completeness <> 'raw_mime'
    OR NOT EXISTS (
        SELECT 1 FROM object_registry
        WHERE message_id = NEW.message_id AND object_role = 'raw_mime'
          AND is_current = 1 AND object_status = 'active'
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

CREATE TABLE receive_operations (
    id TEXT PRIMARY KEY NOT NULL,
    source_kind TEXT NOT NULL CHECK (length(source_kind) > 0),
    source_event_reference TEXT,
    deduplication_kind TEXT NOT NULL CHECK (
        deduplication_kind IN ('provider_event', 'bounded_fingerprint')
    ),
    deduplication_key_digest BLOB NOT NULL CHECK (length(deduplication_key_digest) = 32),
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
            'intent', 'raw_stored', 'parsing', 'derived_stored',
            'waiting_consistency', 'committing', 'visible',
            'parse_failed', 'damaged', 'rejected', 'needs_attention'
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
        (deduplication_kind = 'provider_event' AND source_event_reference IS NOT NULL
            AND deduplication_window_started_at IS NULL AND deduplication_expires_at IS NULL)
        OR (deduplication_kind = 'bounded_fingerprint'
            AND deduplication_window_started_at IS NOT NULL
            AND deduplication_expires_at > deduplication_window_started_at)
    ),
    CHECK (message_id IS NULL OR message_id = message_reference),
    CHECK (operation_status IN ('intent', 'rejected') OR raw_object_id IS NOT NULL),
    CHECK (
        (operation_status = 'visible' AND message_id IS NOT NULL AND visible_at IS NOT NULL AND completed_at IS NOT NULL)
        OR (operation_status IN ('parse_failed', 'damaged', 'rejected', 'needs_attention')
            AND visible_at IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL)
        OR (operation_status IN ('intent', 'raw_stored', 'parsing', 'derived_stored', 'waiting_consistency', 'committing')
            AND visible_at IS NULL AND completed_at IS NULL)
    ),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (raw_object_id) REFERENCES object_registry (id) ON DELETE RESTRICT
);

INSERT INTO receive_operations SELECT * FROM receive_operations_before_drafts;
DROP TABLE receive_operations_before_drafts;

CREATE INDEX receive_operations_work_index
    ON receive_operations (operation_status, updated_at, id);

CREATE INDEX receive_operations_window_expiry_index
    ON receive_operations (deduplication_expires_at, id)
    WHERE deduplication_expires_at IS NOT NULL;

CREATE TRIGGER prevent_receive_operation_identity_change
BEFORE UPDATE OF
    source_kind, source_event_reference, deduplication_kind,
    deduplication_key_digest, deduplication_window_started_at,
    deduplication_expires_at, message_reference, raw_size_bytes,
    raw_sha256, envelope_sender_text, accepted_at, created_at
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
        SELECT 1 FROM messages
        WHERE id = NEW.message_id AND origin_type = 'received'
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
    canonical_recipient_address TEXT COLLATE NOCASE NOT NULL,
    display_recipient_address TEXT NOT NULL,
    domain_id TEXT NOT NULL,
    address_id TEXT NOT NULL,
    address_binding_id TEXT NOT NULL,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'organization')),
    user_id TEXT,
    organization_id TEXT,
    route_status TEXT NOT NULL CHECK (route_status IN ('accepted', 'rejected', 'committed')),
    rejection_code TEXT,
    delivery_id TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    committed_at INTEGER,
    UNIQUE (receive_operation_id, sequence_number),
    UNIQUE (receive_operation_id, canonical_recipient_address),
    CHECK (
        (owner_type = 'user' AND user_id IS NOT NULL AND organization_id IS NULL)
        OR (owner_type = 'organization' AND user_id IS NULL AND organization_id IS NOT NULL)
    ),
    CHECK (
        (route_status = 'accepted' AND rejection_code IS NULL AND delivery_id IS NULL AND committed_at IS NULL)
        OR (route_status = 'rejected' AND rejection_code IS NOT NULL AND delivery_id IS NULL AND committed_at IS NULL)
        OR (route_status = 'committed' AND rejection_code IS NULL AND delivery_id IS NOT NULL AND committed_at IS NOT NULL)
    ),
    FOREIGN KEY (receive_operation_id) REFERENCES receive_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (domain_id) REFERENCES mail_domains (id) ON DELETE RESTRICT,
    FOREIGN KEY (address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT,
    FOREIGN KEY (address_binding_id) REFERENCES address_bindings (id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    FOREIGN KEY (delivery_id) REFERENCES message_deliveries (id) ON DELETE RESTRICT
);

INSERT INTO receive_operation_routes SELECT * FROM receive_operation_routes_before_drafts;
DROP TABLE receive_operation_routes_before_drafts;

CREATE INDEX receive_operation_routes_operation_index
    ON receive_operation_routes (receive_operation_id, route_status, sequence_number);

CREATE TRIGGER validate_receive_route_insert
BEFORE INSERT ON receive_operation_routes
WHEN NEW.route_status = 'accepted'
AND NOT EXISTS (
    SELECT 1
    FROM email_addresses AS address
    JOIN address_claims AS claim
      ON claim.address_id = address.id
     AND claim.canonical_address = address.canonical_address
     AND claim.status = 'active'
     AND claim.reserved_until IS NULL
    JOIN mail_domains AS domain
      ON domain.id = address.domain_id
     AND domain.status = 'active'
    JOIN address_bindings AS binding
      ON binding.id = NEW.address_binding_id
     AND binding.address_id = address.id
     AND binding.ended_at IS NULL
    LEFT JOIN users AS user ON user.id = binding.user_id
    LEFT JOIN organizations AS organization ON organization.id = binding.organization_id
    WHERE address.id = NEW.address_id
      AND address.domain_id = NEW.domain_id
      AND address.retired_at IS NULL
      AND address.canonical_address = NEW.canonical_recipient_address
      AND binding.owner_type = NEW.owner_type
      AND binding.user_id IS NEW.user_id
      AND binding.organization_id IS NEW.organization_id
      AND (
          (NEW.owner_type = 'user' AND user.status = 'active')
          OR (NEW.owner_type = 'organization' AND organization.status = 'active')
      )
)
BEGIN
    SELECT RAISE(ABORT, '收信路由当前不可接受');
END;

CREATE TRIGGER prevent_receive_route_identity_change
BEFORE UPDATE OF
    receive_operation_id, sequence_number, canonical_recipient_address,
    display_recipient_address, domain_id, address_id, address_binding_id,
    owner_type, user_id, organization_id, created_at
ON receive_operation_routes
BEGIN
    SELECT RAISE(ABORT, '已冻结收信路由不可修改');
END;

CREATE TRIGGER validate_receive_route_commit
BEFORE UPDATE OF route_status, delivery_id, committed_at ON receive_operation_routes
WHEN NEW.route_status <> OLD.route_status
AND NOT (
    OLD.route_status = 'accepted'
    AND NEW.route_status = 'committed'
    AND EXISTS (
        SELECT 1
        FROM receive_operations AS operation
        JOIN message_deliveries AS delivery
          ON delivery.id = NEW.delivery_id
         AND delivery.message_id = operation.message_id
         AND delivery.address_binding_id = OLD.address_binding_id
         AND delivery.canonical_recipient_address = OLD.canonical_recipient_address
        WHERE operation.id = OLD.receive_operation_id
          AND operation.message_id IS NOT NULL
    )
)
BEGIN
    SELECT RAISE(ABORT, '冻结路由与最终投递不匹配');
END;

CREATE TABLE message_deduplication_keys (
    source_kind TEXT NOT NULL CHECK (length(source_kind) > 0),
    key_digest BLOB NOT NULL CHECK (length(key_digest) = 32),
    receive_operation_id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_kind, key_digest),
    FOREIGN KEY (receive_operation_id) REFERENCES receive_operations (id) ON DELETE RESTRICT,
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT
);

INSERT INTO message_deduplication_keys SELECT * FROM message_deduplication_keys_before_drafts;
DROP TABLE message_deduplication_keys_before_drafts;

CREATE INDEX message_deduplication_keys_message_index
    ON message_deduplication_keys (message_id);

CREATE TRIGGER validate_receive_raw_object_update
BEFORE UPDATE OF raw_object_id ON receive_operations
WHEN NEW.raw_object_id IS NOT OLD.raw_object_id
AND NOT (
    OLD.raw_object_id IS NULL
    AND EXISTS (
        SELECT 1 FROM object_registry AS object
        WHERE object.id = NEW.raw_object_id
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

CREATE TRIGGER validate_visible_receive_has_search_task
BEFORE UPDATE OF operation_status ON receive_operations
WHEN NEW.operation_status = 'visible'
  AND NOT EXISTS (
      SELECT 1
      FROM message_search_states AS state
      JOIN background_tasks AS task
        ON task.task_type = 'index_message'
       AND task.target_type = 'message_search'
       AND task.target_reference = state.message_id
       AND task.input_version = state.index_generation
       AND task.task_status IN (
           'pending', 'running', 'retry_wait', 'needs_attention', 'succeeded'
       )
      WHERE state.message_id = NEW.message_id
        AND state.object_set_version = (
            SELECT object_set_version
            FROM message_integrity_states
            WHERE message_id = NEW.message_id
        )
  )
BEGIN
    SELECT RAISE(ABORT, '收信可见事务缺少搜索状态或索引任务');
END;

CREATE TRIGGER validate_visible_receive_has_conversation_task
BEFORE UPDATE OF operation_status ON receive_operations
WHEN NEW.operation_status = 'visible'
  AND NOT EXISTS (
      SELECT 1 FROM background_tasks AS task
      WHERE task.task_type = 'rebuild_conversation'
        AND task.target_type = 'message_conversation'
        AND task.target_reference = NEW.message_id
        AND task.task_status IN (
          'pending', 'running', 'retry_wait', 'needs_attention', 'succeeded'
        )
  )
BEGIN
    SELECT RAISE(ABORT, '收信可见事务缺少会话重建任务');
END;

CREATE TABLE drafts (
    id TEXT PRIMARY KEY NOT NULL,
    owner_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'trashed', 'consumed', 'deleting')),
    sender_address_id TEXT,
    compose_kind TEXT NOT NULL CHECK (compose_kind IN ('new', 'reply', 'reply_all', 'forward')),
    source_message_id TEXT,
    source_reference TEXT,
    conflict_parent_draft_id TEXT,
    current_revision_number INTEGER NOT NULL DEFAULT 1 CHECK (current_revision_number >= 1),
    trashed_at INTEGER,
    trash_due_at INTEGER,
    consumed_at INTEGER,
    deleting_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (compose_kind = 'new' AND source_message_id IS NULL AND source_reference IS NULL)
        OR (compose_kind IN ('reply', 'reply_all', 'forward') AND source_reference IS NOT NULL AND length(source_reference) > 0)
    ),
    CHECK (
        (status = 'active' AND trashed_at IS NULL AND trash_due_at IS NULL AND consumed_at IS NULL AND deleting_at IS NULL)
        OR (status = 'trashed' AND trashed_at IS NOT NULL AND trash_due_at > trashed_at AND consumed_at IS NULL AND deleting_at IS NULL)
        OR (status = 'consumed' AND trashed_at IS NULL AND trash_due_at IS NULL AND consumed_at IS NOT NULL AND deleting_at IS NULL)
        OR (status = 'deleting' AND deleting_at IS NOT NULL)
    ),
    CHECK (conflict_parent_draft_id IS NULL OR conflict_parent_draft_id <> id),
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (sender_address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT,
    FOREIGN KEY (source_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (conflict_parent_draft_id) REFERENCES drafts (id) ON DELETE SET NULL
);

CREATE INDEX drafts_owner_list_index ON drafts (owner_user_id, status, updated_at DESC, id DESC);
CREATE INDEX drafts_trash_expiry_index ON drafts (trash_due_at, id) WHERE status = 'trashed';
CREATE INDEX drafts_conflict_parent_index ON drafts (conflict_parent_draft_id, created_at, id) WHERE conflict_parent_draft_id IS NOT NULL;

CREATE TRIGGER validate_draft_conflict_parent_insert
BEFORE INSERT ON drafts
WHEN NEW.conflict_parent_draft_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM drafts parent
    WHERE parent.id = NEW.conflict_parent_draft_id AND parent.owner_user_id = NEW.owner_user_id
)
BEGIN
    SELECT RAISE(ABORT, '冲突副本必须属于原草稿所有者');
END;

CREATE TRIGGER prevent_draft_owner_change
BEFORE UPDATE OF owner_user_id ON drafts
WHEN NEW.owner_user_id <> OLD.owner_user_id
BEGIN
    SELECT RAISE(ABORT, '草稿所有者不可修改');
END;

CREATE TRIGGER validate_draft_revision_advance
BEFORE UPDATE OF current_revision_number ON drafts
WHEN NEW.current_revision_number <> OLD.current_revision_number + 1 OR OLD.status <> 'active' OR NEW.status <> 'active'
BEGIN
    SELECT RAISE(ABORT, '草稿修订号必须逐次增加');
END;

CREATE TRIGGER validate_draft_status_transition
BEFORE UPDATE OF status ON drafts
WHEN NEW.status <> OLD.status AND NOT (
    (OLD.status = 'active' AND NEW.status IN ('trashed', 'consumed', 'deleting'))
    OR (OLD.status = 'trashed' AND NEW.status IN ('active', 'deleting'))
    OR (OLD.status = 'consumed' AND NEW.status = 'deleting')
)
BEGIN
    SELECT RAISE(ABORT, '草稿生命周期不能倒退或跳转');
END;

CREATE TABLE draft_contents (
    draft_id TEXT PRIMARY KEY NOT NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    subject TEXT NOT NULL DEFAULT '',
    body_format TEXT NOT NULL CHECK (body_format IN ('rich_text', 'plain_text')),
    body_content_generation INTEGER NOT NULL CHECK (body_content_generation >= 1),
    content_digest BLOB NOT NULL CHECK (length(content_digest) = 32),
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (draft_id) REFERENCES drafts (id) ON DELETE CASCADE
);

CREATE TABLE draft_recipients (
    id TEXT PRIMARY KEY NOT NULL,
    draft_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    recipient_role TEXT NOT NULL CHECK (recipient_role IN ('to', 'cc', 'bcc')),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    display_name TEXT,
    address_text TEXT NOT NULL CHECK (length(address_text) > 0),
    canonical_address TEXT COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    UNIQUE (draft_id, recipient_role, sequence_number),
    FOREIGN KEY (draft_id) REFERENCES drafts (id) ON DELETE CASCADE
);

CREATE INDEX draft_recipients_address_index ON draft_recipients (canonical_address, draft_id) WHERE canonical_address IS NOT NULL;

CREATE TABLE draft_attachments (
    id TEXT PRIMARY KEY NOT NULL,
    draft_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    untrusted_file_name TEXT NOT NULL CHECK (length(untrusted_file_name) BETWEEN 1 AND 512),
    media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    content_sha256 BLOB NOT NULL CHECK (length(content_sha256) = 32),
    content_generation INTEGER NOT NULL CHECK (content_generation >= 1),
    integrity_checked_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (draft_id, sequence_number),
    FOREIGN KEY (draft_id) REFERENCES drafts (id) ON DELETE CASCADE
);

CREATE INDEX draft_attachments_draft_revision_index ON draft_attachments (draft_id, revision_number, sequence_number);

CREATE TABLE draft_mutation_keys (
    draft_id TEXT NOT NULL,
    mutation_key_digest BLOB NOT NULL CHECK (length(mutation_key_digest) = 32),
    input_digest BLOB NOT NULL CHECK (length(input_digest) = 32),
    expected_revision_number INTEGER NOT NULL CHECK (expected_revision_number >= 1),
    result_kind TEXT NOT NULL CHECK (result_kind IN ('updated', 'conflict_copy')),
    result_draft_id TEXT NOT NULL,
    result_revision_number INTEGER NOT NULL CHECK (result_revision_number >= 1),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (draft_id, mutation_key_digest),
    FOREIGN KEY (draft_id) REFERENCES drafts (id) ON DELETE CASCADE,
    FOREIGN KEY (result_draft_id) REFERENCES drafts (id) ON DELETE CASCADE
);

CREATE INDEX draft_mutation_keys_result_index ON draft_mutation_keys (result_draft_id, result_revision_number);

CREATE TRIGGER validate_draft_content_insert
BEFORE INSERT ON draft_contents
WHEN NOT EXISTS (
    SELECT 1 FROM drafts draft
    WHERE draft.id = NEW.draft_id AND draft.status = 'active'
      AND NEW.revision_number IN (draft.current_revision_number, draft.current_revision_number + 1)
) OR NOT EXISTS (
    SELECT 1 FROM object_registry object
    WHERE object.owner_kind = 'draft' AND object.owner_reference = NEW.draft_id
      AND object.object_role = 'draft_body' AND object.logical_part_key = 'body'
      AND object.generation = NEW.body_content_generation
      AND object.object_status = 'active' AND object.is_current = 1
)
BEGIN
    SELECT RAISE(ABORT, '草稿正文修订或对象不完整');
END;

CREATE TRIGGER validate_draft_content_update
BEFORE UPDATE ON draft_contents
WHEN NEW.draft_id <> OLD.draft_id OR NOT EXISTS (
    SELECT 1 FROM drafts draft
    WHERE draft.id = NEW.draft_id AND draft.status = 'active'
      AND NEW.revision_number IN (draft.current_revision_number, draft.current_revision_number + 1)
) OR NOT EXISTS (
    SELECT 1 FROM object_registry object
    WHERE object.owner_kind = 'draft' AND object.owner_reference = NEW.draft_id
      AND object.object_role = 'draft_body' AND object.logical_part_key = 'body'
      AND object.generation = NEW.body_content_generation
      AND object.object_status = 'active' AND object.is_current = 1
)
BEGIN
    SELECT RAISE(ABORT, '草稿正文修订或对象不完整');
END;

CREATE TRIGGER validate_draft_recipient_insert
BEFORE INSERT ON draft_recipients
WHEN NOT EXISTS (
    SELECT 1 FROM drafts draft
    WHERE draft.id = NEW.draft_id AND draft.status = 'active'
      AND NEW.revision_number IN (draft.current_revision_number, draft.current_revision_number + 1)
)
BEGIN
    SELECT RAISE(ABORT, '草稿收件人修订号无效');
END;

CREATE TRIGGER validate_draft_recipient_update
BEFORE UPDATE ON draft_recipients
WHEN NEW.draft_id <> OLD.draft_id OR NOT EXISTS (
    SELECT 1 FROM drafts draft
    WHERE draft.id = NEW.draft_id AND draft.status = 'active'
      AND NEW.revision_number IN (draft.current_revision_number, draft.current_revision_number + 1)
)
BEGIN
    SELECT RAISE(ABORT, '草稿收件人修订号无效');
END;

CREATE TRIGGER validate_draft_attachment_insert
BEFORE INSERT ON draft_attachments
WHEN NOT EXISTS (
    SELECT 1 FROM drafts draft
    WHERE draft.id = NEW.draft_id AND draft.status = 'active'
      AND NEW.revision_number IN (draft.current_revision_number, draft.current_revision_number + 1)
) OR NOT EXISTS (
    SELECT 1 FROM object_registry object
    WHERE object.owner_kind = 'draft' AND object.owner_reference = NEW.draft_id
      AND object.object_role = 'draft_attachment' AND object.logical_part_key = NEW.id
      AND object.generation = NEW.content_generation
      AND object.expected_size_bytes = NEW.size_bytes AND object.expected_sha256 = NEW.content_sha256
      AND object.object_status = 'active' AND object.is_current = 1
)
BEGIN
    SELECT RAISE(ABORT, '草稿附件修订或对象不完整');
END;

CREATE TRIGGER validate_draft_attachment_update
BEFORE UPDATE ON draft_attachments
WHEN NEW.draft_id <> OLD.draft_id OR NOT EXISTS (
    SELECT 1 FROM drafts draft
    WHERE draft.id = NEW.draft_id AND draft.status = 'active'
      AND NEW.revision_number IN (draft.current_revision_number, draft.current_revision_number + 1)
) OR NOT EXISTS (
    SELECT 1 FROM object_registry object
    WHERE object.owner_kind = 'draft' AND object.owner_reference = NEW.draft_id
      AND object.object_role = 'draft_attachment' AND object.logical_part_key = NEW.id
      AND object.generation = NEW.content_generation
      AND object.expected_size_bytes = NEW.size_bytes AND object.expected_sha256 = NEW.content_sha256
      AND object.object_status = 'active' AND object.is_current = 1
)
BEGIN
    SELECT RAISE(ABORT, '草稿附件修订或对象不完整');
END;

CREATE TRIGGER validate_draft_mutation_result_insert
BEFORE INSERT ON draft_mutation_keys
WHEN NOT EXISTS (
    SELECT 1
    FROM drafts source
    JOIN drafts result ON result.id = NEW.result_draft_id AND result.owner_user_id = source.owner_user_id
    WHERE source.id = NEW.draft_id
      AND result.current_revision_number = NEW.result_revision_number
      AND (
          (NEW.result_kind = 'updated' AND result.id = source.id)
          OR (NEW.result_kind = 'conflict_copy' AND result.conflict_parent_draft_id = source.id)
      )
)
BEGIN
    SELECT RAISE(ABORT, '自动保存结果与草稿不匹配');
END;

PRAGMA defer_foreign_keys = OFF;
