import type { BackgroundTaskMessage } from '../../../shared/contracts/background-task'
import { bytesToHex, sha256Bytes } from '../../mail-receiving/domain/content-digest'
import type { BackgroundTaskExecutionResult } from '../../tasks/application/background-task-service'

const REBUILD_TASK_MAX_ATTEMPTS = 5
const TASK_DISCOVERY_LIMIT = 90
const PARAMETER_CHUNK_SIZE = 90
const INSERT_BATCH_SIZE = 40
const MAX_CONNECTED_MESSAGES = 1_000

export interface ParsedMessageRelation {
  relationType: 'internal_reply' | 'in_reply_to' | 'reference'
  sequenceNumber: number
  targetReference: string
  targetMessageId?: string | null
}

export interface PreparedMessageConversationWork {
  task: BackgroundTaskMessage
  statements: D1PreparedStatement[]
}

interface RelationRow {
  child_message_id: string
  target_reference: string
  target_message_id: string | null
}

interface MessageMetadataRow {
  id: string
  internet_message_id: string | null
  sort_at: number
}

interface MailboxEntryRow {
  id: string
  message_id: string
  mailbox_type: 'user' | 'organization'
  user_id: string | null
  organization_id: string | null
  occurred_at: number
}

interface PendingMessageRow {
  message_id: string
  input_version: number
}

export async function prepareInitialMessageConversationWork(options: {
  database: D1Database
  messageId: string
  relations: ParsedMessageRelation[]
  now: number
}): Promise<PreparedMessageConversationWork> {
  const inputVersion = 1
  const taskId = crypto.randomUUID()
  const taskKeyDigest = await conversationTaskDigest(options.messageId, inputVersion)
  const relationStatements = options.relations.map((relation) =>
    options.database
      .prepare(
        `INSERT INTO message_relations (
           id, child_message_id, relation_type, sequence_number,
           target_reference, target_message_id, created_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5,
           CASE
             WHEN ?6 IS NOT NULL THEN ?6
             WHEN 1 = (
               SELECT COUNT(*) FROM messages WHERE internet_message_id = ?5
             ) THEN (
               SELECT id FROM messages WHERE internet_message_id = ?5 LIMIT 1
             )
             ELSE NULL
           END,
           ?7
         )`,
      )
      .bind(
        crypto.randomUUID(),
        options.messageId,
        relation.relationType,
        relation.sequenceNumber,
        relation.targetReference,
        relation.targetMessageId ?? null,
        options.now,
      ),
  )
  return {
    task: { taskId, inputVersion },
    statements: [
      ...relationStatements,
      createConversationTaskStatement(options.database, {
        taskId,
        messageId: options.messageId,
        inputVersion,
        taskKeyDigest,
        now: options.now,
      }),
    ],
  }
}

export async function ensurePendingConversationRebuildTasks(options: {
  database: D1Database
  queue?: Queue<BackgroundTaskMessage>
  now?: number
  limit?: number
}): Promise<number> {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? TASK_DISCOVERY_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > TASK_DISCOVERY_LIMIT) {
    throw new Error('单次会话任务补建数量必须在 1 至 90 之间')
  }
  const pending = await options.database
    .prepare(
      `SELECT entry.message_id,
              COALESCE((
                SELECT MAX(history.input_version)
                FROM background_tasks AS history
                WHERE history.task_type = 'rebuild_conversation'
                  AND history.target_type = 'message_conversation'
                  AND history.target_reference = entry.message_id
              ), 0) + 1 AS input_version
       FROM mailbox_entries AS entry
       JOIN message_integrity_states AS integrity
         ON integrity.message_id = entry.message_id
        AND integrity.integrity_status = 'ready'
       LEFT JOIN mailbox_conversation_entries AS member
         ON member.mailbox_entry_id = entry.id
       WHERE member.mailbox_entry_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM background_tasks AS active
           WHERE active.task_type = 'rebuild_conversation'
             AND active.target_type = 'message_conversation'
             AND active.target_reference = entry.message_id
             AND active.task_status IN ('pending', 'running', 'retry_wait')
         )
       GROUP BY entry.message_id
       ORDER BY MIN(entry.created_at), entry.message_id
       LIMIT ?1`,
    )
    .bind(limit)
    .all<PendingMessageRow>()

  const messages: BackgroundTaskMessage[] = []
  const statements: D1PreparedStatement[] = []
  for (const row of pending.results) {
    const taskId = crypto.randomUUID()
    const taskKeyDigest = await conversationTaskDigest(row.message_id, row.input_version)
    messages.push({ taskId, inputVersion: row.input_version })
    statements.push(
      createConversationTaskStatement(options.database, {
        taskId,
        messageId: row.message_id,
        inputVersion: row.input_version,
        taskKeyDigest,
        now,
      }),
    )
  }
  if (statements.length === 0) return 0
  const results = await options.database.batch(statements)
  const createdMessages = messages.filter((_, index) => results[index]?.meta.changes === 1)
  if (options.queue && createdMessages.length > 0) {
    await options.queue.sendBatch(createdMessages.map((body) => ({ body })))
  }
  return createdMessages.length
}

