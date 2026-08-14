import {
  createDeletionOperationGuardedAuditEventStatement,
  type AuditContext,
} from '../../audit/public'
import { sha256Bytes } from '../../mail-receiving/domain/content-digest'
import type { MailObjectStore } from '../../mail-receiving/infrastructure/object-storage'
import type { StorageMode } from '../../../shared/contracts/storage-mode'
import { logicalStorageAdjustmentStatement } from '../../storage-quotas/public'
import { MailboxAccessError } from './mailbox-reading'

const DELETION_POLICY_VERSION = 1
const EXPIRY_BATCH_SIZE = 90

interface DeletionTargetRow {
  entry_id: string
  message_id: string
  mailbox_type: 'user' | 'organization'
  user_id: string | null
  organization_id: string | null
  creator_user_id: string | null
  location_override: string | null
  trash_due_at: number | null
  current_member_count: number
  remaining_entry_count: number
  remaining_owner_entry_count: number
  object_count: number
  object_size_bytes: number
  raw_size_bytes: number
  storage_mode: StorageMode
}

interface DeletionOperationRow {
  id: string
  operation_kind: string
  target_reference: string
  policy_version: number
  operation_status: string
}

interface DeletionObjectRow {
  id: string
  storage_mode: string
  object_key: string
  object_status: string
}

interface ExpiredTrashRow {
  mailbox_entry_id: string
  user_id: string
  mailbox_type: 'user' | 'organization'
}

interface LifecycleMailboxEntryRow {
  entry_id: string
  message_id: string
  mailbox_type: 'user' | 'organization'
  user_id: string | null
  organization_id: string | null
  raw_size_bytes: number
  storage_mode: StorageMode
  remaining_entry_count: number
  remaining_owner_entry_count: number
  object_count: number
  object_size_bytes: number
}

export interface PermanentMailboxDeletionResult {
  entryId: string
  deletionOperationId: string
  deletionScope: 'personal' | 'organization'
  affectedMemberCount: number
  physicalCleanupScheduled: boolean
}

export async function permanentlyDeleteMailboxEntry(options: {
  database: D1Database
  actorUserId: string
  entryId: string
  audit: AuditContext
  now?: number
}): Promise<PermanentMailboxDeletionResult> {
  return requestPermanentMailboxEntryDeletion({
    ...options,
    actorType: 'user',
    automaticExpiry: false,
  })
}

export async function processExpiredMailboxTrash(options: {
  database: D1Database
  now?: number
  limit?: number
}): Promise<number> {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? EXPIRY_BATCH_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > EXPIRY_BATCH_SIZE) {
    throw new Error('单次垃圾箱到期处理数量必须在 1 至 90 之间')
  }

  const due = await options.database
    .prepare(
      `SELECT state.mailbox_entry_id, state.user_id, entry.mailbox_type
       FROM mailbox_user_states AS state
       JOIN mailbox_entries AS entry ON entry.id = state.mailbox_entry_id
       WHERE state.location_override = 'trash'
         AND state.trash_due_at IS NOT NULL
         AND state.trash_due_at <= ?1
       ORDER BY state.trash_due_at, state.mailbox_entry_id, state.user_id
       LIMIT ?2`,
    )
    .bind(now, limit)
    .all<ExpiredTrashRow>()

  let processed = 0
  for (const row of due.results) {
    if (row.mailbox_type === 'organization') {
      const result = await options.database
        .prepare(
          `UPDATE mailbox_user_states
           SET location_override = 'hidden', hidden_at = ?1, updated_at = ?1
           WHERE mailbox_entry_id = ?2 AND user_id = ?3
             AND location_override = 'trash'
             AND trash_due_at IS NOT NULL AND trash_due_at <= ?1`,
        )
        .bind(now, row.mailbox_entry_id, row.user_id)
        .run()
      processed += result.meta.changes
      continue
    }

    try {
      await requestPermanentMailboxEntryDeletion({
        database: options.database,
        actorUserId: row.user_id,
        entryId: row.mailbox_entry_id,
        actorType: 'system',
        automaticExpiry: true,
        audit: {
          requestTraceId: `scheduled-trash-expiry:${crypto.randomUUID()}`,
          sourceIp: null,
          browserFamily: null,
        },
        now,
      })
      processed += 1
    } catch (error) {
      if (
        error instanceof MailboxAccessError &&
        (error.code === 'not_found' || error.code === 'invalid_transition')
      ) {
        continue
      }
      throw error
    }
  }
  return processed
}

