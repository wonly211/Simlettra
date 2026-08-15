-- 澄笺 | Simlettra 正式迁移 0009
-- 依据：需求 6.08、6.10、11.14，ADR 0007、0013，数据-65、数据-71。

PRAGMA foreign_keys = ON;

CREATE TABLE message_search_states (
    message_id TEXT PRIMARY KEY NOT NULL,
    object_set_version INTEGER NOT NULL CHECK (object_set_version >= 1),
    index_generation INTEGER NOT NULL CHECK (index_generation >= 1),
    index_status TEXT NOT NULL CHECK (
        index_status IN ('pending', 'indexing', 'ready', 'needs_attention')
    ),
    chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    last_error_code TEXT,
    indexed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (index_status = 'ready'
            AND chunk_count >= 1
            AND indexed_at IS NOT NULL
            AND last_error_code IS NULL)
        OR (index_status IN ('pending', 'indexing')
            AND indexed_at IS NULL
            AND last_error_code IS NULL)
        OR (index_status = 'needs_attention'
            AND indexed_at IS NULL
            AND last_error_code IS NOT NULL)
    ),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT
);

CREATE INDEX message_search_states_work_index
    ON message_search_states (index_status, updated_at, message_id);

CREATE TABLE message_search_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    index_generation INTEGER NOT NULL CHECK (index_generation >= 1),
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    created_at INTEGER NOT NULL,
    UNIQUE (message_id, index_generation, chunk_index),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT
);

CREATE INDEX message_search_chunks_message_index
    ON message_search_chunks (message_id, index_generation, chunk_index, id);

CREATE VIRTUAL TABLE message_search_index USING fts5(
    body_tokens,
    scopes,
    content='',
    contentless_delete=1,
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER prevent_message_search_state_identity_change
BEFORE UPDATE OF message_id, created_at ON message_search_states
BEGIN
    SELECT RAISE(ABORT, '邮件搜索状态身份不可修改');
END;

CREATE TRIGGER validate_message_search_chunk_insert
BEFORE INSERT ON message_search_chunks
WHEN NOT EXISTS (
    SELECT 1
    FROM message_search_states AS state
    JOIN message_integrity_states AS integrity
      ON integrity.message_id = state.message_id
     AND integrity.integrity_status = 'ready'
     AND integrity.object_set_version = state.object_set_version
    WHERE state.message_id = NEW.message_id
      AND state.index_generation = NEW.index_generation
      AND state.index_status = 'indexing'
)
BEGIN
    SELECT RAISE(ABORT, '搜索分块缺少当前索引状态或完整邮件');
END;

CREATE TRIGGER prevent_message_search_chunk_change
BEFORE UPDATE ON message_search_chunks
BEGIN
    SELECT RAISE(ABORT, '搜索分块身份不可修改');
END;

CREATE TRIGGER prevent_indexed_search_chunk_delete
BEFORE DELETE ON message_search_chunks
WHEN EXISTS (
    SELECT 1 FROM message_search_index WHERE rowid = OLD.id
)
BEGIN
    SELECT RAISE(ABORT, '必须先删除内容空搜索索引再删除分块');
END;

CREATE TRIGGER validate_message_search_ready
BEFORE UPDATE OF index_status ON message_search_states
WHEN NEW.index_status = 'ready'
  AND (
      NEW.chunk_count < 1
      OR NEW.indexed_at IS NULL
      OR NEW.last_error_code IS NOT NULL
      OR NOT EXISTS (
          SELECT 1
          FROM message_integrity_states AS integrity
          WHERE integrity.message_id = NEW.message_id
            AND integrity.integrity_status = 'ready'
            AND integrity.object_set_version = NEW.object_set_version
      )
      OR NEW.chunk_count <> (
          SELECT COUNT(*)
          FROM message_search_chunks AS chunk
          WHERE chunk.message_id = NEW.message_id
            AND chunk.index_generation = NEW.index_generation
      )
      OR EXISTS (
          SELECT 1
          FROM message_search_chunks AS chunk
          WHERE chunk.message_id = NEW.message_id
            AND chunk.index_generation = NEW.index_generation
            AND NOT EXISTS (
                SELECT 1 FROM message_search_index WHERE rowid = chunk.id
            )
      )
  )
BEGIN
    SELECT RAISE(ABORT, '邮件搜索索引尚未完整建立');
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

INSERT INTO message_search_states (
    message_id, object_set_version, index_generation, index_status,
    chunk_count, last_error_code, indexed_at, created_at, updated_at
)
SELECT
    integrity.message_id, integrity.object_set_version, integrity.object_set_version,
    'pending', 0, NULL, NULL, integrity.created_at, integrity.updated_at
FROM message_integrity_states AS integrity
WHERE integrity.integrity_status = 'ready'
  AND NOT EXISTS (
      SELECT 1 FROM message_search_states WHERE message_id = integrity.message_id
  );
