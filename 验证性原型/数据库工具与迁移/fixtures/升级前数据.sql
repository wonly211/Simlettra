INSERT INTO users (id, email, status, created_at)
VALUES ('pre-user', 'pre-upgrade@example.test', 'active', 1700000000000);

INSERT INTO addresses (id, address, owner_user_id, kind, created_at)
VALUES ('pre-address', 'pre-upgrade@example.test', 'pre-user', 'primary', 1700000000000);

INSERT INTO messages (id, sender, subject, received_at, has_attachments, visibility, object_key)
VALUES ('pre-message', 'sender@example.net', '升级前邮件', 1700000000000, 0, 'visible', 'objects/pre-message');

INSERT INTO mailbox_entries (
  id,
  user_id,
  message_id,
  delivered_address_id,
  mailbox,
  is_read,
  is_starred,
  is_archived,
  created_at
)
VALUES (
  'pre-entry',
  'pre-user',
  'pre-message',
  'pre-address',
  'inbox',
  0,
  0,
  0,
  1700000000000
);