export async function removeMailboxEntryForLifecycle(options: {
  database: D1Database
  entryId: string
  ownerType: 'user' | 'organization'
  ownerId: string
  requestedByUserId: string
  parentDeletionOperationId: string
  now?: number
}): Promise<{ removed: boolean; physicalCleanupScheduled: boolean }> {
  const now = options.now ?? Date.now()
  const ownerColumn = options.ownerType === 'user' ? 'user_id' : 'organization_id'
  const target = await options.database
    .prepare(
      `SELECT entry.id AS entry_id, entry.message_id, entry.mailbox_type,
              entry.user_id, entry.organization_id, message.raw_size_bytes,
              system.storage_mode,
              (SELECT COUNT(*) FROM mailbox_entries
               WHERE message_id = entry.message_id) AS remaining_entry_count,
              (SELECT COUNT(*) FROM mailbox_entries AS owner_entry
               WHERE owner_entry.message_id = entry.message_id
                 AND owner_entry.mailbox_type = entry.mailbox_type
                 AND owner_entry.${ownerColumn} = ?2) AS remaining_owner_entry_count,
              (SELECT COUNT(*) FROM object_registry
               WHERE message_id = entry.message_id) AS object_count,
              COALESCE((SELECT SUM(expected_size_bytes) FROM object_registry
               WHERE message_id = entry.message_id), 0) AS object_size_bytes
       FROM mailbox_entries AS entry
       JOIN messages AS message ON message.id = entry.message_id
       JOIN system_instances AS system ON system.singleton_id = 1
       WHERE entry.id = ?1 AND entry.mailbox_type = ?3
         AND entry.${ownerColumn} = ?2
       LIMIT 1`,
    )
    .bind(options.entryId, options.ownerId, options.ownerType)
    .first<LifecycleMailboxEntryRow>()
  if (!target) return { removed: false, physicalCleanupScheduled: false }

  const physicalCleanupScheduled = target.remaining_entry_count === 1
  const statements: D1PreparedStatement[] = []
  if (physicalCleanupScheduled) {
    const operationId = crypto.randomUUID()
    const taskId = crypto.randomUUID()
    const operationKind =
      options.ownerType === 'organization' ? 'organization_mail_delete' : 'mailbox_entry_delete'
    const taskDigest = await sha256Bytes(
      `mailbox_delete\n${operationId}\n${DELETION_POLICY_VERSION}`,
    )
    statements.push(
      options.database
        .prepare(
          `INSERT INTO deletion_operations (
            id, operation_kind, target_type, target_reference,
            requested_by_user_id, policy_version, is_recoverable,
            requested_at, recovery_due_at, impact_mailbox_entry_count,
            impact_message_count, impact_object_count, impact_size_bytes,
            operation_status, created_at, updated_at
           ) VALUES (?1, ?2, 'message', ?3, ?4, ?5, 0,
             ?6, NULL, 1, 1, ?7, ?8, 'ready', ?6, ?6)`,
        )
        .bind(
          operationId,
          operationKind,
          target.message_id,
          options.requestedByUserId,
          DELETION_POLICY_VERSION,
          now,
          target.object_count,
          target.object_size_bytes,
        ),
    )
    for (const [stepKey, sequence, stepKind, status] of deletionStepDefinitions()) {
      statements.push(
        options.database
          .prepare(
            `INSERT INTO deletion_operation_steps (
              id, deletion_operation_id, step_key, sequence_number,
              step_kind, is_required, step_status, attempt_count,
              next_attempt_at, started_at, completed_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 0,
               NULL, ?7, ?7, ?8, ?8)`,
          )
          .bind(
            crypto.randomUUID(),
            operationId,
            stepKey,
            sequence,
            stepKind,
            status,
            status === 'succeeded' ? now : null,
            now,
          ),
      )
    }
    statements.push(
      options.database
        .prepare(
          `INSERT INTO background_tasks (
            id, task_type, target_type, target_reference, input_version,
            task_key_digest, task_status, priority, attempt_count,
            max_attempts, next_attempt_at, lease_owner_reference,
            lease_token, lease_expires_at, created_at, updated_at
           ) VALUES (?1, 'mailbox_delete', 'deletion_operation', ?2, ?3,
             ?4, 'pending', 4, 0, 10, ?5, NULL, 0, NULL, ?5, ?5)`,
        )
        .bind(taskId, operationId, DELETION_POLICY_VERSION, taskDigest, now),
      options.database
        .prepare(
          `INSERT INTO lifecycle_cleanup_children (
            parent_deletion_operation_id, child_deletion_operation_id,
            child_target_type, child_target_reference, created_at
           ) VALUES (?1, ?2, 'message', ?3, ?4)`,
        )
        .bind(options.parentDeletionOperationId, operationId, target.message_id, now),
    )
  }

  const deleteResultIndex = statements.length
  statements.push(
    options.database
      .prepare(
        `DELETE FROM mailbox_entries
         WHERE id = ?1 AND message_id = ?2 AND mailbox_type = ?3
           AND ${ownerColumn} = ?4`,
      )
      .bind(target.entry_id, target.message_id, options.ownerType, options.ownerId),
  )

  if (target.remaining_owner_entry_count === 1) {
    const quotaRelease = await logicalStorageAdjustmentStatement({
      database: options.database,
      storageMode: target.storage_mode,
      owner: { ownerType: options.ownerType, ownerId: options.ownerId },
      entryKind: 'deletion',
      ownerReference: `message:${target.message_id}`,
      bytesDelta: -target.raw_size_bytes,
      idempotencyKey: `lifecycle-mailbox-delete:${target.entry_id}`,
      now,
    })
    if (quotaRelease) statements.push(quotaRelease)
  }

  const results = await options.database.batch(statements)
  if ((results[deleteResultIndex]?.meta.changes ?? 0) !== 1) {
    throw new Error('生命周期邮箱条目已经发生变化')
  }
  return { removed: true, physicalCleanupScheduled }
}

