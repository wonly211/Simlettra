CREATE TABLE search_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  UNIQUE (message_id, scope_id, chunk_index)
);

CREATE INDEX search_chunks_scope_message_index
ON search_chunks (scope_id, message_id);

CREATE VIRTUAL TABLE message_search USING fts5(
  scope_token,
  subject_tokens,
  body_tokens,
  content = '',
  tokenize = 'unicode61'
);
