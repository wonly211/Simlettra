PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  message_key TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  has_attachment INTEGER NOT NULL CHECK (has_attachment IN (0, 1)),
  template_id INTEGER NOT NULL
);

CREATE TABLE mailbox_entries (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  actual_address TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'sent')),
  UNIQUE (message_id, user_id, actual_address)
);

CREATE TABLE mailbox_states (
  mailbox_entry_id INTEGER PRIMARY KEY REFERENCES mailbox_entries(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  is_read INTEGER NOT NULL CHECK (is_read IN (0, 1)),
  is_starred INTEGER NOT NULL CHECK (is_starred IN (0, 1)),
  is_archived INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
  trashed_at INTEGER
);

CREATE TABLE search_chunks (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  chunk_index INTEGER NOT NULL,
  UNIQUE (message_id, chunk_index)
);

CREATE TABLE search_templates (
  id INTEGER PRIMARY KEY,
  first_chunk_tokens TEXT NOT NULL,
  second_chunk_tokens TEXT NOT NULL
);

CREATE TABLE seed_numbers (
  value INTEGER PRIMARY KEY
);

CREATE INDEX mailbox_entries_user_message
  ON mailbox_entries(user_id, message_id DESC);

CREATE INDEX mailbox_states_user_flags
  ON mailbox_states(user_id, is_read, is_starred, is_archived, trashed_at, mailbox_entry_id);

CREATE INDEX messages_sender_sent_at
  ON messages(sender_address, sent_at DESC);

CREATE INDEX messages_recipient_sent_at
  ON messages(recipient_address, sent_at DESC);

CREATE INDEX messages_attachment_sent_at
  ON messages(has_attachment, sent_at DESC);

CREATE INDEX search_chunks_message
  ON search_chunks(message_id, id);

CREATE VIRTUAL TABLE message_search USING fts5(
  subject,
  participants,
  attachment_names,
  body_tokens,
  scopes,
  content='',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE probe_unicode USING fts5(
  body,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE probe_bigram USING fts5(
  body,
  tokenize='unicode61 remove_diacritics 2'
);
