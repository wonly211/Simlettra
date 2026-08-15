-- 澄笺 | Simlettra 正式迁移 0010
-- 依据：需求 6.09、8.11、8.12、9.04，ADR 0016、0017，数据-33、数据-34。

PRAGMA foreign_keys = ON;

CREATE TABLE message_relations (
    id TEXT PRIMARY KEY NOT NULL,
    child_message_id TEXT NOT NULL,
    relation_type TEXT NOT NULL CHECK (
        relation_type IN ('internal_reply', 'in_reply_to', 'reference')
    ),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    target_reference TEXT NOT NULL CHECK (
        length(target_reference) BETWEEN 3 AND 998
    ),
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

CREATE TRIGGER prevent_message_relation_identity_change
BEFORE UPDATE OF id, child_message_id, relation_type, sequence_number,
                 target_reference, created_at ON message_relations
BEGIN
    SELECT RAISE(ABORT, '邮件关系事实不可改写');
END;

CREATE TRIGGER validate_message_relation_target_insert
BEFORE INSERT ON message_relations
WHEN NEW.target_message_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM messages AS target
      WHERE target.id = NEW.target_message_id
        AND target.id <> NEW.child_message_id
        AND (
          NEW.relation_type = 'internal_reply'
          OR target.internet_message_id = NEW.target_reference
        )
  )
BEGIN
    SELECT RAISE(ABORT, '已解析邮件关系与目标引用不匹配');
END;

CREATE TRIGGER validate_message_relation_target_update
BEFORE UPDATE OF target_message_id ON message_relations
WHEN NEW.target_message_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM messages AS target
      WHERE target.id = NEW.target_message_id
        AND target.id <> NEW.child_message_id
        AND (
          NEW.relation_type = 'internal_reply'
          OR target.internet_message_id = NEW.target_reference
        )
  )
BEGIN
    SELECT RAISE(ABORT, '邮件关系不能解析为不匹配的目标');
END;

CREATE TABLE mailbox_conversations (
    id TEXT PRIMARY KEY NOT NULL,
    mailbox_type TEXT NOT NULL CHECK (mailbox_type IN ('user', 'organization')),
    user_id TEXT,
    organization_id TEXT,
    root_reference TEXT NOT NULL CHECK (length(root_reference) BETWEEN 3 AND 998),
    latest_at INTEGER NOT NULL,
    rebuilt_at INTEGER NOT NULL,
    CHECK (
        (mailbox_type = 'user' AND user_id IS NOT NULL AND organization_id IS NULL)
        OR (mailbox_type = 'organization' AND user_id IS NULL AND organization_id IS NOT NULL)
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

CREATE TRIGGER prevent_mailbox_conversation_identity_change
BEFORE UPDATE OF id, mailbox_type, user_id, organization_id,
                 root_reference ON mailbox_conversations
BEGIN
    SELECT RAISE(ABORT, '邮箱会话身份不可改写');
END;

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
       (entry.mailbox_type = 'user' AND conversation.user_id = entry.user_id)
       OR (entry.mailbox_type = 'organization'
           AND conversation.organization_id = entry.organization_id)
     )
    WHERE entry.id = NEW.mailbox_entry_id
      AND entry.occurred_at = NEW.sort_at
)
BEGIN
    SELECT RAISE(ABORT, '邮箱条目与会话范围不匹配');
END;

CREATE TRIGGER prevent_mailbox_conversation_entry_change
BEFORE UPDATE ON mailbox_conversation_entries
BEGIN
    SELECT RAISE(ABORT, '派生会话成员关系不可原地改写');
END;

CREATE INDEX mailbox_conversation_entries_conversation_index
    ON mailbox_conversation_entries (conversation_id, sort_at, mailbox_entry_id);

CREATE TRIGGER remove_empty_mailbox_conversation
AFTER DELETE ON mailbox_conversation_entries
WHEN NOT EXISTS (
    SELECT 1 FROM mailbox_conversation_entries
    WHERE conversation_id = OLD.conversation_id
)
BEGIN
    DELETE FROM mailbox_conversations WHERE id = OLD.conversation_id;
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
