import type { BackgroundTaskMessage } from '../../../shared/contracts/background-task'
import type { MailboxScope, MailboxSearchIndexState } from '../../../shared/contracts/mailbox'
import type { BackgroundTaskExecutionResult } from '../../tasks/application/background-task-service'
import { bytesToHex, equalBytes, sha256Bytes } from '../../mail-receiving/domain/content-digest'
import type { MailObjectStore } from '../../mail-receiving/infrastructure/object-storage'
import { createBodyMatchPhrase, tokenizeSearchText } from '../domain/search-tokenizer'

const INDEX_TASK_MAX_ATTEMPTS = 5
const TASK_DISCOVERY_LIMIT = 90
const TEXT_CHUNK_LENGTH = 12_000
const TEXT_CHUNK_OVERLAP = 128
const DATABASE_BATCH_SIZE = 40

interface SearchStateRow {
  message_id: string
  object_set_version: number
  index_generation: number
  index_status: string
}

interface SearchBodyObjectRow {
  object_key: string
  expected_size_bytes: number
  actual_size_bytes: number | null
  expected_sha256: ArrayBuffer
  actual_sha256: ArrayBuffer | null
}

interface SearchChunkRow {
  id: number
  chunk_index: number
}

interface SearchAvailabilityRow {
  incomplete_count: number
  attention_count: number
}

export interface PreparedMessageSearchWork {
  task: BackgroundTaskMessage
  statements: D1PreparedStatement[]
}

export interface BodySearchPlan {
  matchExpression: string
  indexState: MailboxSearchIndexState
}

export async function prepareInitialMessageSearchWork(options: {
  database: D1Database
  messageId: string
  objectSetVersion: number
  now: number
}): Promise<PreparedMessageSearchWork> {
  const generation = options.objectSetVersion
  const taskId = crypto.randomUUID()
  const taskKeyDigest = await sha256Bytes(`index_message\n${options.messageId}\n${generation}`)
  return {
    task: { taskId, inputVersion: generation },
    statements: [
      options.database
        .prepare(
          `INSERT INTO message_search_states (
             message_id, object_set_version, index_generation, index_status,
             chunk_count, last_error_code, indexed_at, created_at, updated_at
           ) VALUES (?1, ?2, ?2, 'pending', 0, NULL, NULL, ?3, ?3)`,
        )
        .bind(options.messageId, options.objectSetVersion, options.now),
      createIndexTaskStatement(options.database, {
        taskId,
        messageId: options.messageId,
        generation,
        taskKeyDigest,
        now: options.now,
      }),
    ],
  }
}

export async function ensurePendingMessageIndexTasks(options: {
  database: D1Database
  queue?: Queue<BackgroundTaskMessage>
  now?: number
  limit?: number
}): Promise<number> {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? TASK_DISCOVERY_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > TASK_DISCOVERY_LIMIT) {
    throw new Error('单次搜索任务补建数量必须在 1 至 90 之间')
  }
  const states = await options.database
    .prepare(
      `SELECT state.message_id, state.object_set_version,
              state.index_generation, state.index_status
       FROM message_search_states AS state
       JOIN message_integrity_states AS integrity
         ON integrity.message_id = state.message_id
        AND integrity.integrity_status = 'ready'
        AND integrity.object_set_version = state.object_set_version
       WHERE state.index_status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM background_tasks AS task
           WHERE task.task_type = 'index_message'
             AND task.target_type = 'message_search'
             AND task.target_reference = state.message_id
             AND task.input_version = state.index_generation
             AND task.task_status <> 'cancelled'
         )
       ORDER BY state.updated_at, state.message_id
       LIMIT ?1`,
    )
    .bind(limit)
    .all<SearchStateRow>()

  const messages: BackgroundTaskMessage[] = []
  const statements: D1PreparedStatement[] = []
  for (const state of states.results) {
    const taskId = crypto.randomUUID()
    const taskKeyDigest = await sha256Bytes(
      `index_message\n${state.message_id}\n${state.index_generation}`,
    )
    messages.push({ taskId, inputVersion: state.index_generation })
    statements.push(
      createIndexTaskStatement(options.database, {
        taskId,
        messageId: state.message_id,
        generation: state.index_generation,
        taskKeyDigest,
        now,
      }),
    )
  }
  if (statements.length === 0) return 0
  const results = await options.database.batch(statements)
  const created = results.filter((result) => result.meta.changes === 1).length
  if (options.queue && created > 0) {
    const createdMessages = messages.filter((_, index) => results[index]?.meta.changes === 1)
    await options.queue.sendBatch(createdMessages.map((body) => ({ body })))
  }
  return created
}

