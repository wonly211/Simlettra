-- 澄笺 | Simlettra 第二批迁移草案
-- 状态：草案，未进入正式 migrations 账本，不得直接用于生产升级。
-- 前置：0001-系统身份与地址基础.sql。
-- 依据：ADR 0002、0007、0009、0016、0017、0018。

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

CREATE INDEX messages_sort_index
    ON messages (sort_at DESC, id DESC);

CREATE INDEX messages_internet_message_id_index
    ON messages (internet_message_id, id)
    WHERE internet_message_id IS NOT NULL;

CREATE INDEX messages_author_index
    ON messages (authored_by_user_id, sort_at DESC, id DESC)
    WHERE authored_by_user_id IS NOT NULL;

CREATE TABLE message_deduplication_keys (
    source_kind TEXT NOT NULL CHECK (length(source_kind) > 0),
    key_digest BLOB NOT NULL CHECK (length(key_digest) = 32),
    message_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_kind, key_digest),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE SET NULL
);

CREATE INDEX message_deduplication_keys_message_index
    ON message_deduplication_keys (message_id)
    WHERE message_id IS NOT NULL;

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

CREATE INDEX message_header_addresses_search_index
    ON message_header_addresses (canonical_address, address_role, message_id)
    WHERE canonical_address IS NOT NULL;

CREATE INDEX message_header_addresses_message_index
    ON message_header_addresses (message_id, address_role, sequence_number);

CREATE TRIGGER prevent_message_header_address_change
BEFORE UPDATE ON message_header_addresses
BEGIN
    SELECT RAISE(ABORT, '邮件头地址快照不可修改');
END;