export async function requestMailboxConversationRebuild(options: {
  database: D1Database
  queue?: Queue<BackgroundTaskMessage>
  now?: number
}): Promise<number> {
  const memberCount = await options.database
    .prepare('SELECT COUNT(*) AS count FROM mailbox_conversation_entries')
    .first<{ count: number }>()
  await options.database.batch([
    options.database.prepare('DELETE FROM mailbox_conversation_entries'),
    options.database.prepare('DELETE FROM mailbox_conversations'),
  ])
  await ensurePendingConversationRebuildTasks(options)
  return memberCount?.count ?? 0
}

export async function processMessageConversationTask(options: {
  database: D1Database
  messageId: string
  now?: number
}): Promise<BackgroundTaskExecutionResult> {
  const now = options.now ?? Date.now()
  const exists = await options.database
    .prepare('SELECT 1 AS present FROM messages WHERE id = ?1 LIMIT 1')
    .bind(options.messageId)
    .first<{ present: number }>()
  if (!exists) return { status: 'succeeded' }

  const component = await collectConnectedMessages(options.database, options.messageId)
  if (component.size > MAX_CONNECTED_MESSAGES) {
    return { status: 'needs_attention', errorCode: 'conversation_graph_too_large' }
  }
  const messageRows = await readMessageMetadata(options.database, [...component])
  const messageIds = new Set(messageRows.map((row) => row.id))
  if (!messageIds.has(options.messageId)) return { status: 'succeeded' }
  const relations = await readRelationsForMessages(options.database, [...messageIds])
  const rootReference = await chooseRootReference(options.database, messageRows, relations)
  const entries = await readMailboxEntries(options.database, [...messageIds])
  const scopes = groupEntriesByScope(entries)
  for (const scopeEntries of scopes.values()) {
    await rebuildScopeConversation(options.database, scopeEntries, rootReference, now)
  }
  return { status: 'succeeded' }
}

async function collectConnectedMessages(database: D1Database, seedMessageId: string) {
  const seen = new Set([seedMessageId])
  let frontier = [seedMessageId]
  while (frontier.length > 0) {
    const metadata = await readMessageMetadata(database, frontier)
    const internetIds = metadata
      .map((row) => row.internet_message_id)
      .filter((value): value is string => Boolean(value))
    const uniqueInternetIds = await readUniqueInternetMessageIds(database, internetIds)
    await resolveRelations(database, frontier, uniqueInternetIds)
    const relations = await readAdjacentRelations(database, frontier, uniqueInternetIds)
    const relationReferences = [...new Set(relations.map((row) => row.target_reference))]
    const referenceCounts = await readInternetMessageIdCounts(database, relationReferences)
    const sharedReferences = relationReferences.filter(
      (reference) => (referenceCounts.get(reference) ?? 0) < 2,
    )
    const shared = await readRelationsByReferences(database, sharedReferences)
    const next = new Set<string>()
    for (const relation of [...relations, ...shared]) {
      if (!seen.has(relation.child_message_id)) next.add(relation.child_message_id)
      if (relation.target_message_id && !seen.has(relation.target_message_id)) {
        next.add(relation.target_message_id)
      }
    }
    for (const messageId of next) seen.add(messageId)
    if (seen.size > MAX_CONNECTED_MESSAGES) return seen
    frontier = [...next]
  }
  return seen
}