export async function requestMessageSearchRebuild(options: {
  database: D1Database
  now?: number
}): Promise<number> {
  const now = options.now ?? Date.now()
  const results = await options.database.batch([
    options.database
      .prepare(
        `INSERT INTO message_search_states (
           message_id, object_set_version, index_generation, index_status,
           chunk_count, last_error_code, indexed_at, created_at, updated_at
         )
         SELECT integrity.message_id, integrity.object_set_version,
                integrity.object_set_version, 'pending', 0, NULL, NULL, ?1, ?1
         FROM message_integrity_states AS integrity
         WHERE integrity.integrity_status = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM message_search_states AS state
             WHERE state.message_id = integrity.message_id
           )`,
      )
      .bind(now),
    options.database
      .prepare(
        `UPDATE message_search_states
         SET object_set_version = (
               SELECT integrity.object_set_version
               FROM message_integrity_states AS integrity
               WHERE integrity.message_id = message_search_states.message_id
             ),
             index_generation = index_generation + 1,
             index_status = 'pending', chunk_count = 0,
             last_error_code = NULL, indexed_at = NULL, updated_at = ?1
         WHERE EXISTS (
           SELECT 1 FROM message_integrity_states AS integrity
           WHERE integrity.message_id = message_search_states.message_id
             AND integrity.integrity_status = 'ready'
         )`,
      )
      .bind(now),
  ])
  return results[1]?.meta.changes ?? 0
}

export async function processMessageIndexTask(options: {
  database: D1Database
  objectStore: MailObjectStore
  messageId: string
  inputVersion: number
  now?: number
}): Promise<BackgroundTaskExecutionResult> {
  const now = options.now ?? Date.now()
  const state = await options.database
    .prepare(
      `SELECT message_id, object_set_version, index_generation, index_status
       FROM message_search_states WHERE message_id = ?1 LIMIT 1`,
    )
    .bind(options.messageId)
    .first<SearchStateRow>()
  if (!state) return { status: 'succeeded' }
  if (state.index_generation !== options.inputVersion) return { status: 'succeeded' }
  if (state.index_status === 'ready') return { status: 'succeeded' }
  if (!['pending', 'indexing'].includes(state.index_status)) {
    return { status: 'needs_attention', errorCode: 'message_search_state_mismatch' }
  }

  const started = await options.database
    .prepare(
      `UPDATE message_search_states
       SET index_status = 'indexing', chunk_count = 0,
           last_error_code = NULL, indexed_at = NULL, updated_at = ?1
       WHERE message_id = ?2 AND index_generation = ?3
         AND index_status IN ('pending', 'indexing')
         AND EXISTS (
           SELECT 1 FROM message_integrity_states AS integrity
           WHERE integrity.message_id = ?2
             AND integrity.integrity_status = 'ready'
             AND integrity.object_set_version = message_search_states.object_set_version
         )`,
    )
    .bind(now, state.message_id, state.index_generation)
    .run()
  if (started.meta.changes !== 1) {
    return { status: 'needs_attention', errorCode: 'message_search_integrity_mismatch' }
  }

  const bodyObject = await options.database
    .prepare(
      `SELECT object_key, expected_size_bytes, actual_size_bytes,
              expected_sha256, actual_sha256
       FROM object_registry
       WHERE message_id = ?1 AND object_role = 'plain_body'
         AND is_current = 1 AND object_status = 'active'
       ORDER BY generation DESC LIMIT 1`,
    )
    .bind(state.message_id)
    .first<SearchBodyObjectRow>()
  if (!bodyObject) {
    return { status: 'needs_attention', errorCode: 'message_search_body_missing' }
  }
  const stored = await options.objectStore.get(bodyObject.object_key)
  if (!stored) throw new Error('正文对象暂时不可用于建立搜索索引')
  const expectedSize = bodyObject.actual_size_bytes ?? bodyObject.expected_size_bytes
  const expectedDigest = bodyObject.actual_sha256 ?? bodyObject.expected_sha256
  const actualDigest = await sha256Bytes(stored.bytes)
  if (stored.bytes.byteLength !== expectedSize || !equalBytes(actualDigest, expectedDigest)) {
    return { status: 'needs_attention', errorCode: 'message_search_body_mismatch' }
  }

  const scopes = await readMessageScopeTokens(options.database, state.message_id)
  if (scopes.length === 0) return { status: 'succeeded' }
  const scopeText = scopes.join(' ')
  const bodyText = new TextDecoder().decode(stored.bytes)

  await options.database
    .prepare(
      `DELETE FROM message_search_index
       WHERE rowid IN (
         SELECT id FROM message_search_chunks WHERE message_id = ?1
       )`,
    )
    .bind(state.message_id)
    .run()
  await options.database
    .prepare('DELETE FROM message_search_chunks WHERE message_id = ?1')
    .bind(state.message_id)
    .run()

  let chunkIndex = 0
  for (const chunkGroup of groupTextChunks(bodyText, DATABASE_BATCH_SIZE)) {
    const startIndex = chunkIndex
    const metadataStatements = chunkGroup.map((_, offset) =>
      options.database
        .prepare(
          `INSERT INTO message_search_chunks (
             message_id, index_generation, chunk_index, created_at
           ) VALUES (?1, ?2, ?3, ?4)`,
        )
        .bind(state.message_id, state.index_generation, startIndex + offset, now),
    )
    await options.database.batch(metadataStatements)
    const rows = await options.database
      .prepare(
        `SELECT id, chunk_index FROM message_search_chunks
         WHERE message_id = ?1 AND index_generation = ?2
           AND chunk_index >= ?3 AND chunk_index < ?4
         ORDER BY chunk_index`,
      )
      .bind(state.message_id, state.index_generation, startIndex, startIndex + chunkGroup.length)
      .all<SearchChunkRow>()
    if (rows.results.length !== chunkGroup.length) {
      throw new Error('搜索分块编号没有完整建立')
    }
    await options.database.batch(
      rows.results.map((row, index) =>
        options.database
          .prepare(
            `INSERT INTO message_search_index (rowid, body_tokens, scopes)
             VALUES (?1, ?2, ?3)`,
          )
          .bind(row.id, tokenizeSearchText(chunkGroup[index] ?? ''), scopeText),
      ),
    )
    chunkIndex += chunkGroup.length
  }

  const completed = await options.database
    .prepare(
      `UPDATE message_search_states
       SET index_status = 'ready', chunk_count = ?1,
           last_error_code = NULL, indexed_at = ?2, updated_at = ?2
       WHERE message_id = ?3 AND index_generation = ?4 AND index_status = 'indexing'`,
    )
    .bind(chunkIndex, now, state.message_id, state.index_generation)
    .run()
  if (completed.meta.changes !== 1) throw new Error('搜索索引版本已经发生变化')
  return { status: 'succeeded' }
}