CREATE TABLE unallocated_address_periods (
    id TEXT PRIMARY KEY NOT NULL,
    domain_id TEXT NOT NULL,
    canonical_address TEXT COLLATE NOCASE NOT NULL,
    display_address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'closed')),
    started_at INTEGER NOT NULL,
    closed_at INTEGER,
    claimed_by_user_id TEXT,
    claimed_address_id TEXT,
    CHECK (
        (
            status = 'open'
            AND closed_at IS NULL
            AND claimed_by_user_id IS NULL
            AND claimed_address_id IS NULL
        )
        OR (
            status = 'claimed'
            AND closed_at IS NOT NULL
            AND closed_at >= started_at
            AND claimed_by_user_id IS NOT NULL
            AND claimed_address_id IS NOT NULL
        )
        OR (
            status = 'closed'
            AND closed_at IS NOT NULL
            AND closed_at >= started_at
            AND claimed_by_user_id IS NULL
            AND claimed_address_id IS NULL
        )
    ),
    FOREIGN KEY (domain_id) REFERENCES mail_domains (id) ON DELETE RESTRICT,
    FOREIGN KEY (claimed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (claimed_address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX unallocated_address_periods_open_unique
    ON unallocated_address_periods (canonical_address)
    WHERE status = 'open';

CREATE INDEX unallocated_address_periods_domain_index
    ON unallocated_address_periods (domain_id, status, started_at DESC, id DESC);

CREATE TRIGGER prevent_unallocated_period_identity_change
BEFORE UPDATE OF domain_id, canonical_address, display_address, started_at
ON unallocated_address_periods
WHEN NEW.domain_id <> OLD.domain_id
    OR NEW.canonical_address COLLATE BINARY <> OLD.canonical_address COLLATE BINARY
    OR NEW.display_address <> OLD.display_address
    OR NEW.started_at <> OLD.started_at
BEGIN
    SELECT RAISE(ABORT, '未分配地址时期身份不可修改');
END;

CREATE TABLE unallocated_access_grants (
    domain_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    granted_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (domain_id, user_id),
    FOREIGN KEY (domain_id) REFERENCES mail_domains (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX unallocated_access_grants_user_index
    ON unallocated_access_grants (user_id, domain_id);

CREATE TABLE message_deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('assigned', 'unallocated')),
    address_binding_id TEXT,
    unallocated_period_id TEXT,
    canonical_recipient_address TEXT COLLATE NOCASE NOT NULL,
    display_recipient_address TEXT NOT NULL,
    delivery_source TEXT NOT NULL CHECK (
        delivery_source IN ('external_receive', 'internal_delivery', 'migration')
    ),
    delivered_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (
        (
            target_type = 'assigned'
            AND address_binding_id IS NOT NULL
            AND unallocated_period_id IS NULL
        )
        OR (
            target_type = 'unallocated'
            AND address_binding_id IS NULL
            AND unallocated_period_id IS NOT NULL
        )
    ),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (address_binding_id) REFERENCES address_bindings (id) ON DELETE RESTRICT,
    FOREIGN KEY (unallocated_period_id) REFERENCES unallocated_address_periods (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX message_deliveries_assigned_unique
    ON message_deliveries (message_id, address_binding_id)
    WHERE target_type = 'assigned';

CREATE UNIQUE INDEX message_deliveries_unallocated_unique
    ON message_deliveries (message_id, unallocated_period_id)
    WHERE target_type = 'unallocated';

CREATE INDEX message_deliveries_binding_index
    ON message_deliveries (address_binding_id, delivered_at DESC, id DESC)
    WHERE address_binding_id IS NOT NULL;

CREATE INDEX message_deliveries_unallocated_index
    ON message_deliveries (unallocated_period_id, delivered_at DESC, id DESC)
    WHERE unallocated_period_id IS NOT NULL;

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
    base_location TEXT NOT NULL CHECK (
        base_location IN ('inbox', 'sent', 'spam')
    ),
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (
        (
            mailbox_type = 'user'
            AND user_id IS NOT NULL
            AND organization_id IS NULL
        )
        OR (
            mailbox_type = 'organization'
            AND user_id IS NULL
            AND organization_id IS NOT NULL
        )
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
    LEFT JOIN address_bindings AS binding
        ON binding.id = delivery.address_binding_id
    LEFT JOIN unallocated_address_periods AS period
        ON period.id = delivery.unallocated_period_id
    WHERE entry.id = NEW.mailbox_entry_id
      AND entry.entry_kind = 'received'
      AND (
          (
              delivery.target_type = 'assigned'
              AND (
                  (
                      entry.mailbox_type = 'user'
                      AND binding.owner_type = 'user'
                      AND binding.user_id = entry.user_id
                  )
                  OR (
                      entry.mailbox_type = 'organization'
                      AND binding.owner_type = 'organization'
                      AND binding.organization_id = entry.organization_id
                  )
              )
          )
          OR (
              delivery.target_type = 'unallocated'
              AND entry.mailbox_type = 'user'
              AND period.status = 'claimed'
              AND period.claimed_by_user_id = entry.user_id
          )
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

CREATE TABLE mailbox_user_states (
    mailbox_entry_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    is_read INTEGER CHECK (is_read IN (0, 1)),
    is_starred INTEGER CHECK (is_starred IN (0, 1)),
    is_archived INTEGER CHECK (is_archived IN (0, 1)),
    location_override TEXT CHECK (
        location_override IN ('inbox', 'sent', 'spam', 'trash', 'hidden')
    ),
    previous_location TEXT CHECK (
        previous_location IN ('inbox', 'sent', 'spam')
    ),
    remote_images_allowed INTEGER CHECK (remote_images_allowed IN (0, 1)),
    trashed_at INTEGER,
    trash_due_at INTEGER,
    hidden_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (mailbox_entry_id, user_id),
    CHECK (
        (
            location_override = 'trash'
            AND previous_location IS NOT NULL
            AND trashed_at IS NOT NULL
            AND trash_due_at IS NOT NULL
            AND trash_due_at > trashed_at
            AND hidden_at IS NULL
        )
        OR (
            location_override = 'hidden'
            AND previous_location IS NOT NULL
            AND trashed_at IS NOT NULL
            AND trash_due_at IS NOT NULL
            AND trash_due_at > trashed_at
            AND hidden_at IS NOT NULL
            AND hidden_at >= trash_due_at
        )
        OR (
            (location_override IS NULL OR location_override IN ('inbox', 'sent', 'spam'))
            AND previous_location IS NULL
            AND trashed_at IS NULL
            AND trash_due_at IS NULL
            AND hidden_at IS NULL
        )
    ),
    FOREIGN KEY (mailbox_entry_id) REFERENCES mailbox_entries (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TRIGGER validate_mailbox_user_state_insert
BEFORE INSERT ON mailbox_user_states
WHEN NOT EXISTS (
    SELECT 1
    FROM mailbox_entries AS entry
    WHERE entry.id = NEW.mailbox_entry_id
      AND (
          (entry.mailbox_type = 'user' AND entry.user_id = NEW.user_id)
          OR (
              entry.mailbox_type = 'organization'
              AND EXISTS (
                  SELECT 1
                  FROM organization_memberships AS membership
                  WHERE membership.organization_id = entry.organization_id
                    AND membership.user_id = NEW.user_id
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, '用户无权创建该邮箱条目的个人状态');
END;

CREATE TRIGGER validate_mailbox_user_state_update
BEFORE UPDATE ON mailbox_user_states
WHEN NOT EXISTS (
    SELECT 1
    FROM mailbox_entries AS entry
    WHERE entry.id = NEW.mailbox_entry_id
      AND (
          (entry.mailbox_type = 'user' AND entry.user_id = NEW.user_id)
          OR (
              entry.mailbox_type = 'organization'
              AND EXISTS (
                  SELECT 1
                  FROM organization_memberships AS membership
                  WHERE membership.organization_id = entry.organization_id
                    AND membership.user_id = NEW.user_id
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, '用户无权修改该邮箱条目的个人状态');
END;

CREATE INDEX mailbox_user_states_user_index
    ON mailbox_user_states (user_id, mailbox_entry_id);

CREATE INDEX mailbox_user_states_trash_expiry_index
    ON mailbox_user_states (location_override, trash_due_at, mailbox_entry_id, user_id)
    WHERE location_override = 'trash';

CREATE TABLE trusted_sender_addresses (
    user_id TEXT NOT NULL,
    canonical_sender_address TEXT COLLATE NOCASE NOT NULL,
    display_sender_address TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, canonical_sender_address),
    CHECK (instr(canonical_sender_address, '@') > 1),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE message_relations (
    id TEXT PRIMARY KEY NOT NULL,
    child_message_id TEXT NOT NULL,
    relation_type TEXT NOT NULL CHECK (
        relation_type IN ('internal_reply', 'in_reply_to', 'reference')
    ),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    target_reference TEXT NOT NULL CHECK (length(target_reference) > 0),
    target_message_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (child_message_id, relation_type, sequence_number),
    CHECK (target_message_id IS NULL OR target_message_id <> child_message_id),
    FOREIGN KEY (child_message_id) REFERENCES messages (id) ON DELETE CASCADE,
    FOREIGN KEY (target_message_id) REFERENCES messages (id) ON DELETE SET NULL
);

CREATE INDEX message_relations_target_reference_index
    ON message_relations (target_reference, child_message_id);

CREATE INDEX message_relations_target_message_index
    ON message_relations (target_message_id, child_message_id)
    WHERE target_message_id IS NOT NULL;

CREATE TABLE mailbox_conversations (
    id TEXT PRIMARY KEY NOT NULL,
    mailbox_type TEXT NOT NULL CHECK (mailbox_type IN ('user', 'organization')),
    user_id TEXT,
    organization_id TEXT,
    root_reference TEXT NOT NULL CHECK (length(root_reference) > 0),
    latest_at INTEGER NOT NULL,
    rebuilt_at INTEGER NOT NULL,
    CHECK (
        (
            mailbox_type = 'user'
            AND user_id IS NOT NULL
            AND organization_id IS NULL
        )
        OR (
            mailbox_type = 'organization'
            AND user_id IS NULL
            AND organization_id IS NOT NULL
        )
    ),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX mailbox_conversations_user_root_unique
    ON mailbox_conversations (user_id, root_reference)
    WHERE mailbox_type = 'user';

CREATE UNIQUE INDEX mailbox_conversations_organization_root_unique
    ON mailbox_conversations (organization_id, root_reference)
    WHERE mailbox_type = 'organization';

CREATE INDEX mailbox_conversations_user_list_index
    ON mailbox_conversations (user_id, latest_at DESC, id DESC)
    WHERE mailbox_type = 'user';

CREATE INDEX mailbox_conversations_organization_list_index
    ON mailbox_conversations (organization_id, latest_at DESC, id DESC)
    WHERE mailbox_type = 'organization';

CREATE TABLE mailbox_conversation_entries (
    mailbox_entry_id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    sort_at INTEGER NOT NULL,
    linked_at INTEGER NOT NULL,
    FOREIGN KEY (mailbox_entry_id) REFERENCES mailbox_entries (id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES mailbox_conversations (id) ON DELETE CASCADE
);

CREATE TRIGGER validate_mailbox_conversation_entry_insert
BEFORE INSERT ON mailbox_conversation_entries
WHEN NOT EXISTS (
    SELECT 1
    FROM mailbox_entries AS entry
    JOIN mailbox_conversations AS conversation
        ON conversation.id = NEW.conversation_id
       AND conversation.mailbox_type = entry.mailbox_type
       AND (
           (
               entry.mailbox_type = 'user'
               AND conversation.user_id = entry.user_id
           )
           OR (
               entry.mailbox_type = 'organization'
               AND conversation.organization_id = entry.organization_id
           )
       )
    WHERE entry.id = NEW.mailbox_entry_id
)
BEGIN
    SELECT RAISE(ABORT, '邮箱条目与会话范围不匹配');
END;

CREATE TRIGGER prevent_mailbox_conversation_entry_change
BEFORE UPDATE ON mailbox_conversation_entries
BEGIN
    SELECT RAISE(ABORT, '派生会话成员关系不可修改');
END;

CREATE INDEX mailbox_conversation_entries_conversation_index
    ON mailbox_conversation_entries (conversation_id, sort_at, mailbox_entry_id);