async function readUniqueInternetMessageIds(database: D1Database, internetIds: string[]) {
  const result: string[] = []
  for (const chunk of chunks([...new Set(internetIds)], PARAMETER_CHUNK_SIZE)) {
    if (chunk.length === 0) continue
    const rows = await database
      .prepare(
        `SELECT internet_message_id
         FROM messages
         WHERE internet_message_id IN (${placeholders(chunk.length)})
         GROUP BY internet_message_id
         HAVING COUNT(*) = 1`,
      )
      .bind(...chunk)
      .all<{ internet_message_id: string }>()
    result.push(...rows.results.map((row) => row.internet_message_id))
  }
  return result
}

async function resolveRelations(
  database: D1Database,
  childMessageIds: string[],
  targetReferences: string[],
) {
  for (const childChunk of chunks(childMessageIds, PARAMETER_CHUNK_SIZE)) {
    await database
      .prepare(
        `UPDATE message_relations
         SET target_message_id = (
           SELECT candidate.id FROM messages AS candidate
           WHERE candidate.internet_message_id = message_relations.target_reference LIMIT 1
         )
         WHERE target_message_id IS NULL
           AND child_message_id IN (${placeholders(childChunk.length)})
           AND 1 = (
             SELECT COUNT(*) FROM messages AS candidate
             WHERE candidate.internet_message_id = message_relations.target_reference
           )`,
      )
      .bind(...childChunk)
      .run()
  }
  for (const referenceChunk of chunks(targetReferences, PARAMETER_CHUNK_SIZE)) {
    if (referenceChunk.length === 0) continue
    await database
      .prepare(
        `UPDATE message_relations
         SET target_message_id = (
           SELECT candidate.id FROM messages AS candidate
           WHERE candidate.internet_message_id = message_relations.target_reference LIMIT 1
         )
         WHERE target_message_id IS NULL
           AND target_reference IN (${placeholders(referenceChunk.length)})
           AND 1 = (
             SELECT COUNT(*) FROM messages AS candidate
             WHERE candidate.internet_message_id = message_relations.target_reference
           )`,
      )
      .bind(...referenceChunk)
      .run()
  }
}

async function readAdjacentRelations(
  database: D1Database,
  messageIds: string[],
  internetIds: string[],
): Promise<RelationRow[]> {
  const result: RelationRow[] = []
  for (const messageChunk of chunks(messageIds, Math.floor(PARAMETER_CHUNK_SIZE / 2))) {
    const referenceChunk = internetIds.slice(0, PARAMETER_CHUNK_SIZE - messageChunk.length * 2)
    const referenceSql = referenceChunk.length
      ? ` OR target_reference IN (${placeholders(referenceChunk.length, messageChunk.length * 2)})`
      : ''
    const rows = await database
      .prepare(
        `SELECT child_message_id, target_reference, target_message_id
         FROM message_relations
         WHERE child_message_id IN (${placeholders(messageChunk.length)})
            OR target_message_id IN (${placeholders(messageChunk.length, messageChunk.length)})
            ${referenceSql}`,
      )
      .bind(...messageChunk, ...messageChunk, ...referenceChunk)
      .all<RelationRow>()
    result.push(...rows.results)
  }
  return uniqueRelations(result)
}

async function readRelationsByReferences(database: D1Database, references: string[]) {
  const result: RelationRow[] = []
  for (const chunk of chunks(references, PARAMETER_CHUNK_SIZE)) {
    if (chunk.length === 0) continue
    const rows = await database
      .prepare(
        `SELECT child_message_id, target_reference, target_message_id
         FROM message_relations WHERE target_reference IN (${placeholders(chunk.length)})`,
      )
      .bind(...chunk)
      .all<RelationRow>()
    result.push(...rows.results)
  }
  return uniqueRelations(result)
}