export async function processMailboxDeletionTask(options: {
  database: D1Database
  objectStore: MailObjectStore
  deletionOperationId: string
  inputVersion: number
  now?: number
}): Promise<{ status: 'succeeded' } | { status: 'needs_attention'; errorCode: string }> {
  const now = options.now ?? Date.now()
  const operation = await readDeletionOperation(options.database, options.deletionOperationId)
  if (
    !operation ||
    operation.policy_version !== options.inputVersion ||
    operation.target_reference.length === 0 ||
    !['mailbox_entry_delete', 'organization_mail_delete'].includes(operation.operation_kind)
  ) {
    return { status: 'needs_attention', errorCode: 'mailbox_deletion_state_mismatch' }
  }
  if (operation.operation_status === 'completed') return { status: 'succeeded' }
  if (!['ready', 'running'].includes(operation.operation_status)) {
    return { status: 'needs_attention', errorCode: 'mailbox_deletion_state_mismatch' }
  }

  await options.database
    .prepare(
      `UPDATE deletion_operations
       SET operation_status = 'running', updated_at = ?1
       WHERE id = ?2 AND operation_status = 'ready'`,
    )
    .bind(now, operation.id)
    .run()

  const messageId = operation.target_reference
  const remainingEntries = await countRows(
    options.database,
    'SELECT COUNT(*) AS count FROM mailbox_entries WHERE message_id = ?1',
    messageId,
  )
  if (remainingEntries > 0) {
    await completeDeletionOperation(options.database, operation.id, false, now)
    return { status: 'succeeded' }
  }

  const messageExists = await countRows(
    options.database,
    'SELECT COUNT(*) AS count FROM messages WHERE id = ?1',
    messageId,
  )
  if (messageExists !== 1) {
    await markDeletionNeedsAttention(
      options.database,
      operation.id,
      'mailbox_deletion_message_missing',
      now,
    )
    return { status: 'needs_attention', errorCode: 'mailbox_deletion_message_missing' }
  }

  await options.database.batch([
    options.database
      .prepare(
        `UPDATE message_integrity_states
         SET integrity_status = 'pending_delete', hidden_since = COALESCE(hidden_since, ?1),
             damage_code = NULL, damage_summary = NULL, updated_at = ?1
         WHERE message_id = ?2 AND integrity_status <> 'pending_delete'
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?2)`,
      )
      .bind(now, messageId),
    options.database
      .prepare(
        `UPDATE object_registry
         SET object_status = 'pending_delete', is_current = 0,
             delete_after = COALESCE(delete_after, ?1), updated_at = ?1
         WHERE message_id = ?2 AND object_status NOT IN ('pending_delete', 'deleted')
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?2)`,
      )
      .bind(now, messageId),
  ])

  const objects = await options.database
    .prepare(
      `SELECT id, storage_mode, object_key, object_status
       FROM object_registry
       WHERE message_id = ?1
       ORDER BY sequence_number, id`,
    )
    .bind(messageId)
    .all<DeletionObjectRow>()

  if (objects.results.some((object) => object.storage_mode !== options.objectStore.mode)) {
    await markDeletionNeedsAttention(
      options.database,
      operation.id,
      'mailbox_deletion_storage_mode_mismatch',
      now,
    )
    return { status: 'needs_attention', errorCode: 'mailbox_deletion_storage_mode_mismatch' }
  }

  for (const object of objects.results) {
    if (object.object_status === 'deleted') continue
    if (object.object_status !== 'pending_delete') {
      throw new Error('邮件对象尚未进入待删除状态')
    }
    await options.objectStore.delete(object.object_key)
    if (await options.objectStore.get(object.object_key)) {
      throw new Error('邮件对象删除尚未在对象存储中生效')
    }
    const result = await options.database
      .prepare(
        `UPDATE object_registry
         SET object_status = 'deleted', deleted_at = ?1, updated_at = ?1
         WHERE id = ?2 AND message_id = ?3 AND object_status = 'pending_delete'`,
      )
      .bind(now, object.id, messageId)
      .run()
    if (result.meta.changes !== 1) throw new Error('邮件对象删除状态已经发生变化')
  }

  await removePhysicalMessage(options.database, operation.id, messageId, now)
  return { status: 'succeeded' }
}

