import { sql } from 'drizzle-orm'
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { users } from '../../identity/infrastructure/schema'

export const deletionOperations = sqliteTable(
  'deletion_operations',
  {
    id: text('id').primaryKey().notNull(),
    operationKind: text('operation_kind').notNull(),
    targetType: text('target_type').notNull(),
    targetReference: text('target_reference').notNull(),
    requestedByUserId: text('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    policyVersion: integer('policy_version').notNull(),
    isRecoverable: integer('is_recoverable', { mode: 'boolean' }).notNull(),
    requestedAt: integer('requested_at').notNull(),
    recoveryDueAt: integer('recovery_due_at'),
    impactMailboxEntryCount: integer('impact_mailbox_entry_count').notNull().default(0),
    impactMessageCount: integer('impact_message_count').notNull().default(0),
    impactObjectCount: integer('impact_object_count').notNull().default(0),
    impactSizeBytes: integer('impact_size_bytes').notNull().default(0),
    operationStatus: text('operation_status').notNull(),
    lastErrorCode: text('last_error_code'),
    lastErrorSummary: text('last_error_summary'),
    completedAt: integer('completed_at'),
    cancelledAt: integer('cancelled_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('deletion_operations_active_target_unique')
      .on(table.targetType, table.targetReference)
      .where(sql`${table.operationStatus} not in ('completed', 'cancelled')`),
    index('deletion_operations_due_index').on(table.operationStatus, table.recoveryDueAt, table.id),
    check('deletion_operations_policy_version_check', sql`${table.policyVersion} >= 1`),
    check('deletion_operations_updated_at_check', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
)

export const deletionOperationBlockers = sqliteTable(
  'deletion_operation_blockers',
  {
    id: text('id').primaryKey().notNull(),
    deletionOperationId: text('deletion_operation_id')
      .notNull()
      .references(() => deletionOperations.id, { onDelete: 'cascade' }),
    blockerKey: text('blocker_key').notNull(),
    blockerType: text('blocker_type').notNull(),
    blockerReference: text('blocker_reference'),
    blockerStatus: text('blocker_status').notNull(),
    resolutionCode: text('resolution_code'),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (table) => [
    unique('deletion_operation_blockers_operation_key_unique').on(
      table.deletionOperationId,
      table.blockerKey,
    ),
    index('deletion_operation_blockers_open_index').on(
      table.deletionOperationId,
      table.blockerStatus,
      table.id,
    ),
  ],
)

export const deletionOperationSteps = sqliteTable(
  'deletion_operation_steps',
  {
    id: text('id').primaryKey().notNull(),
    deletionOperationId: text('deletion_operation_id')
      .notNull()
      .references(() => deletionOperations.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    stepKind: text('step_kind').notNull(),
    isRequired: integer('is_required', { mode: 'boolean' }).notNull().default(true),
    stepStatus: text('step_status').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    lastErrorCode: text('last_error_code'),
    lastErrorSummary: text('last_error_summary'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('deletion_operation_steps_operation_key_unique').on(
      table.deletionOperationId,
      table.stepKey,
    ),
    unique('deletion_operation_steps_operation_sequence_unique').on(
      table.deletionOperationId,
      table.sequenceNumber,
    ),
    index('deletion_operation_steps_work_index').on(
      table.stepStatus,
      table.nextAttemptAt,
      table.deletionOperationId,
      table.sequenceNumber,
    ),
  ],
)

export const backgroundTasks = sqliteTable(
  'background_tasks',
  {
    id: text('id').primaryKey().notNull(),
    taskType: text('task_type').notNull(),
    targetType: text('target_type').notNull(),
    targetReference: text('target_reference').notNull(),
    inputVersion: integer('input_version').notNull(),
    taskKeyDigest: blob('task_key_digest', { mode: 'buffer' }).notNull(),
    taskStatus: text('task_status').notNull(),
    priority: integer('priority').notNull().default(5),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    nextAttemptAt: integer('next_attempt_at'),
    leaseOwnerReference: text('lease_owner_reference'),
    leaseToken: integer('lease_token').notNull().default(0),
    leaseExpiresAt: integer('lease_expires_at'),
    lastErrorCode: text('last_error_code'),
    lastErrorSummary: text('last_error_summary'),
    lastErrorAt: integer('last_error_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('background_tasks_due_index').on(
      table.taskStatus,
      table.nextAttemptAt,
      table.priority,
      table.id,
    ),
    index('background_tasks_lease_index')
      .on(table.taskStatus, table.leaseExpiresAt, table.id)
      .where(sql`${table.taskStatus} = 'running'`),
    index('background_tasks_target_index').on(
      table.targetType,
      table.targetReference,
      table.taskType,
      table.inputVersion,
    ),
  ],
)

export const backgroundTaskAttempts = sqliteTable(
  'background_task_attempts',
  {
    id: text('id').primaryKey().notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => backgroundTasks.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    leaseToken: integer('lease_token').notNull(),
    workerReference: text('worker_reference').notNull(),
    attemptStatus: text('attempt_status').notNull(),
    retryable: integer('retryable', { mode: 'boolean' }),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('background_task_attempts_task_attempt_unique').on(table.taskId, table.attemptNumber),
    unique('background_task_attempts_task_lease_unique').on(table.taskId, table.leaseToken),
    index('background_task_attempts_task_index').on(table.taskId, table.attemptNumber),
  ],
)