async function readRelationsForMessages(database: D1Database, messageIds: string[]) {
  const result: RelationRow[] = []
  for (const chunk of chunks(messageIds, PARAMETER_CHUNK_SIZE)) {
    const rows = await database
      .prepare(
        `SELECT child_message_id, target_reference, target_message_id
         FROM message_relations WHERE child_message_id IN (${placeholders(chunk.length)})
         ORDER BY child_message_id, relation_type, sequence_number`,
      )
      .bind(...chunk)
      .all<RelationRow>()
    result.push(...rows.results)
  }
  return result
}

async function readMessageMetadata(database: D1Database, messageIds: string[]) {
  const result: MessageMetadataRow[] = []
  for (const chunk of chunks(messageIds, PARAMETER_CHUNK_SIZE)) {
    if (chunk.length === 0) continue
    const rows = await database
      .prepare(
        `SELECT id, internet_message_id, sort_at FROM messages
         WHERE id IN (${placeholders(chunk.length)}) ORDER BY sort_at, id`,
      )
      .bind(...chunk)
      .all<MessageMetadataRow>()
    result.push(...rows.results)
  }
  return result.sort(
    (left, right) => left.sort_at - right.sort_at || left.id.localeCompare(right.id),
  )
}

async function readMailboxEntries(database: D1Database, messageIds: string[]) {
  const result: MailboxEntryRow[] = []
  for (const chunk of chunks(messageIds, PARAMETER_CHUNK_SIZE)) {
    const rows = await database
      .prepare(
        `SELECT id, message_id, mailbox_type, user_id, organization_id, occurred_at
         FROM mailbox_entries WHERE message_id IN (${placeholders(chunk.length)})
         ORDER BY mailbox_type, COALESCE(user_id, organization_id), occurred_at, id`,
      )
      .bind(...chunk)
      .all<MailboxEntryRow>()
    result.push(...rows.results)
  }
  return result
}

async function rebuildScopeConversation(
  database: D1Database,
  entries: MailboxEntryRow[],
  rootReference: string,
  now: number,
) {
  const first = entries[0]
  if (!first) return
  const ownerId = first.user_id ?? first.organization_id
  if (!ownerId) throw new Error('会话邮箱范围缺少所有者')
  const conversationId = `conversation-${bytesToHex(
    await sha256Bytes(`${first.mailbox_type}\n${ownerId}\n${rootReference}`),
  )}`
  const entryIds = entries.map((entry) => entry.id)
  const oldConversationIds = new Set<string>()
  for (const chunk of chunks(entryIds, PARAMETER_CHUNK_SIZE)) {
    const rows = await database
      .prepare(
        `SELECT DISTINCT conversation_id FROM mailbox_conversation_entries
         WHERE mailbox_entry_id IN (${placeholders(chunk.length)})`,
      )
      .bind(...chunk)
      .all<{ conversation_id: string }>()
    rows.results.forEach((row) => oldConversationIds.add(row.conversation_id))
    await database
      .prepare(
        `DELETE FROM mailbox_conversation_entries
         WHERE mailbox_entry_id IN (${placeholders(chunk.length)})`,
      )
      .bind(...chunk)
      .run()
  }
  for (const oldId of oldConversationIds) {
    await database
      .prepare(
        `DELETE FROM mailbox_conversations WHERE id = ?1
         AND NOT EXISTS (
           SELECT 1 FROM mailbox_conversation_entries WHERE conversation_id = ?1
         )`,
      )
      .bind(oldId)
      .run()
  }
  const latestAt = Math.max(...entries.map((entry) => entry.occurred_at))
  await database
    .prepare(
      `INSERT INTO mailbox_conversations (
         id, mailbox_type, user_id, organization_id,
         root_reference, latest_at, rebuilt_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET latest_at = excluded.latest_at,
         rebuilt_at = excluded.rebuilt_at`,
    )
    .bind(
      conversationId,
      first.mailbox_type,
      first.user_id,
      first.organization_id,
      rootReference,
      latestAt,
      now,
    )
    .run()
  for (const entryBatch of chunks(entries, INSERT_BATCH_SIZE)) {
    await database.batch(
      entryBatch.map((entry) =>
        database
          .prepare(
            `INSERT INTO mailbox_conversation_entries (
               mailbox_entry_id, conversation_id, sort_at, linked_at
             ) VALUES (?1, ?2, ?3, ?4)`,
          )
          .bind(entry.id, conversationId, entry.occurred_at, now),
      ),
    )
  }
}

