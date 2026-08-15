-- 澄笺 | Simlettra 第三批迁移草案
-- 状态：草案，未进入正式 migrations 账本，不得直接用于生产升级。
-- 前置：0001-系统身份与地址基础.sql、0002-邮件投递与邮箱视图.sql。
-- 依据：ADR 0019、0020、0021。

PRAGMA foreign_keys = ON;

CREATE TABLE drafts (
    id TEXT PRIMARY KEY NOT NULL,
    owner_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'trashed', 'consumed', 'deleting')
    ),
    sender_address_id TEXT,
    compose_kind TEXT NOT NULL CHECK (
        compose_kind IN ('new', 'reply', 'reply_all', 'forward')
    ),
    source_message_id TEXT,
    source_reference TEXT,
    conflict_parent_draft_id TEXT,
    current_revision_number INTEGER NOT NULL DEFAULT 1 CHECK (
        current_revision_number >= 1
    ),
    trashed_at INTEGER,
    trash_due_at INTEGER,
    consumed_at INTEGER,
    deleting_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (compose_kind = 'new' AND source_message_id IS NULL AND source_reference IS NULL)
        OR (
            compose_kind IN ('reply', 'reply_all', 'forward')
            AND source_reference IS NOT NULL
            AND length(source_reference) > 0
        )
    ),
    CHECK (
        (status = 'active'
            AND trashed_at IS NULL
            AND trash_due_at IS NULL
            AND consumed_at IS NULL
            AND deleting_at IS NULL)
        OR (status = 'trashed'
            AND trashed_at IS NOT NULL
            AND trash_due_at IS NOT NULL
            AND trash_due_at > trashed_at
            AND consumed_at IS NULL
            AND deleting_at IS NULL)
        OR (status = 'consumed'
            AND trashed_at IS NULL
            AND trash_due_at IS NULL
            AND consumed_at IS NOT NULL
            AND deleting_at IS NULL)
        OR (status = 'deleting'
            AND deleting_at IS NOT NULL)
    ),
    CHECK (conflict_parent_draft_id IS NULL OR conflict_parent_draft_id <> id),
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (sender_address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT,
    FOREIGN KEY (source_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (conflict_parent_draft_id) REFERENCES drafts (id) ON DELETE SET NULL
);

CREATE INDEX drafts_owner_list_index
    ON drafts (owner_user_id, status, updated_at DESC, id DESC);

CREATE INDEX drafts_trash_expiry_index
    ON drafts (trash_due_at, id)
    WHERE status = 'trashed';

CREATE INDEX drafts_source_message_index
    ON drafts (source_message_id, id)
    WHERE source_message_id IS NOT NULL;

CREATE INDEX drafts_conflict_parent_index
    ON drafts (conflict_parent_draft_id, created_at, id)
    WHERE conflict_parent_draft_id IS NOT NULL;

CREATE TRIGGER validate_draft_conflict_parent_insert
BEFORE INSERT ON drafts
WHEN NEW.conflict_parent_draft_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM drafts AS parent
      WHERE parent.id = NEW.conflict_parent_draft_id
        AND parent.owner_user_id = NEW.owner_user_id
  )
BEGIN
    SELECT RAISE(ABORT, '冲突副本必须属于原草稿所有者');
END;

CREATE TRIGGER validate_draft_conflict_parent_update
BEFORE UPDATE OF conflict_parent_draft_id, owner_user_id ON drafts
WHEN NEW.conflict_parent_draft_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM drafts AS parent
      WHERE parent.id = NEW.conflict_parent_draft_id
        AND parent.owner_user_id = NEW.owner_user_id
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
WHEN NEW.current_revision_number <> OLD.current_revision_number + 1
  OR OLD.status <> 'active'
  OR NEW.status <> 'active'
BEGIN
    SELECT RAISE(ABORT, '草稿修订号必须逐次增加');
END;

