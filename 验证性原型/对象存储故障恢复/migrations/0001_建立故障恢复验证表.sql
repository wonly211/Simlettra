PRAGMA foreign_keys = ON;

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  state TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE object_registry (
  object_key TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  message_id TEXT REFERENCES messages(id),
  role TEXT NOT NULL,
  generation INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  expected_size INTEGER NOT NULL,
  expected_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX object_registry_operation_idx ON object_registry(operation_id);
CREATE INDEX object_registry_message_idx ON object_registry(message_id);
CREATE UNIQUE INDEX object_registry_active_role_idx
  ON object_registry(operation_id, role)
  WHERE active = 1;

CREATE TABLE mailbox_entries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX tasks_target_idx ON tasks(target_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail_code TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