function groupEntriesByScope(entries: MailboxEntryRow[]) {
  const result = new Map<string, MailboxEntryRow[]>()
  for (const entry of entries) {
    const ownerId = entry.user_id ?? entry.organization_id
    if (!ownerId) continue
    const key = `${entry.mailbox_type}:${ownerId}`
    const values = result.get(key) ?? []
    values.push(entry)
    result.set(key, values)
  }
  return result
}

async function chooseRootReference(
  database: D1Database,
  messages: MessageMetadataRow[],
  relations: RelationRow[],
) {
  const internetIds = new Set(
    messages
      .map((message) => message.internet_message_id)
      .filter((value): value is string => Boolean(value)),
  )
  const candidates = [
    ...new Set([...relations.map((relation) => relation.target_reference), ...internetIds]),
  ]
  const counts = await readInternetMessageIdCounts(database, candidates)
  const missingTargets = [...new Set(relations.map((relation) => relation.target_reference))]
    .filter((reference) => !internetIds.has(reference) && (counts.get(reference) ?? 0) === 0)
    .sort()
  if (missingTargets[0]) return missingTargets[0]
  const earliest = messages[0]
  if (!earliest) throw new Error('会话缺少物理邮件')
  return earliest.internet_message_id && counts.get(earliest.internet_message_id) === 1
    ? earliest.internet_message_id
    : `message:${earliest.id}`
}

async function readInternetMessageIdCounts(database: D1Database, internetIds: string[]) {
  const result = new Map<string, number>()
  for (const chunk of chunks(internetIds, PARAMETER_CHUNK_SIZE)) {
    if (chunk.length === 0) continue
    const rows = await database
      .prepare(
        `SELECT internet_message_id, COUNT(*) AS message_count
         FROM messages
         WHERE internet_message_id IN (${placeholders(chunk.length)})
         GROUP BY internet_message_id`,
      )
      .bind(...chunk)
      .all<{ internet_message_id: string; message_count: number }>()
    rows.results.forEach((row) => result.set(row.internet_message_id, row.message_count))
  }
  return result
}

function createConversationTaskStatement(
  database: D1Database,
  options: {
    taskId: string
    messageId: string
    inputVersion: number
    taskKeyDigest: Uint8Array
    now: number
  },
) {
  return database
    .prepare(
      `INSERT OR IGNORE INTO background_tasks (
         id, task_type, target_type, target_reference, input_version,
         task_key_digest, task_status, priority, attempt_count, max_attempts,
         next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
         last_error_code, last_error_summary, last_error_at, completed_at,
         created_at, updated_at
       ) VALUES (
         ?1, 'rebuild_conversation', 'message_conversation', ?2, ?3,
         ?4, 'pending', 5, 0, ?5, ?6, NULL, 0, NULL,
         NULL, NULL, NULL, NULL, ?6, ?6
       )`,
    )
    .bind(
      options.taskId,
      options.messageId,
      options.inputVersion,
      options.taskKeyDigest,
      REBUILD_TASK_MAX_ATTEMPTS,
      options.now,
    )
}

async function conversationTaskDigest(messageId: string, inputVersion: number) {
  return sha256Bytes(`rebuild_conversation\n${messageId}\n${inputVersion}`)
}

function placeholders(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => `?${offset + index + 1}`).join(', ')
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function uniqueRelations(relations: RelationRow[]) {
  const unique = new Map<string, RelationRow>()
  for (const relation of relations) {
    unique.set(
      `${relation.child_message_id}\n${relation.target_reference}\n${relation.target_message_id ?? ''}`,
      relation,
    )
  }
  return [...unique.values()]
}