CREATE TRIGGER validate_draft_status_transition
BEFORE UPDATE OF status ON drafts
WHEN NEW.status <> OLD.status
  AND NOT (
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

CREATE TRIGGER validate_draft_content_revision_insert
BEFORE INSERT ON draft_contents
WHEN NOT EXISTS (
    SELECT 1
    FROM drafts AS draft
    WHERE draft.id = NEW.draft_id
      AND draft.status = 'active'
      AND NEW.revision_number IN (
          draft.current_revision_number,
          draft.current_revision_number + 1
      )
)
BEGIN
    SELECT RAISE(ABORT, '草稿内容修订号无效');
END;

CREATE TRIGGER validate_draft_content_revision_update
BEFORE UPDATE ON draft_contents
WHEN NEW.draft_id <> OLD.draft_id
  OR NOT EXISTS (
      SELECT 1
      FROM drafts AS draft
      WHERE draft.id = NEW.draft_id
        AND draft.status = 'active'
        AND NEW.revision_number IN (
            draft.current_revision_number,
            draft.current_revision_number + 1
        )
  )
BEGIN
    SELECT RAISE(ABORT, '草稿内容修订号无效');
END;

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

CREATE INDEX draft_recipients_address_index
    ON draft_recipients (canonical_address, draft_id)
    WHERE canonical_address IS NOT NULL;

CREATE TRIGGER validate_draft_recipient_revision_insert
BEFORE INSERT ON draft_recipients
WHEN NOT EXISTS (
    SELECT 1
    FROM drafts AS draft
    WHERE draft.id = NEW.draft_id
      AND draft.status = 'active'
      AND NEW.revision_number IN (
          draft.current_revision_number,
          draft.current_revision_number + 1
      )
)
BEGIN
    SELECT RAISE(ABORT, '草稿收件人修订号无效');
END;

CREATE TRIGGER validate_draft_recipient_revision_update
BEFORE UPDATE ON draft_recipients
WHEN NEW.draft_id <> OLD.draft_id
  OR NOT EXISTS (
      SELECT 1
      FROM drafts AS draft
      WHERE draft.id = NEW.draft_id
        AND draft.status = 'active'
        AND NEW.revision_number IN (
            draft.current_revision_number,
            draft.current_revision_number + 1
        )
  )
BEGIN
    SELECT RAISE(ABORT, '草稿收件人修订号无效');
END;

CREATE TABLE draft_attachments (
    id TEXT PRIMARY KEY NOT NULL,
    draft_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    untrusted_file_name TEXT NOT NULL CHECK (length(untrusted_file_name) > 0),
    media_type TEXT NOT NULL CHECK (length(media_type) > 0),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    content_sha256 BLOB NOT NULL CHECK (length(content_sha256) = 32),
    content_generation INTEGER NOT NULL CHECK (content_generation >= 1),
    integrity_checked_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (draft_id, sequence_number),
    FOREIGN KEY (draft_id) REFERENCES drafts (id) ON DELETE CASCADE
);

CREATE INDEX draft_attachments_draft_revision_index
    ON draft_attachments (draft_id, revision_number, sequence_number);

CREATE TRIGGER validate_draft_attachment_revision_insert
BEFORE INSERT ON draft_attachments
WHEN NOT EXISTS (
    SELECT 1
    FROM drafts AS draft
    WHERE draft.id = NEW.draft_id
      AND draft.status = 'active'
      AND NEW.revision_number IN (
          draft.current_revision_number,
          draft.current_revision_number + 1
      )
)
BEGIN
    SELECT RAISE(ABORT, '草稿附件修订号无效');
END;

CREATE TRIGGER validate_draft_attachment_revision_update
BEFORE UPDATE ON draft_attachments
WHEN NEW.draft_id <> OLD.draft_id
  OR NOT EXISTS (
      SELECT 1
      FROM drafts AS draft
      WHERE draft.id = NEW.draft_id
        AND draft.status = 'active'
        AND NEW.revision_number IN (
            draft.current_revision_number,
            draft.current_revision_number + 1
        )
  )
BEGIN
    SELECT RAISE(ABORT, '草稿附件修订号无效');
END;

CREATE TABLE draft_mutation_keys (
    draft_id TEXT NOT NULL,
    mutation_key_digest BLOB NOT NULL CHECK (length(mutation_key_digest) = 32),
    input_digest BLOB NOT NULL CHECK (length(input_digest) = 32),
    expected_revision_number INTEGER NOT NULL CHECK (expected_revision_number >= 1),
    result_kind TEXT NOT NULL CHECK (result_kind IN ('updated', 'conflict_copy')),
    result_draft_id TEXT,
    result_revision_number INTEGER NOT NULL CHECK (result_revision_number >= 1),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (draft_id, mutation_key_digest),
    CHECK (
        result_draft_id IS NULL
        OR (result_kind = 'updated' AND result_draft_id = draft_id)
        OR (result_kind = 'conflict_copy' AND result_draft_id <> draft_id)
    ),
    FOREIGN KEY (draft_id) REFERENCES drafts (id) ON DELETE CASCADE,
    FOREIGN KEY (result_draft_id) REFERENCES drafts (id) ON DELETE SET NULL
);

CREATE INDEX draft_mutation_keys_result_index
    ON draft_mutation_keys (result_draft_id, result_revision_number)
    WHERE result_draft_id IS NOT NULL;

CREATE TRIGGER validate_draft_mutation_result_insert
BEFORE INSERT ON draft_mutation_keys
WHEN NEW.result_draft_id IS NULL
  OR NOT EXISTS (
      SELECT 1
      FROM drafts AS source
      JOIN drafts AS result
        ON result.id = NEW.result_draft_id
       AND result.owner_user_id = source.owner_user_id
      WHERE source.id = NEW.draft_id
        AND result.current_revision_number = NEW.result_revision_number
        AND (
            (NEW.result_kind = 'updated' AND result.id = source.id)
            OR (
                NEW.result_kind = 'conflict_copy'
                AND result.conflict_parent_draft_id = source.id
            )
        )
  )
BEGIN
    SELECT RAISE(ABORT, '自动保存结果与草稿不匹配');
END;

CREATE TABLE send_operations (
    id TEXT PRIMARY KEY NOT NULL,
    operator_user_id TEXT NOT NULL,
    source_draft_id TEXT,
    source_draft_reference TEXT,
    source_draft_revision_number INTEGER CHECK (source_draft_revision_number >= 1),
    message_id TEXT NOT NULL UNIQUE,
    sent_mailbox_entry_id TEXT NOT NULL UNIQUE,
    sender_address_id TEXT NOT NULL,
    sender_address_binding_id TEXT NOT NULL,
    sent_mailbox_type TEXT NOT NULL CHECK (sent_mailbox_type IN ('user', 'organization')),
    sent_user_id TEXT,
    sent_organization_id TEXT,
    compose_kind TEXT NOT NULL CHECK (
        compose_kind IN ('new', 'reply', 'reply_all', 'forward')
    ),
    source_message_id TEXT,
    source_reference TEXT,
    manual_retry_of_send_operation_id TEXT,
    manual_retry_of_reference TEXT,
    recipient_count INTEGER NOT NULL CHECK (recipient_count > 0),
    internal_recipient_count INTEGER NOT NULL CHECK (internal_recipient_count >= 0),
    external_recipient_count INTEGER NOT NULL CHECK (external_recipient_count >= 0),
    quota_recipient_units INTEGER NOT NULL CHECK (quota_recipient_units > 0),
    payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
    payload_size_bytes INTEGER NOT NULL CHECK (payload_size_bytes >= 0),
    effective_size_limit_bytes INTEGER NOT NULL CHECK (effective_size_limit_bytes > 0),
    provider_type TEXT CHECK (
        provider_type IN ('resend', 'smtp2go')
    ),
    provider_config_reference TEXT,
    provider_config_version INTEGER CHECK (provider_config_version >= 1),
    provider_size_limit_bytes INTEGER CHECK (provider_size_limit_bytes > 0),
    workflow_status TEXT NOT NULL CHECK (
        workflow_status IN ('accepted', 'processing', 'finished')
    ),
    accepted_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (recipient_count = internal_recipient_count + external_recipient_count),
    CHECK (quota_recipient_units = recipient_count),
    CHECK (payload_size_bytes <= effective_size_limit_bytes),
    CHECK (
        (sent_mailbox_type = 'user'
            AND sent_user_id IS NOT NULL
            AND sent_organization_id IS NULL)
        OR (sent_mailbox_type = 'organization'
            AND sent_user_id IS NULL
            AND sent_organization_id IS NOT NULL)
    ),
    CHECK (
        (compose_kind = 'new' AND source_message_id IS NULL AND source_reference IS NULL)
        OR (
            compose_kind IN ('reply', 'reply_all', 'forward')
            AND source_reference IS NOT NULL
            AND length(source_reference) > 0
        )
    ),
    CHECK (
        (source_draft_reference IS NULL
            AND source_draft_id IS NULL
            AND source_draft_revision_number IS NULL)
        OR (source_draft_reference IS NOT NULL
            AND length(source_draft_reference) > 0
            AND source_draft_revision_number IS NOT NULL)
    ),
    CHECK (
        (manual_retry_of_send_operation_id IS NULL AND manual_retry_of_reference IS NULL)
        OR (manual_retry_of_reference IS NOT NULL AND length(manual_retry_of_reference) > 0)
    ),
    CHECK (manual_retry_of_send_operation_id IS NULL OR manual_retry_of_send_operation_id <> id),
    CHECK (
        (external_recipient_count = 0
            AND provider_type IS NULL
            AND provider_config_reference IS NULL
            AND provider_config_version IS NULL
            AND provider_size_limit_bytes IS NULL)
        OR (external_recipient_count > 0
            AND provider_type IS NOT NULL
            AND provider_config_reference IS NOT NULL
            AND length(provider_config_reference) > 0
            AND provider_config_version IS NOT NULL
            AND provider_size_limit_bytes IS NOT NULL
            AND effective_size_limit_bytes <= provider_size_limit_bytes)
    ),
    FOREIGN KEY (operator_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (source_draft_id) REFERENCES drafts (id) ON DELETE SET NULL,
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (sent_mailbox_entry_id) REFERENCES mailbox_entries (id) ON DELETE RESTRICT,
    FOREIGN KEY (sender_address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT,
    FOREIGN KEY (sender_address_binding_id) REFERENCES address_bindings (id) ON DELETE RESTRICT,
    FOREIGN KEY (sent_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (sent_organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    FOREIGN KEY (source_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (manual_retry_of_send_operation_id) REFERENCES send_operations (id) ON DELETE SET NULL
);

CREATE INDEX send_operations_operator_index
    ON send_operations (operator_user_id, accepted_at DESC, id DESC);

CREATE INDEX send_operations_work_index
    ON send_operations (workflow_status, accepted_at, id);

CREATE INDEX send_operations_source_draft_index
    ON send_operations (source_draft_id, source_draft_revision_number)
    WHERE source_draft_id IS NOT NULL;

CREATE INDEX send_operations_manual_retry_index
    ON send_operations (manual_retry_of_send_operation_id, accepted_at, id)
    WHERE manual_retry_of_send_operation_id IS NOT NULL;

CREATE TRIGGER validate_send_operation_insert
BEFORE INSERT ON send_operations
WHEN NOT EXISTS (
    SELECT 1
    FROM users AS operator
    JOIN messages AS message
      ON message.id = NEW.message_id
     AND message.origin_type = 'composed'
     AND message.authored_by_user_id = NEW.operator_user_id
    JOIN mailbox_entries AS entry
      ON entry.id = NEW.sent_mailbox_entry_id
     AND entry.message_id = NEW.message_id
     AND entry.entry_kind = 'sent'
     AND entry.base_location = 'sent'
     AND entry.mailbox_type = NEW.sent_mailbox_type
     AND (
         (NEW.sent_mailbox_type = 'user' AND entry.user_id = NEW.sent_user_id)
         OR (
             NEW.sent_mailbox_type = 'organization'
             AND entry.organization_id = NEW.sent_organization_id
         )
     )
    JOIN address_bindings AS binding
      ON binding.id = NEW.sender_address_binding_id
     AND binding.address_id = NEW.sender_address_id
     AND binding.started_at <= NEW.accepted_at
     AND (binding.ended_at IS NULL OR binding.ended_at >= NEW.accepted_at)
     AND (
         (NEW.sent_mailbox_type = 'user'
             AND binding.owner_type = 'user'
             AND binding.user_id = NEW.sent_user_id
             AND NEW.sent_user_id = NEW.operator_user_id)
         OR (NEW.sent_mailbox_type = 'organization'
             AND binding.owner_type = 'organization'
             AND binding.organization_id = NEW.sent_organization_id)
     )
    JOIN email_addresses AS address
      ON address.id = NEW.sender_address_id
     AND (address.retired_at IS NULL OR address.retired_at > NEW.accepted_at)
    JOIN mail_domains AS domain
      ON domain.id = address.domain_id
     AND domain.status = 'active'
    WHERE operator.id = NEW.operator_user_id
      AND operator.status = 'active'
      AND (
          NEW.sent_mailbox_type = 'user'
          OR EXISTS (
              SELECT 1
              FROM organizations AS organization
              WHERE organization.id = NEW.sent_organization_id
                AND organization.status = 'active'
                AND (
                    organization.creator_user_id = NEW.operator_user_id
                    OR (
                        organization.members_can_send = 1
                        AND EXISTS (
                            SELECT 1
                            FROM organization_memberships AS membership
                            WHERE membership.organization_id = organization.id
                              AND membership.user_id = NEW.operator_user_id
                              AND membership.left_at IS NULL
                        )
                    )
                )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, '发送操作的权限、地址或已发送归属无效');
END;

CREATE TRIGGER validate_send_operation_source_draft_insert
BEFORE INSERT ON send_operations
WHEN NEW.source_draft_reference IS NOT NULL
  AND (
      NEW.source_draft_id IS NULL
      OR NOT EXISTS (
      SELECT 1
      FROM drafts AS draft
      WHERE draft.id = NEW.source_draft_id
        AND draft.owner_user_id = NEW.operator_user_id
        AND draft.status = 'active'
        AND draft.current_revision_number = NEW.source_draft_revision_number
        AND draft.compose_kind = NEW.compose_kind
        AND NEW.source_draft_reference = draft.id
      )
  )
BEGIN
    SELECT RAISE(ABORT, '发送操作引用的草稿修订无效');
END;

CREATE TRIGGER validate_send_operation_manual_retry_insert
BEFORE INSERT ON send_operations
WHEN NEW.manual_retry_of_reference IS NOT NULL
  AND (
      NEW.manual_retry_of_send_operation_id IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM send_operations AS original
          WHERE original.id = NEW.manual_retry_of_send_operation_id
            AND NEW.manual_retry_of_reference = original.id
      )
  )
BEGIN
    SELECT RAISE(ABORT, '人工再次发送必须关联原发送操作');
END;

CREATE TRIGGER prevent_send_operation_identity_change
BEFORE UPDATE OF
    operator_user_id,
    source_draft_reference,
    source_draft_revision_number,
    message_id,
    sent_mailbox_entry_id,
    sender_address_id,
    sender_address_binding_id,
    sent_mailbox_type,
    sent_user_id,
    sent_organization_id,
    compose_kind,
    source_reference,
    manual_retry_of_reference,
    recipient_count,
    internal_recipient_count,
    external_recipient_count,
    quota_recipient_units,
    payload_sha256,
    payload_size_bytes,
    effective_size_limit_bytes,
    provider_type,
    provider_config_reference,
    provider_config_version,
    provider_size_limit_bytes,
    accepted_at,
    created_at
ON send_operations
BEGIN
    SELECT RAISE(ABORT, '已接受发送操作的冻结字段不可修改');
END;

CREATE TRIGGER prevent_send_operation_source_draft_retarget
BEFORE UPDATE OF source_draft_id ON send_operations
WHEN NEW.source_draft_id IS NOT OLD.source_draft_id
  AND NOT (OLD.source_draft_id IS NOT NULL AND NEW.source_draft_id IS NULL)
BEGIN
    SELECT RAISE(ABORT, '发送操作不能改指其他来源草稿');
END;

CREATE TRIGGER prevent_send_operation_source_message_retarget
BEFORE UPDATE OF source_message_id ON send_operations
WHEN NEW.source_message_id IS NOT OLD.source_message_id
  AND NOT (OLD.source_message_id IS NOT NULL AND NEW.source_message_id IS NULL)
BEGIN
    SELECT RAISE(ABORT, '发送操作不能改指其他来源邮件');
END;

CREATE TRIGGER prevent_send_operation_manual_retry_retarget
BEFORE UPDATE OF manual_retry_of_send_operation_id ON send_operations
WHEN NEW.manual_retry_of_send_operation_id IS NOT OLD.manual_retry_of_send_operation_id
  AND NOT (
      OLD.manual_retry_of_send_operation_id IS NOT NULL
      AND NEW.manual_retry_of_send_operation_id IS NULL
  )
BEGIN
    SELECT RAISE(ABORT, '人工再次发送不能改指其他原操作');
END;

CREATE TRIGGER validate_send_operation_workflow_transition
BEFORE UPDATE OF workflow_status ON send_operations
WHEN NEW.workflow_status <> OLD.workflow_status
  AND NOT (
      (OLD.workflow_status = 'accepted' AND NEW.workflow_status IN ('processing', 'finished'))
      OR (OLD.workflow_status = 'processing' AND NEW.workflow_status = 'finished')
  )
BEGIN
    SELECT RAISE(ABORT, '发送工作流状态不能倒退');
END;

CREATE TABLE send_idempotency_keys (
    user_id TEXT NOT NULL,
    request_key_digest BLOB NOT NULL CHECK (length(request_key_digest) = 32),
    input_digest BLOB NOT NULL CHECK (length(input_digest) = 32),
    send_operation_id TEXT,
    accepted_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, request_key_digest),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (send_operation_id) REFERENCES send_operations (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX send_idempotency_keys_operation_unique
    ON send_idempotency_keys (send_operation_id)
    WHERE send_operation_id IS NOT NULL;

CREATE TRIGGER validate_send_idempotency_result_insert
BEFORE INSERT ON send_idempotency_keys
WHEN NEW.send_operation_id IS NULL
  OR NOT EXISTS (
      SELECT 1
      FROM send_operations AS operation
      WHERE operation.id = NEW.send_operation_id
        AND operation.operator_user_id = NEW.user_id
        AND operation.accepted_at = NEW.accepted_at
  )
BEGIN
    SELECT RAISE(ABORT, '发送幂等记录与发送操作不匹配');
END;

CREATE TRIGGER prevent_send_idempotency_change
BEFORE UPDATE OF user_id, request_key_digest, input_digest, accepted_at, created_at
ON send_idempotency_keys
BEGIN
    SELECT RAISE(ABORT, '发送幂等墓碑不可修改');
END;

CREATE TABLE send_recipients (
    id TEXT PRIMARY KEY NOT NULL,
    send_operation_id TEXT NOT NULL,
    recipient_role TEXT NOT NULL CHECK (recipient_role IN ('to', 'cc', 'bcc')),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    display_name TEXT,
    address_text TEXT NOT NULL CHECK (length(address_text) > 0),
    canonical_address TEXT COLLATE NOCASE NOT NULL CHECK (
        instr(canonical_address, '@') > 1
    ),
    deduplication_key BLOB NOT NULL CHECK (length(deduplication_key) = 32),
    route_channel TEXT NOT NULL CHECK (
        route_channel IN ('internal_assigned', 'internal_unallocated', 'external')
    ),
    message_delivery_id TEXT UNIQUE,
    delivery_status TEXT NOT NULL CHECK (
        delivery_status IN (
            'waiting',
            'submitting',
            'submitted',
            'delayed',
            'delivered',
            'bounced',
            'failed',
            'unknown'
        )
    ),
    status_version INTEGER NOT NULL DEFAULT 1 CHECK (status_version >= 1),
    status_updated_at INTEGER NOT NULL,
    failure_code TEXT,
    failure_detail TEXT,
    complained_at INTEGER,
    last_provider_reference TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (send_operation_id, deduplication_key),
    UNIQUE (send_operation_id, recipient_role, sequence_number),
    CHECK (updated_at >= created_at),
    CHECK (
        (route_channel IN ('internal_assigned', 'internal_unallocated')
            AND message_delivery_id IS NOT NULL
            AND delivery_status = 'delivered')
        OR (route_channel = 'external' AND message_delivery_id IS NULL)
    ),
    FOREIGN KEY (send_operation_id) REFERENCES send_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (message_delivery_id) REFERENCES message_deliveries (id) ON DELETE RESTRICT
);

CREATE INDEX send_recipients_status_index
    ON send_recipients (delivery_status, status_updated_at, id);

CREATE INDEX send_recipients_operation_channel_index
    ON send_recipients (send_operation_id, route_channel, recipient_role, sequence_number);

CREATE INDEX send_recipients_address_index
    ON send_recipients (canonical_address, send_operation_id);

CREATE TRIGGER validate_send_recipient_insert
BEFORE INSERT ON send_recipients
WHEN NOT EXISTS (
    SELECT 1
    FROM send_operations AS operation
    LEFT JOIN message_deliveries AS delivery
      ON delivery.id = NEW.message_delivery_id
     AND delivery.message_id = operation.message_id
    WHERE operation.id = NEW.send_operation_id
      AND (
          (NEW.route_channel = 'external'
              AND operation.external_recipient_count > 0
              AND NEW.delivery_status = 'waiting'
              AND NEW.status_version = 1)
          OR (NEW.route_channel = 'internal_assigned'
              AND operation.internal_recipient_count > 0
              AND delivery.target_type = 'assigned'
              AND delivery.canonical_recipient_address = NEW.canonical_address COLLATE NOCASE)
          OR (NEW.route_channel = 'internal_unallocated'
              AND operation.internal_recipient_count > 0
              AND delivery.target_type = 'unallocated'
              AND delivery.canonical_recipient_address = NEW.canonical_address COLLATE NOCASE)
      )
)
BEGIN
    SELECT RAISE(ABORT, '逻辑收件人与发送操作或实际投递不匹配');
END;

CREATE TRIGGER validate_send_recipient_status_update
BEFORE UPDATE OF delivery_status, status_version, status_updated_at ON send_recipients
WHEN NEW.route_channel <> 'external'
  OR (
      (NEW.delivery_status <> OLD.delivery_status
          AND NEW.status_version <> OLD.status_version + 1)
      OR (NEW.delivery_status = OLD.delivery_status
          AND NEW.status_version <> OLD.status_version)
      OR NEW.status_updated_at < OLD.status_updated_at
  )
BEGIN
    SELECT RAISE(ABORT, '逻辑收件人状态版本无效');
END;

CREATE TRIGGER prevent_send_recipient_identity_change
BEFORE UPDATE OF
    send_operation_id,
    recipient_role,
    sequence_number,
    display_name,
    address_text,
    canonical_address,
    deduplication_key,
    route_channel,
    message_delivery_id,
    created_at
ON send_recipients
BEGIN
    SELECT RAISE(ABORT, '逻辑收件人身份不可修改');
END;

CREATE TABLE provider_submission_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    send_operation_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    attempt_type TEXT NOT NULL CHECK (
        attempt_type IN ('initial', 'safe_retry', 'idempotent_retry')
    ),
    attempt_status TEXT NOT NULL CHECK (
        attempt_status IN ('prepared', 'submitting', 'accepted', 'not_accepted', 'unknown')
    ),
    provider_type TEXT NOT NULL CHECK (
        provider_type IN ('resend', 'smtp2go')
    ),
    provider_config_reference TEXT NOT NULL CHECK (
        length(provider_config_reference) > 0
    ),
    provider_config_version INTEGER NOT NULL CHECK (provider_config_version >= 1),
    payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
    payload_size_bytes INTEGER NOT NULL CHECK (payload_size_bytes >= 0),
    idempotency_key_digest BLOB CHECK (
        idempotency_key_digest IS NULL OR length(idempotency_key_digest) = 32
    ),
    provider_submission_id TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    error_code TEXT,
    error_detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (send_operation_id, attempt_number),
    CHECK (updated_at >= created_at),
    CHECK (
        (attempt_status = 'prepared' AND started_at IS NULL AND completed_at IS NULL)
        OR (attempt_status = 'submitting' AND started_at IS NOT NULL AND completed_at IS NULL)
        OR (attempt_status IN ('accepted', 'not_accepted', 'unknown')
            AND started_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND completed_at >= started_at)
    ),
    CHECK (
        attempt_type <> 'idempotent_retry'
        OR (provider_type = 'resend' AND idempotency_key_digest IS NOT NULL)
    ),
    FOREIGN KEY (send_operation_id) REFERENCES send_operations (id) ON DELETE CASCADE
);

CREATE INDEX provider_submission_attempts_work_index
    ON provider_submission_attempts (attempt_status, created_at, id);

CREATE INDEX provider_submission_attempts_submission_index
    ON provider_submission_attempts (provider_type, provider_submission_id)
    WHERE provider_submission_id IS NOT NULL;

CREATE TRIGGER validate_provider_attempt_snapshot_insert
BEFORE INSERT ON provider_submission_attempts
WHEN NOT EXISTS (
    SELECT 1
    FROM send_operations AS operation
    WHERE operation.id = NEW.send_operation_id
      AND operation.external_recipient_count > 0
      AND operation.provider_type = NEW.provider_type
      AND operation.provider_config_reference = NEW.provider_config_reference
      AND operation.provider_config_version = NEW.provider_config_version
      AND operation.payload_sha256 = NEW.payload_sha256
      AND operation.payload_size_bytes = NEW.payload_size_bytes
)
BEGIN
    SELECT RAISE(ABORT, '供应商尝试与发送快照不匹配');
END;

CREATE TRIGGER prevent_provider_attempt_identity_change
BEFORE UPDATE OF
    send_operation_id,
    attempt_number,
    attempt_type,
    provider_type,
    provider_config_reference,
    provider_config_version,
    payload_sha256,
    payload_size_bytes,
    idempotency_key_digest,
    created_at
ON provider_submission_attempts
BEGIN
    SELECT RAISE(ABORT, '供应商尝试身份不可修改');
END;

CREATE TRIGGER validate_provider_attempt_status_transition
BEFORE UPDATE OF attempt_status ON provider_submission_attempts
WHEN NEW.attempt_status <> OLD.attempt_status
  AND NOT (
      (OLD.attempt_status = 'prepared' AND NEW.attempt_status = 'submitting')
      OR (
          OLD.attempt_status = 'submitting'
          AND NEW.attempt_status IN ('accepted', 'not_accepted', 'unknown')
      )
  )
BEGIN
    SELECT RAISE(ABORT, '供应商尝试状态不能倒退或跳转');
END;

CREATE TABLE provider_attempt_recipients (
    provider_attempt_id TEXT NOT NULL,
    send_recipient_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider_attempt_id, send_recipient_id),
    FOREIGN KEY (provider_attempt_id) REFERENCES provider_submission_attempts (id) ON DELETE CASCADE,
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE CASCADE
);

CREATE INDEX provider_attempt_recipients_recipient_index
    ON provider_attempt_recipients (send_recipient_id, provider_attempt_id);

CREATE TRIGGER validate_provider_attempt_recipient_insert
BEFORE INSERT ON provider_attempt_recipients
WHEN NOT EXISTS (
    SELECT 1
    FROM provider_submission_attempts AS attempt
    JOIN send_recipients AS recipient
      ON recipient.id = NEW.send_recipient_id
     AND recipient.send_operation_id = attempt.send_operation_id
     AND recipient.route_channel = 'external'
     AND recipient.delivery_status NOT IN ('delivered', 'bounced', 'failed', 'unknown')
    WHERE attempt.id = NEW.provider_attempt_id
)
BEGIN
    SELECT RAISE(ABORT, '供应商尝试不能包含该收件人');
END;

CREATE TRIGGER prevent_provider_attempt_recipient_change
BEFORE UPDATE ON provider_attempt_recipients
BEGIN
    SELECT RAISE(ABORT, '供应商尝试收件人关系不可修改');
END;

CREATE TABLE provider_events (
    id TEXT PRIMARY KEY NOT NULL,
    provider_type TEXT NOT NULL CHECK (
        provider_type IN ('resend', 'smtp2go')
    ),
    provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) > 0),
    normalized_event_type TEXT NOT NULL CHECK (
        normalized_event_type IN (
            'submitted',
            'delayed',
            'delivered',
            'bounced',
            'failed',
            'complained',
            'opened',
            'clicked',
            'other'
        )
    ),
    occurred_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    verified_at INTEGER NOT NULL,
    raw_sha256 BLOB NOT NULL CHECK (length(raw_sha256) = 32),
    diagnostic_code TEXT,
    diagnostic_detail TEXT,
    provider_attempt_id TEXT,
    send_recipient_id TEXT,
    match_status TEXT NOT NULL CHECK (match_status IN ('pending', 'matched', 'ignored')),
    processing_result TEXT NOT NULL CHECK (
        processing_result IN ('pending', 'applied', 'no_change', 'ignored', 'rejected')
    ),
    processed_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (provider_type, provider_event_id),
    CHECK (verified_at >= received_at),
    CHECK (
        (match_status = 'pending'
            AND processing_result = 'pending'
            AND processed_at IS NULL)
        OR (match_status = 'matched'
            AND processing_result IN ('applied', 'no_change', 'rejected')
            AND processed_at IS NOT NULL)
        OR (match_status = 'ignored'
            AND processing_result = 'ignored'
            AND processed_at IS NOT NULL)
    ),
    FOREIGN KEY (provider_attempt_id) REFERENCES provider_submission_attempts (id) ON DELETE SET NULL,
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE SET NULL
);

CREATE INDEX provider_events_pending_index
    ON provider_events (match_status, received_at, id)
    WHERE match_status = 'pending';

CREATE INDEX provider_events_recipient_index
    ON provider_events (send_recipient_id, occurred_at, id)
    WHERE send_recipient_id IS NOT NULL;

CREATE TRIGGER validate_provider_event_links_insert
BEFORE INSERT ON provider_events
WHEN NEW.match_status = 'matched'
  AND NOT EXISTS (
      SELECT 1
      FROM send_recipients AS recipient
      JOIN send_operations AS operation
        ON operation.id = recipient.send_operation_id
       AND operation.provider_type = NEW.provider_type
      LEFT JOIN provider_submission_attempts AS attempt
        ON attempt.id = NEW.provider_attempt_id
       AND attempt.send_operation_id = recipient.send_operation_id
       AND attempt.provider_type = NEW.provider_type
      WHERE recipient.id = NEW.send_recipient_id
        AND recipient.route_channel = 'external'
        AND (NEW.provider_attempt_id IS NULL OR attempt.id IS NOT NULL)
  )
BEGIN
    SELECT RAISE(ABORT, '供应商事件与发送尝试或收件人不匹配');
END;

CREATE TRIGGER validate_provider_event_links_update
BEFORE UPDATE OF
    provider_attempt_id,
    send_recipient_id,
    match_status,
    processing_result,
    processed_at
ON provider_events
WHEN NEW.match_status = 'matched'
  AND NOT EXISTS (
      SELECT 1
      FROM send_recipients AS recipient
      JOIN send_operations AS operation
        ON operation.id = recipient.send_operation_id
       AND operation.provider_type = NEW.provider_type
      LEFT JOIN provider_submission_attempts AS attempt
        ON attempt.id = NEW.provider_attempt_id
       AND attempt.send_operation_id = recipient.send_operation_id
       AND attempt.provider_type = NEW.provider_type
      WHERE recipient.id = NEW.send_recipient_id
        AND recipient.route_channel = 'external'
        AND (NEW.provider_attempt_id IS NULL OR attempt.id IS NOT NULL)
  )
BEGIN
    SELECT RAISE(ABORT, '供应商事件与发送尝试或收件人不匹配');
END;

CREATE TRIGGER prevent_processed_provider_event_reclassification
BEFORE UPDATE OF
    provider_attempt_id,
    send_recipient_id,
    match_status,
    processing_result,
    processed_at
ON provider_events
WHEN OLD.match_status <> 'pending'
  AND (
      NEW.provider_attempt_id IS NOT OLD.provider_attempt_id
      OR NEW.send_recipient_id IS NOT OLD.send_recipient_id
      OR NEW.match_status <> OLD.match_status
      OR NEW.processing_result <> OLD.processing_result
      OR NEW.processed_at IS NOT OLD.processed_at
  )
BEGIN
    SELECT RAISE(ABORT, '已处理供应商事件不能重新分类或改指');
END;

CREATE TRIGGER prevent_provider_event_identity_change
BEFORE UPDATE OF
    provider_type,
    provider_event_id,
    normalized_event_type,
    occurred_at,
    received_at,
    verified_at,
    raw_sha256,
    diagnostic_code,
    diagnostic_detail,
    created_at
ON provider_events
BEGIN
    SELECT RAISE(ABORT, '已验证供应商事件事实不可修改');
END;

CREATE TABLE send_recipient_status_history (
    id TEXT PRIMARY KEY NOT NULL,
    send_recipient_id TEXT NOT NULL,
    previous_status TEXT CHECK (
        previous_status IS NULL OR previous_status IN (
            'waiting',
            'submitting',
            'submitted',
            'delayed',
            'delivered',
            'bounced',
            'failed',
            'unknown'
        )
    ),
    new_status TEXT NOT NULL CHECK (
        new_status IN (
            'waiting',
            'submitting',
            'submitted',
            'delayed',
            'delivered',
            'bounced',
            'failed',
            'unknown'
        )
    ),
    status_version INTEGER NOT NULL CHECK (status_version >= 1),
    source_type TEXT NOT NULL CHECK (
        source_type IN (
            'send_acceptance',
            'provider_attempt',
            'provider_event',
            'permission_revoked',
            'manual_reconciliation'
        )
    ),
    source_reference TEXT NOT NULL CHECK (length(source_reference) > 0),
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (send_recipient_id, status_version),
    UNIQUE (send_recipient_id, source_type, source_reference),
    CHECK (
        (status_version = 1 AND previous_status IS NULL)
        OR (status_version > 1 AND previous_status IS NOT NULL)
    ),
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE CASCADE
);

CREATE INDEX send_recipient_status_history_time_index
    ON send_recipient_status_history (send_recipient_id, occurred_at, status_version);

CREATE TRIGGER validate_send_recipient_status_history_insert
BEFORE INSERT ON send_recipient_status_history
WHEN NOT EXISTS (
    SELECT 1
    FROM send_recipients AS recipient
    WHERE recipient.id = NEW.send_recipient_id
      AND recipient.delivery_status = NEW.new_status
      AND recipient.status_version = NEW.status_version
      AND (
          (NEW.status_version = 1 AND NEW.previous_status IS NULL)
          OR (
              NEW.status_version > 1
              AND EXISTS (
                  SELECT 1
                  FROM send_recipient_status_history AS previous
                  WHERE previous.send_recipient_id = NEW.send_recipient_id
                    AND previous.status_version = NEW.status_version - 1
                    AND previous.new_status = NEW.previous_status
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, '逻辑收件人状态历史与当前状态不匹配');
END;

CREATE TRIGGER prevent_send_recipient_status_history_change
BEFORE UPDATE ON send_recipient_status_history
BEGIN
    SELECT RAISE(ABORT, '逻辑收件人状态历史不可修改');
END;
