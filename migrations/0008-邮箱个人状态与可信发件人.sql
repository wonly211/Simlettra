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
        is_read IS NOT NULL
        OR is_starred IS NOT NULL
        OR is_archived IS NOT NULL
        OR location_override IS NOT NULL
        OR remote_images_allowed IS NOT NULL
    ),
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
                  JOIN organizations AS organization
                    ON organization.id = membership.organization_id
                  JOIN users AS member_user
                    ON member_user.id = membership.user_id
                  WHERE membership.organization_id = entry.organization_id
                    AND membership.user_id = NEW.user_id
                    AND membership.left_at IS NULL
                    AND organization.status = 'active'
                    AND member_user.status = 'active'
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, '用户无权创建该邮箱条目的个人状态');
END;

CREATE TRIGGER validate_mailbox_user_state_update
BEFORE UPDATE ON mailbox_user_states
WHEN NEW.mailbox_entry_id <> OLD.mailbox_entry_id
   OR NEW.user_id <> OLD.user_id
   OR NOT EXISTS (
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
                     JOIN organizations AS organization
                       ON organization.id = membership.organization_id
                     JOIN users AS member_user
                       ON member_user.id = membership.user_id
                     WHERE membership.organization_id = entry.organization_id
                       AND membership.user_id = NEW.user_id
                       AND membership.left_at IS NULL
                       AND organization.status = 'active'
                       AND member_user.status = 'active'
                 )
             )
         )
   )
BEGIN
    SELECT RAISE(ABORT, '用户无权修改该邮箱条目的个人状态');
END;

CREATE INDEX mailbox_user_states_user_index
    ON mailbox_user_states (user_id, mailbox_entry_id);

CREATE INDEX mailbox_user_states_unread_index
    ON mailbox_user_states (user_id, is_read, mailbox_entry_id)
    WHERE is_read IS NOT NULL;

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