export async function prepareBodySearchPlan(options: {
  database: D1Database
  userId: string
  scope: MailboxScope
  organizationId: string | null
  body: string
}): Promise<BodySearchPlan> {
  const phrase = createBodyMatchPhrase(options.body)
  const scopeTokens = await readUserScopeTokens(
    options.database,
    options.userId,
    options.scope,
    options.organizationId,
  )
  const availability = await readSearchAvailability(
    options.database,
    options.userId,
    options.scope,
    options.organizationId,
  )
  const status =
    availability.attention_count > 0
      ? 'needs_attention'
      : availability.incomplete_count > 0
        ? 'building'
        : 'ready'
  const scopeExpression = scopeTokens
    .map((token) => `scopes : "${token.replaceAll('"', '""')}"`)
    .join(' OR ')
  return {
    matchExpression: `(${scopeExpression}) AND body_tokens : ${phrase}`,
    indexState: {
      status,
      pendingMessageCount: availability.incomplete_count,
    },
  }
}

async function readSearchAvailability(
  database: D1Database,
  userId: string,
  scope: MailboxScope,
  organizationId: string | null,
): Promise<SearchAvailabilityRow> {
  const row = await database
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN accessible.index_status <> 'ready' THEN 1 ELSE 0 END), 0)
           AS incomplete_count,
         COALESCE(SUM(CASE WHEN accessible.index_status = 'needs_attention' THEN 1 ELSE 0 END), 0)
           AS attention_count
       FROM (
         SELECT DISTINCT entry.message_id, COALESCE(state.index_status, 'pending') AS index_status
         FROM mailbox_entries AS entry
         JOIN messages AS message ON message.id = entry.message_id
         JOIN message_integrity_states AS integrity
           ON integrity.message_id = message.id AND integrity.integrity_status = 'ready'
         LEFT JOIN message_search_states AS state ON state.message_id = message.id
         LEFT JOIN organizations AS organization ON organization.id = entry.organization_id
         LEFT JOIN organization_memberships AS membership
           ON membership.organization_id = entry.organization_id
          AND membership.user_id = ?1 AND membership.left_at IS NULL
         WHERE (
           (entry.mailbox_type = 'user' AND entry.user_id = ?1)
           OR (entry.mailbox_type = 'organization' AND membership.id IS NOT NULL
               AND organization.status = 'active')
         )
         AND (
           ?2 = 'all'
           OR (?2 = 'personal' AND entry.mailbox_type = 'user')
           OR (?2 = 'organization' AND entry.mailbox_type = 'organization'
               AND entry.organization_id = ?3)
         )
       ) AS accessible`,
    )
    .bind(userId, scope, organizationId)
    .first<SearchAvailabilityRow>()
  return row ?? { incomplete_count: 0, attention_count: 0 }
}

async function readMessageScopeTokens(database: D1Database, messageId: string): Promise<string[]> {
  const rows = await database
    .prepare(
      `SELECT mailbox_type, user_id, organization_id
       FROM mailbox_entries WHERE message_id = ?1 ORDER BY id`,
    )
    .bind(messageId)
    .all<{ mailbox_type: string; user_id: string | null; organization_id: string | null }>()
  const tokens = await Promise.all(
    rows.results.map((row) =>
      createScopeToken(
        row.mailbox_type === 'organization' ? 'organization' : 'user',
        row.organization_id ?? row.user_id ?? '',
      ),
    ),
  )
  return [...new Set(tokens)]
}

async function readUserScopeTokens(
  database: D1Database,
  userId: string,
  scope: MailboxScope,
  organizationId: string | null,
): Promise<string[]> {
  if (scope === 'personal') return [await createScopeToken('user', userId)]
  if (scope === 'organization') {
    return [await createScopeToken('organization', organizationId ?? '')]
  }
  const organizations = await database
    .prepare(
      `SELECT organization_id FROM organization_memberships
       WHERE user_id = ?1 AND left_at IS NULL ORDER BY joined_at, id`,
    )
    .bind(userId)
    .all<{ organization_id: string }>()
  return Promise.all([
    createScopeToken('user', userId),
    ...organizations.results.map((row) => createScopeToken('organization', row.organization_id)),
  ])
}

async function createScopeToken(type: 'user' | 'organization', reference: string): Promise<string> {
  const digest = await sha256Bytes(`${type}:${reference}`)
  return `${type === 'user' ? 'usr' : 'org'}${bytesToHex(digest)}`
}

function createIndexTaskStatement(
  database: D1Database,
  options: {
    taskId: string
    messageId: string
    generation: number
    taskKeyDigest: Uint8Array
    now: number
  },
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO background_tasks (
         id, task_type, target_type, target_reference, input_version,
         task_key_digest, task_status, priority, attempt_count, max_attempts,
         next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
         last_error_code, last_error_summary, last_error_at, completed_at,
         created_at, updated_at
       ) SELECT
         ?1, 'index_message', 'message_search', ?2, ?3,
         ?4, 'pending', 5, 0, ?5, ?6, NULL, 0, NULL,
         NULL, NULL, NULL, NULL, ?6, ?6
       WHERE EXISTS (
         SELECT 1 FROM message_search_states
         WHERE message_id = ?2 AND index_generation = ?3
       )`,
    )
    .bind(
      options.taskId,
      options.messageId,
      options.generation,
      options.taskKeyDigest,
      INDEX_TASK_MAX_ATTEMPTS,
      options.now,
    )
}

function* textChunks(text: string): Generator<string> {
  if (text.length === 0) {
    yield ''
    return
  }
  const step = TEXT_CHUNK_LENGTH - TEXT_CHUNK_OVERLAP
  for (let start = 0; start < text.length; start += step) {
    yield text.slice(start, Math.min(text.length, start + TEXT_CHUNK_LENGTH))
  }
}

function* groupTextChunks(text: string, groupSize: number): Generator<string[]> {
  let group: string[] = []
  for (const chunk of textChunks(text)) {
    group.push(chunk)
    if (group.length === groupSize) {
      yield group
      group = []
    }
  }
  if (group.length > 0) yield group
}
