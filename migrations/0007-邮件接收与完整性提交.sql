-- 澄笺 | Simlettra 正式迁移 0007
-- 依据：需求 5.01 至 5.05、5.11、5.12，ADR 0002、0009、0022、0023、0024。

PRAGMA foreign_keys = ON;

CREATE TABLE messages (
    id TEXT PRIMARY KEY NOT NULL,
    origin_type TEXT NOT NULL CHECK (
        origin_type IN ('received', 'composed', 'migrated')
    ),
    authored_by_user_id TEXT,
    internet_message_id TEXT,
    subject TEXT NOT NULL DEFAULT '',
    header_date_text TEXT,
    header_date_at INTEGER,
    accepted_at INTEGER NOT NULL,
    sort_at INTEGER NOT NULL,
    raw_size_bytes INTEGER NOT NULL CHECK (raw_size_bytes >= 0),
    attachment_count INTEGER NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
    has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (attachment_count = 0 AND has_attachments = 0)
        OR (attachment_count > 0 AND has_attachments = 1)
    ),
    CHECK (origin_type <> 'composed' OR authored_by_user_id IS NOT NULL),
    FOREIGN KEY (authored_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX messages_sort_index ON messages (sort_at DESC, id DESC);

CREATE INDEX messages_internet_message_id_index
    ON messages (internet_message_id, id)
    WHERE internet_message_id IS NOT NULL;

CREATE TABLE message_header_addresses (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL,
    address_role TEXT NOT NULL CHECK (
        address_role IN ('from', 'sender', 'reply_to', 'to', 'cc', 'bcc')
    ),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    display_name TEXT,
    address_text TEXT NOT NULL CHECK (length(address_text) > 0),
    canonical_address TEXT COLLATE NOCASE,
    visibility_scope TEXT NOT NULL CHECK (
        visibility_scope IN ('header', 'sender_only')
    ),
    created_at INTEGER NOT NULL,
    UNIQUE (message_id, address_role, sequence_number),
    CHECK (
        (address_role = 'bcc' AND visibility_scope = 'sender_only')
        OR (address_role <> 'bcc' AND visibility_scope = 'header')
    ),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
);

CREATE INDEX message_header_addresses_message_index
    ON message_header_addresses (message_id, address_role, sequence_number);

CREATE INDEX message_header_addresses_search_index
    ON message_header_addresses (canonical_address, address_role, message_id)
    WHERE canonical_address IS NOT NULL;

CREATE TRIGGER prevent_message_header_address_change
BEFORE UPDATE ON message_header_addresses
BEGIN
    SELECT RAISE(ABORT, '邮件头地址快照不可修改');
END;

CREATE TABLE message_deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL,
    address_binding_id TEXT NOT NULL,
    canonical_recipient_address TEXT COLLATE NOCASE NOT NULL,
    display_recipient_address TEXT NOT NULL,
    delivery_source TEXT NOT NULL CHECK (
        delivery_source IN ('external_receive', 'internal_delivery', 'migration')
    ),
    delivered_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (address_binding_id) REFERENCES address_bindings (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX message_deliveries_message_binding_unique
    ON message_deliveries (message_id, address_binding_id);

CREATE INDEX message_deliveries_binding_index
    ON message_deliveries (address_binding_id, delivered_at DESC, id DESC);

CREATE TRIGGER prevent_message_delivery_change
BEFORE UPDATE ON message_deliveries
BEGIN
    SELECT RAISE(ABORT, '实际投递事实不可修改');
END;

CREATE TABLE mailbox_entries (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL,
    mailbox_type TEXT NOT NULL CHECK (mailbox_type IN ('user', 'organization')),
    user_id TEXT,
    organization_id TEXT,
    entry_kind TEXT NOT NULL CHECK (entry_kind IN ('received', 'sent')),
    base_location TEXT NOT NULL CHECK (base_location IN ('inbox', 'sent', 'spam')),
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (
        (mailbox_type = 'user' AND user_id IS NOT NULL AND organization_id IS NULL)
        OR (mailbox_type = 'organization' AND user_id IS NULL AND organization_id IS NOT NULL)
    ),
    CHECK (
        (entry_kind = 'received' AND base_location IN ('inbox', 'spam'))
        OR (entry_kind = 'sent' AND base_location = 'sent')
    ),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX mailbox_entries_user_message_unique
    ON mailbox_entries (message_id, user_id, entry_kind)
    WHERE mailbox_type = 'user';

CREATE UNIQUE INDEX mailbox_entries_organization_message_unique
    ON mailbox_entries (message_id, organization_id, entry_kind)
    WHERE mailbox_type = 'organization';

CREATE INDEX mailbox_entries_user_list_index
    ON mailbox_entries (user_id, occurred_at DESC, id DESC)
    WHERE mailbox_type = 'user';

CREATE INDEX mailbox_entries_organization_list_index
    ON mailbox_entries (organization_id, occurred_at DESC, id DESC)
    WHERE mailbox_type = 'organization';

CREATE TRIGGER prevent_mailbox_entry_change
BEFORE UPDATE ON mailbox_entries
BEGIN
    SELECT RAISE(ABORT, '邮箱条目身份不可修改');
END;

CREATE TABLE mailbox_entry_deliveries (
    mailbox_entry_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (mailbox_entry_id, delivery_id),
    FOREIGN KEY (mailbox_entry_id) REFERENCES mailbox_entries (id) ON DELETE CASCADE,
    FOREIGN KEY (delivery_id) REFERENCES message_deliveries (id) ON DELETE RESTRICT
);

CREATE TRIGGER validate_mailbox_entry_delivery_insert
BEFORE INSERT ON mailbox_entry_deliveries
WHEN NOT EXISTS (
    SELECT 1
    FROM mailbox_entries AS entry
    JOIN message_deliveries AS delivery
      ON delivery.id = NEW.delivery_id
     AND delivery.message_id = entry.message_id
    JOIN address_bindings AS binding
      ON binding.id = delivery.address_binding_id
    WHERE entry.id = NEW.mailbox_entry_id
      AND entry.entry_kind = 'received'
      AND (
          (entry.mailbox_type = 'user'
              AND binding.owner_type = 'user'
              AND binding.user_id = entry.user_id)
          OR (entry.mailbox_type = 'organization'
              AND binding.owner_type = 'organization'
              AND binding.organization_id = entry.organization_id)
      )
)
BEGIN
    SELECT RAISE(ABORT, '实际投递与收件邮箱条目不匹配');
END;

CREATE TRIGGER prevent_mailbox_entry_delivery_change
BEFORE UPDATE ON mailbox_entry_deliveries
BEGIN
    SELECT RAISE(ABORT, '邮箱条目投递关系不可修改');
END;

CREATE TABLE object_registry (
    id TEXT PRIMARY KEY NOT NULL,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
    object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind = 'message'),
    owner_reference TEXT NOT NULL CHECK (length(owner_reference) > 0),
    message_id TEXT,
    object_role TEXT NOT NULL CHECK (
        object_role IN ('raw_mime', 'plain_body', 'html_body', 'attachment', 'inline_resource', 'final_mime')
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
    CHECK (message_id IS NULL OR message_id = owner_reference),
    CHECK (
        object_role IN ('attachment', 'inline_resource')
        OR (untrusted_file_name IS NULL AND content_disposition IS NULL AND content_id IS NULL)
    ),
    CHECK (
        object_role <> 'attachment'
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
      OLD.message_id IS NULL
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
        (integrity_status = 'ready' AND ready_at IS NOT NULL AND hidden_since IS NULL AND damage_code IS NULL AND damage_summary IS NULL)
        OR (integrity_status = 'repairing' AND hidden_since IS NOT NULL)
        OR (integrity_status = 'damaged' AND hidden_since IS NOT NULL AND damage_code IS NOT NULL)
        OR (integrity_status = 'pending_delete' AND hidden_since IS NOT NULL)
    ),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT
);

CREATE INDEX message_integrity_status_index
    ON message_integrity_states (integrity_status, updated_at, message_id);

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

CREATE TRIGGER validate_mailbox_entry_message_ready
BEFORE INSERT ON mailbox_entries
WHEN NOT EXISTS (
    SELECT 1 FROM message_integrity_states
    WHERE message_id = NEW.message_id AND integrity_status = 'ready'
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

CREATE INDEX receive_operations_work_index
    ON receive_operations (operation_status, updated_at, id);

CREATE INDEX receive_operations_window_expiry_index
    ON receive_operations (deduplication_expires_at, id)
    WHERE deduplication_expires_at IS NOT NULL;

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

CREATE INDEX message_deduplication_keys_message_index
    ON message_deduplication_keys (message_id);