async function requestPermanentMailboxEntryDeletion(options: {
  database: D1Database
  actorUserId: string
  entryId: string
  actorType: 'user' | 'system'
  automaticExpiry: boolean
  audit: AuditContext
  now?: number
}): Promise<PermanentMailboxDeletionResult> {
  const now = options.now ?? Date.now()
  const target = await readDeletionTarget(options.database, options.actorUserId, options.entryId)
  if (!target) throw new MailboxAccessError('not_found', '邮件不存在或无权访问')
  if (target.mailbox_type === 'organization' && target.creator_user_id !== options.actorUserId) {
    throw new MailboxAccessError('permission_denied', '只有组织创建者可以永久删除组织邮件')
  }
  if (target.location_override !== 'trash') {
    throw new MailboxAccessError('invalid_transition', '请先将邮件移入垃圾箱')
  }
  if (
    options.automaticExpiry
      ? target.trash_due_at === null || target.trash_due_at > now
      : target.trash_due_at !== null && target.trash_due_at <= now
  ) {
    throw new MailboxAccessError(
      options.automaticExpiry ? 'invalid_transition' : 'not_found',
      options.automaticExpiry ? '邮件尚未到达自动清理时间' : '邮件已经到达自动清理时间',
    )
  }

  const existingOperation = await options.database
    .prepare(
      `SELECT 1 FROM deletion_operations
       WHERE target_type = 'message' AND target_reference = ?1
         AND operation_status NOT IN ('completed', 'cancelled')
       LIMIT 1`,
    )
    .bind(target.message_id)
    .first()
  if (existingOperation) {
    throw new MailboxAccessError('invalid_transition', '这封邮件正在执行永久删除，请稍后再试')
  }

  const operationId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  const deletionScope = target.mailbox_type === 'organization' ? 'organization' : 'personal'
  const operationKind =
    deletionScope === 'organization' ? 'organization_mail_delete' : 'mailbox_entry_delete'
  const physicalCleanupScheduled = target.remaining_entry_count === 1
  const taskDigest = await sha256Bytes(`mailbox_delete\n${operationId}\n${DELETION_POLICY_VERSION}`)
  const expiryPredicate = options.automaticExpiry
    ? 'state.trash_due_at IS NOT NULL AND state.trash_due_at <= ?8'
    : '(state.trash_due_at IS NULL OR state.trash_due_at > ?8)'
  const authorizationPredicate =
    deletionScope === 'personal'
      ? `entry.mailbox_type = 'user' AND entry.user_id = ?4`
      : `entry.mailbox_type = 'organization'
         AND organization.creator_user_id = ?4
         AND organization.status = 'active'`

  const stepDefinitions = deletionStepDefinitions()

  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO deletion_operations (
          id, operation_kind, target_type, target_reference,
          requested_by_user_id, policy_version, is_recoverable,
          requested_at, recovery_due_at, impact_mailbox_entry_count,
          impact_message_count, impact_object_count, impact_size_bytes,
          operation_status, created_at, updated_at
         )
         SELECT ?1, ?2, 'message', entry.message_id,
                ?4, ?5, 0, ?8, NULL, 1, ?6, ?7, ?9,
                'ready', ?8, ?8
         FROM mailbox_entries AS entry
         JOIN mailbox_user_states AS state
           ON state.mailbox_entry_id = entry.id AND state.user_id = ?4
         LEFT JOIN organizations AS organization ON organization.id = entry.organization_id
         WHERE entry.id = ?3 AND entry.message_id = ?10
           AND state.location_override = 'trash'
           AND ${expiryPredicate}
           AND ${authorizationPredicate}`,
      )
      .bind(
        operationId,
        operationKind,
        target.entry_id,
        options.actorUserId,
        DELETION_POLICY_VERSION,
        physicalCleanupScheduled ? 1 : 0,
        physicalCleanupScheduled ? target.object_count : 0,
        now,
        physicalCleanupScheduled ? target.object_size_bytes : 0,
        target.message_id,
      ),
  ]

  for (const [stepKey, sequence, stepKind, status] of stepDefinitions) {
    statements.push(
      options.database
        .prepare(
          `INSERT INTO deletion_operation_steps (
            id, deletion_operation_id, step_key, sequence_number,
            step_kind, is_required, step_status, attempt_count,
            next_attempt_at, started_at, completed_at, created_at, updated_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, 1, ?6, 0,
                  NULL, ?7, ?7, ?8, ?8
           WHERE EXISTS (SELECT 1 FROM deletion_operations WHERE id = ?2)`,
        )
        .bind(
          crypto.randomUUID(),
          operationId,
          stepKey,
          sequence,
          stepKind,
          status,
          status === 'succeeded' ? now : null,
          now,
        ),
    )
  }

  statements.push(
    options.database
      .prepare(
        `DELETE FROM mailbox_entries
         WHERE id = ?1 AND message_id = ?2
           AND EXISTS (SELECT 1 FROM deletion_operations WHERE id = ?3)`,
      )
      .bind(target.entry_id, target.message_id, operationId),
    options.database
      .prepare(
        `INSERT INTO background_tasks (
          id, task_type, target_type, target_reference, input_version,
          task_key_digest, task_status, priority, attempt_count,
          max_attempts, next_attempt_at, lease_owner_reference,
          lease_token, lease_expires_at, created_at, updated_at
         )
         SELECT ?1, 'mailbox_delete', 'deletion_operation', ?2, ?3,
                ?4, 'pending', 4, 0, 10, ?5, NULL, 0, NULL, ?5, ?5
         WHERE EXISTS (SELECT 1 FROM deletion_operations WHERE id = ?2)`,
      )
      .bind(taskId, operationId, DELETION_POLICY_VERSION, taskDigest, now),
    createDeletionOperationGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: options.actorType,
        actorUserId: options.actorType === 'user' ? options.actorUserId : null,
        actionName: 'mailbox_entry.permanently_deleted',
        targetType: 'mailbox_entry',
        targetReference: target.entry_id,
        outcome: 'succeeded',
        reasonCode:
          options.actorType === 'system'
            ? 'trash_retention_expired'
            : deletionScope === 'organization'
              ? 'organization_creator_confirmed'
              : 'user_confirmed',
        occurredAt: now,
      },
      { deletionOperationId: operationId },
    ),
  )
  if (target.remaining_owner_entry_count === 1) {
    const quotaRelease = await logicalStorageAdjustmentStatement({
      database: options.database,
      storageMode: target.storage_mode,
      owner:
        target.mailbox_type === 'user'
          ? { ownerType: 'user', ownerId: target.user_id! }
          : { ownerType: 'organization', ownerId: target.organization_id! },
      entryKind: 'deletion',
      ownerReference: `message:${target.message_id}`,
      bytesDelta: -target.raw_size_bytes,
      idempotencyKey: `mailbox-delete:${target.entry_id}`,
      now,
    })
    if (quotaRelease) statements.push(quotaRelease)
  }

  try {
    const results = await options.database.batch(statements)
    const operationCreated = (results[0]?.meta.changes ?? 0) >= 1
    const entryDeleted = (results[stepDefinitions.length + 1]?.meta.changes ?? 0) >= 1
    const taskCreated = (results[stepDefinitions.length + 2]?.meta.changes ?? 0) >= 1
    const auditCreated = (results[stepDefinitions.length + 3]?.meta.changes ?? 0) >= 1
    if (!operationCreated || !entryDeleted || !taskCreated || !auditCreated) {
      throw new MailboxAccessError('invalid_transition', '邮件状态已经发生变化，请刷新后重试')
    }
  } catch (error) {
    if (error instanceof MailboxAccessError) throw error
    if (
      error instanceof Error &&
      /deletion_operations_active_target_unique|UNIQUE/iu.test(error.message)
    ) {
      throw new MailboxAccessError('invalid_transition', '这封邮件正在执行永久删除，请稍后再试')
    }
    throw error
  }

  return {
    entryId: target.entry_id,
    deletionOperationId: operationId,
    deletionScope,
    affectedMemberCount:
      deletionScope === 'organization' ? Math.max(1, target.current_member_count) : 1,
    physicalCleanupScheduled,
  }
}

function deletionStepDefinitions() {
  return [
    ['revoke_mailbox_access', 0, 'revoke_access', 'succeeded'],
    ['remove_database_relations', 1, 'database_relations', 'pending'],
    ['remove_objects', 2, 'objects', 'pending'],
    ['remove_search_data', 3, 'search', 'pending'],
    ['remove_cache_data', 4, 'cache', 'pending'],
    ['reconcile_deletion', 5, 'reconcile', 'pending'],
  ] as const
}

async function readDeletionTarget(
  database: D1Database,
  actorUserId: string,
  entryId: string,
): Promise<DeletionTargetRow | null> {
  return database
    .prepare(
      `SELECT
         entry.id AS entry_id, entry.message_id, entry.mailbox_type,
         entry.user_id, entry.organization_id,
         message.raw_size_bytes, system.storage_mode,
         organization.creator_user_id,
         state.location_override, state.trash_due_at,
         CASE WHEN entry.organization_id IS NULL THEN 1 ELSE (
           SELECT COUNT(*) FROM organization_memberships AS member_count
           WHERE member_count.organization_id = entry.organization_id
             AND member_count.left_at IS NULL
         ) END AS current_member_count,
          (SELECT COUNT(*) FROM mailbox_entries WHERE message_id = entry.message_id)
            AS remaining_entry_count,
          (SELECT COUNT(*) FROM mailbox_entries AS owner_entry
           WHERE owner_entry.message_id = entry.message_id
             AND owner_entry.mailbox_type = entry.mailbox_type
             AND (
               (entry.mailbox_type = 'user' AND owner_entry.user_id = entry.user_id)
               OR (
                 entry.mailbox_type = 'organization'
                 AND owner_entry.organization_id = entry.organization_id
               )
             )) AS remaining_owner_entry_count,
          (SELECT COUNT(*) FROM object_registry WHERE message_id = entry.message_id)
           AS object_count,
         COALESCE((
           SELECT SUM(expected_size_bytes) FROM object_registry
           WHERE message_id = entry.message_id
         ), 0) AS object_size_bytes
       FROM mailbox_entries AS entry
       JOIN messages AS message ON message.id = entry.message_id
       JOIN system_instances AS system ON system.singleton_id = 1
       LEFT JOIN organizations AS organization ON organization.id = entry.organization_id
       LEFT JOIN organization_memberships AS membership
         ON membership.organization_id = entry.organization_id
        AND membership.user_id = ?1 AND membership.left_at IS NULL
       LEFT JOIN mailbox_user_states AS state
         ON state.mailbox_entry_id = entry.id AND state.user_id = ?1
       WHERE entry.id = ?2
         AND (
           (entry.mailbox_type = 'user' AND entry.user_id = ?1)
           OR (
             entry.mailbox_type = 'organization'
             AND membership.id IS NOT NULL
             AND organization.status = 'active'
           )
         )
       LIMIT 1`,
    )
    .bind(actorUserId, entryId)
    .first<DeletionTargetRow>()
}

async function readDeletionOperation(
  database: D1Database,
  operationId: string,
): Promise<DeletionOperationRow | null> {
  return database
    .prepare(
      `SELECT id, operation_kind, target_reference, policy_version, operation_status
       FROM deletion_operations
       WHERE id = ?1 AND target_type = 'message'
       LIMIT 1`,
    )
    .bind(operationId)
    .first<DeletionOperationRow>()
}

async function completeDeletionOperation(
  database: D1Database,
  operationId: string,
  physicalMessageRemoved: boolean,
  now: number,
): Promise<void> {
  const objectStatus = physicalMessageRemoved ? 'succeeded' : 'skipped'
  const statements = [
    stepCompletionStatement(database, operationId, 'remove_database_relations', 'succeeded', now),
    stepCompletionStatement(database, operationId, 'remove_objects', objectStatus, now),
    stepCompletionStatement(database, operationId, 'remove_search_data', 'skipped', now),
    stepCompletionStatement(database, operationId, 'remove_cache_data', 'skipped', now),
    stepCompletionStatement(database, operationId, 'reconcile_deletion', 'succeeded', now),
    database
      .prepare(
        `UPDATE deletion_operations
         SET operation_status = 'completed', completed_at = ?1, updated_at = ?1
         WHERE id = ?2 AND operation_status IN ('ready', 'running')`,
      )
      .bind(now, operationId),
  ]
  const results = await database.batch(statements)
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('邮件删除操作完成状态已经发生变化')
  }
}

async function removePhysicalMessage(
  database: D1Database,
  operationId: string,
  messageId: string,
  now: number,
): Promise<void> {
  const statements = [
    database
      .prepare(
        `DELETE FROM background_tasks
         WHERE task_type = 'index_message' AND target_type = 'message_search'
           AND target_reference = ?1
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)`,
      )
      .bind(messageId),
    database
      .prepare(
        `DELETE FROM message_search_index
         WHERE rowid IN (
           SELECT id FROM message_search_chunks WHERE message_id = ?1
         )
         AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)`,
      )
      .bind(messageId),
    database
      .prepare(
        `DELETE FROM message_search_chunks
         WHERE message_id = ?1
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)`,
      )
      .bind(messageId),
    database
      .prepare(
        `DELETE FROM message_search_states
         WHERE message_id = ?1
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)`,
      )
      .bind(messageId),
    database
      .prepare(
        `DELETE FROM message_deduplication_keys
         WHERE message_id = ?1
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)`,
      )
      .bind(messageId),
    database
      .prepare(
        `DELETE FROM receive_operation_routes
         WHERE receive_operation_id IN (
           SELECT id FROM receive_operations WHERE message_id = ?1
         ) AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)`,
      )
      .bind(messageId),
    database
      .prepare(
        `DELETE FROM receive_operations
         WHERE message_id = ?1
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)`,
      )
      .bind(messageId),
    database
      .prepare(
        `DELETE FROM message_deliveries
         WHERE message_id = ?1
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)`,
      )
      .bind(messageId),
    database
      .prepare(
        `DELETE FROM object_registry
         WHERE message_id = ?1
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)
           AND NOT EXISTS (
             SELECT 1 FROM object_registry AS pending
             WHERE pending.message_id = ?1 AND pending.object_status <> 'deleted'
           )`,
      )
      .bind(messageId),
    database
      .prepare(
        `DELETE FROM message_integrity_states
         WHERE message_id = ?1
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM object_registry WHERE message_id = ?1)`,
      )
      .bind(messageId),
    database
      .prepare(
        `DELETE FROM messages
         WHERE id = ?1
           AND NOT EXISTS (SELECT 1 FROM mailbox_entries WHERE message_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM object_registry WHERE message_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM message_integrity_states WHERE message_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM message_deliveries WHERE message_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM receive_operations WHERE message_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM message_deduplication_keys WHERE message_id = ?1)`,
      )
      .bind(messageId),
    stepCompletionStatement(database, operationId, 'remove_database_relations', 'succeeded', now),
    stepCompletionStatement(database, operationId, 'remove_objects', 'succeeded', now),
    stepCompletionStatement(database, operationId, 'remove_search_data', 'succeeded', now),
    stepCompletionStatement(database, operationId, 'remove_cache_data', 'skipped', now),
    stepCompletionStatement(database, operationId, 'reconcile_deletion', 'succeeded', now),
    database
      .prepare(
        `UPDATE deletion_operations
         SET operation_status = 'completed', completed_at = ?1, updated_at = ?1
         WHERE id = ?2 AND operation_status IN ('ready', 'running')
           AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ?3)`,
      )
      .bind(now, operationId, messageId),
  ]
  const results = await database.batch(statements)
  const messageDeleteResult = results[10]
  const operationResult = results.at(-1)
  if ((messageDeleteResult?.meta.changes ?? 0) < 1 || (operationResult?.meta.changes ?? 0) < 1) {
    throw new Error('物理邮件清理对账未通过')
  }
}

function stepCompletionStatement(
  database: D1Database,
  operationId: string,
  stepKey: string,
  status: 'succeeded' | 'skipped',
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE deletion_operation_steps
       SET step_status = ?1, attempt_count = attempt_count + 1,
           next_attempt_at = NULL, started_at = COALESCE(started_at, ?2),
           completed_at = ?2, updated_at = ?2
       WHERE deletion_operation_id = ?3 AND step_key = ?4
         AND step_status IN ('pending', 'running', 'retry_wait', 'needs_attention')`,
    )
    .bind(status, now, operationId, stepKey)
}

async function markDeletionNeedsAttention(
  database: D1Database,
  operationId: string,
  errorCode: string,
  now: number,
): Promise<void> {
  await database
    .prepare(
      `UPDATE deletion_operations
       SET operation_status = 'needs_attention', last_error_code = ?1,
           last_error_summary = '邮件永久删除状态需要管理员检查', updated_at = ?2
       WHERE id = ?3 AND operation_status IN ('ready', 'running')`,
    )
    .bind(errorCode, now, operationId)
    .run()
}

async function countRows(database: D1Database, sql: string, reference: string): Promise<number> {
  const row = await database.prepare(sql).bind(reference).first<{ count: number }>()
  return row?.count ?? 0
}
