import type { BackgroundTaskMessage } from '../../../shared/contracts/background-task'

const TASK_BATCH_SIZE = 90
const LEASE_DURATION_MS = 5 * 60 * 1000

interface BackgroundTaskRow {
  id: string
  task_type: string
  target_type: string
  target_reference: string
  input_version: number
  task_status: string
  attempt_count: number
  max_attempts: number
  next_attempt_at: number | null
  lease_owner_reference: string | null
  lease_token: number
  lease_expires_at: number | null
}

interface AliasReleaseRow {
  operation_status: string
  policy_version: number
  address_id: string
  retired_at: number | null
  claim_status: string | null
  reserved_until: number | null
}

interface ClaimedTask {
  task: BackgroundTaskRow
  workerReference: string
  attemptNumber: number
  leaseToken: number
}

export interface BackgroundTaskExecutionContext {
  database: D1Database
  taskId: string
  taskType: string
  targetType: string
  targetReference: string
  inputVersion: number
  now: number
}

export type BackgroundTaskExecutionResult =
  | { status: 'succeeded' }
  | { status: 'retry'; nextAttemptAt: number; errorCode?: string }
  | { status: 'needs_attention'; errorCode: string }

export function isBackgroundTaskMessage(value: unknown): value is BackgroundTaskMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return (
    typeof message.taskId === 'string' &&
    isUuid(message.taskId) &&
    Number.isInteger(message.inputVersion) &&
    (message.inputVersion as number) >= 1
  )
}

export async function enqueueDueBackgroundTasks(options: {
  database: D1Database
  queue: Queue<BackgroundTaskMessage>
  now?: number
}): Promise<number> {
  const now = options.now ?? Date.now()
  const result = await options.database
    .prepare(
      `SELECT id, input_version
       FROM background_tasks
       WHERE (
           task_status IN ('pending', 'retry_wait')
           AND next_attempt_at IS NOT NULL
           AND next_attempt_at <= ?1
         ) OR (
           task_status = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?1
         )
       ORDER BY priority, COALESCE(next_attempt_at, lease_expires_at), id
       LIMIT ?2`,
    )
    .bind(now, TASK_BATCH_SIZE)
    .all<{ id: string; input_version: number }>()

  if (result.results.length === 0) return 0
  await options.queue.sendBatch(
    result.results.map((task) => ({
      body: { taskId: task.id, inputVersion: task.input_version },
    })),
  )
  return result.results.length
}

export async function processBackgroundTaskMessage(options: {
  database: D1Database
  message: BackgroundTaskMessage
  executeTask?: (context: BackgroundTaskExecutionContext) => Promise<BackgroundTaskExecutionResult>
  onRetryScheduled?: (nextAttemptAt: number) => void
  workerReference?: string
  now?: number
}): Promise<'completed' | 'ignored'> {
  const now = options.now ?? Date.now()
  const workerReference = options.workerReference ?? crypto.randomUUID()
  const task = await readTask(options.database, options.message.taskId)
  if (!task || task.input_version !== options.message.inputVersion) return 'ignored'
  if (task.task_status === 'succeeded' || task.task_status === 'cancelled') return 'ignored'
  if (task.task_status === 'needs_attention') return 'ignored'
  if (
    task.attempt_count >= task.max_attempts &&
    (task.task_status === 'pending' || task.task_status === 'retry_wait')
  ) {
    await finishExhaustedTaskWithAttention(options.database, task, now)
    return 'completed'
  }
  if (task.attempt_count >= task.max_attempts && task.task_status === 'running') {
    if (
      task.lease_expires_at !== null &&
      task.lease_expires_at <= now &&
      task.lease_owner_reference
    ) {
      await finishWithAttention(
        options.database,
        {
          task,
          workerReference: task.lease_owner_reference,
          attemptNumber: task.attempt_count,
          leaseToken: task.lease_token,
        },
        'maximum_attempts_reached',
        now,
      )
      return 'completed'
    }
    return 'ignored'
  }
  if (
    (task.task_status === 'pending' || task.task_status === 'retry_wait') &&
    (task.next_attempt_at === null || task.next_attempt_at > now)
  ) {
    return 'ignored'
  }
  if (
    task.task_status === 'running' &&
    (task.lease_expires_at === null || task.lease_expires_at > now)
  ) {
    return 'ignored'
  }

  const claimed = await claimTask(options.database, task, workerReference, now)
  try {
    if (claimed.task.task_type === 'alias_release') {
      await releaseReservedAlias(options.database, claimed, now)
      return 'completed'
    }
    if (!options.executeTask) {
      await finishWithAttention(options.database, claimed, 'unsupported_task_type', now)
      return 'completed'
    }

    const execution = await options.executeTask({
      database: options.database,
      taskId: claimed.task.id,
      taskType: claimed.task.task_type,
      targetType: claimed.task.target_type,
      targetReference: claimed.task.target_reference,
      inputVersion: claimed.task.input_version,
      now,
    })
    if (execution.status === 'needs_attention') {
      await finishWithAttention(options.database, claimed, execution.errorCode, now)
    } else if (execution.status === 'retry') {
      if (claimed.attemptNumber >= claimed.task.max_attempts) {
        await finishWithAttention(
          options.database,
          claimed,
          execution.errorCode ?? 'maximum_attempts_reached',
          now,
        )
      } else {
        await scheduleRetry(
          options.database,
          claimed,
          execution.nextAttemptAt,
          now,
          execution.errorCode ?? null,
        )
        options.onRetryScheduled?.(execution.nextAttemptAt)
      }
    } else {
      await finishSucceeded(options.database, claimed, now)
    }
  } catch {
    if (claimed.attemptNumber >= claimed.task.max_attempts) {
      await finishWithAttention(options.database, claimed, 'task_execution_failed', now)
    } else {
      const backoffMs = Math.min(60 * 60 * 1000, 2 ** claimed.attemptNumber * 60 * 1000)
      const nextAttemptAt = now + backoffMs
      await scheduleRetry(options.database, claimed, nextAttemptAt, now, 'task_execution_failed')
      options.onRetryScheduled?.(nextAttemptAt)
    }
  }
  return 'completed'
}

async function finishExhaustedTaskWithAttention(
  database: D1Database,
  task: BackgroundTaskRow,
  now: number,
): Promise<void> {
  const result = await database
    .prepare(
      `UPDATE background_tasks
       SET task_status = 'needs_attention', next_attempt_at = NULL,
           lease_owner_reference = NULL, lease_expires_at = NULL,
           last_error_code = COALESCE(last_error_code, 'maximum_attempts_reached'),
           last_error_summary = '后台任务已达到最大尝试次数，需要管理员检查',
           last_error_at = ?1, updated_at = ?1
       WHERE id = ?2 AND input_version = ?3
         AND task_status IN ('pending', 'retry_wait')
         AND attempt_count >= max_attempts`,
    )
    .bind(now, task.id, task.input_version)
    .run()
  if (result.meta.changes !== 1) throw new Error('后台任务最大尝试次数状态已经发生变化')
}

async function finishSucceeded(
  database: D1Database,
  claimed: ClaimedTask,
  now: number,
): Promise<void> {
  const results = await database.batch([
    finishAttemptStatement(database, claimed, 'succeeded', 0, null, now),
    finishTaskStatement(database, claimed, 'succeeded', null, null, now),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('后台任务完成状态已经发生变化')
  }
}

async function claimTask(
  database: D1Database,
  task: BackgroundTaskRow,
  workerReference: string,
  now: number,
): Promise<ClaimedTask> {
  const attemptNumber = task.attempt_count + 1
  const leaseToken = task.lease_token + 1
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE background_tasks
         SET task_status = 'running', attempt_count = ?1,
             next_attempt_at = NULL, lease_owner_reference = ?2,
             lease_token = ?3, lease_expires_at = ?4,
             last_error_code = NULL, last_error_summary = NULL,
             last_error_at = NULL, updated_at = ?5
         WHERE id = ?6 AND input_version = ?7
           AND task_status = ?8 AND attempt_count = ?9 AND lease_token = ?10
           AND (
             (task_status IN ('pending', 'retry_wait') AND next_attempt_at <= ?5)
             OR (task_status = 'running' AND lease_expires_at <= ?5)
           )`,
      )
      .bind(
        attemptNumber,
        workerReference,
        leaseToken,
        now + LEASE_DURATION_MS,
        now,
        task.id,
        task.input_version,
        task.task_status,
        task.attempt_count,
        task.lease_token,
      ),
  ]
  if (task.task_status === 'running') {
    statements.push(
      database
        .prepare(
          `UPDATE background_task_attempts
           SET attempt_status = 'abandoned', retryable = 1,
               error_code = 'lease_expired', error_summary = '任务租约已过期',
               finished_at = ?1
           WHERE task_id = ?2 AND attempt_number = ?3 AND lease_token = ?4
             AND attempt_status = 'running'`,
        )
        .bind(now, task.id, task.attempt_count, task.lease_token),
    )
  }
  statements.push(
    database
      .prepare(
        `INSERT INTO background_task_attempts (
          id, task_id, attempt_number, lease_token, worker_reference,
          attempt_status, retryable, error_code, error_summary,
          started_at, finished_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'running', NULL, NULL, NULL, ?6, NULL, ?6)`,
      )
      .bind(crypto.randomUUID(), task.id, attemptNumber, leaseToken, workerReference, now),
  )
  const results = await database.batch(statements)
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('后台任务领取状态已经发生变化')
  }
  return { task, workerReference, attemptNumber, leaseToken }
}

async function releaseReservedAlias(
  database: D1Database,
  claimed: ClaimedTask,
  now: number,
): Promise<void> {
  const release = await database
    .prepare(
      `SELECT
        deletion_operations.operation_status,
        deletion_operations.policy_version,
        deletion_operations.target_reference AS address_id,
        email_addresses.retired_at,
        address_claims.status AS claim_status,
        address_claims.reserved_until
       FROM deletion_operations
       JOIN email_addresses
         ON email_addresses.id = deletion_operations.target_reference
       LEFT JOIN address_claims
         ON address_claims.address_id = deletion_operations.target_reference
       WHERE deletion_operations.id = ?1
         AND deletion_operations.operation_kind = 'alias_release'
         AND deletion_operations.target_type = 'email_address'
       LIMIT 1`,
    )
    .bind(claimed.task.target_reference)
    .first<AliasReleaseRow>()

  if (
    !release ||
    release.policy_version !== claimed.task.input_version ||
    release.retired_at === null ||
    !['ready', 'running'].includes(release.operation_status)
  ) {
    await finishWithAttention(database, claimed, 'alias_release_state_mismatch', now)
    return
  }
  if (
    release.claim_status === 'active' ||
    (release.claim_status === 'reserved' && release.reserved_until === null)
  ) {
    await finishWithAttention(database, claimed, 'alias_claim_state_mismatch', now)
    return
  }
  if (
    release.claim_status === 'reserved' &&
    release.reserved_until !== null &&
    release.reserved_until > now
  ) {
    await scheduleRetry(database, claimed, release.reserved_until, now, null)
    return
  }

  const guardSql = `EXISTS (
    SELECT 1 FROM background_tasks
    WHERE id = ?1 AND task_status = 'running'
      AND attempt_count = ?2 AND lease_token = ?3
      AND lease_owner_reference = ?4
  )`
  const statements: D1PreparedStatement[] = []
  if (release.claim_status === 'reserved') {
    statements.push(
      database
        .prepare(
          `DELETE FROM address_claims
           WHERE address_id = ?5 AND status = 'reserved'
             AND reserved_until IS NOT NULL AND reserved_until <= ?6
             AND ${guardSql}`,
        )
        .bind(
          claimed.task.id,
          claimed.attemptNumber,
          claimed.leaseToken,
          claimed.workerReference,
          release.address_id,
          now,
        ),
    )
  }
  statements.push(
    database
      .prepare(
        `UPDATE deletion_operation_steps
         SET step_status = 'succeeded', attempt_count = attempt_count + 1,
             next_attempt_at = NULL, started_at = COALESCE(started_at, ?6),
             completed_at = ?6, updated_at = ?6
         WHERE deletion_operation_id = ?5 AND step_key = 'release_address_claim'
           AND step_status IN ('pending', 'retry_wait') AND ${guardSql}`,
      )
      .bind(
        claimed.task.id,
        claimed.attemptNumber,
        claimed.leaseToken,
        claimed.workerReference,
        claimed.task.target_reference,
        now,
      ),
    database
      .prepare(
        `UPDATE deletion_operation_steps
         SET step_status = 'succeeded', attempt_count = attempt_count + 1,
             next_attempt_at = NULL, started_at = COALESCE(started_at, ?6),
             completed_at = ?6, updated_at = ?6
         WHERE deletion_operation_id = ?5 AND step_key = 'reconcile_address_release'
           AND step_status IN ('pending', 'retry_wait') AND ${guardSql}`,
      )
      .bind(
        claimed.task.id,
        claimed.attemptNumber,
        claimed.leaseToken,
        claimed.workerReference,
        claimed.task.target_reference,
        now,
      ),
    database
      .prepare(
        `UPDATE deletion_operations
         SET operation_status = 'completed', completed_at = ?6, updated_at = ?6
         WHERE id = ?5 AND operation_status IN ('ready', 'running') AND ${guardSql}`,
      )
      .bind(
        claimed.task.id,
        claimed.attemptNumber,
        claimed.leaseToken,
        claimed.workerReference,
        claimed.task.target_reference,
        now,
      ),
    finishAttemptStatement(database, claimed, 'succeeded', 0, null, now),
    finishTaskStatement(database, claimed, 'succeeded', null, null, now),
  )

  const results = await database.batch(statements)
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('个人别名到期释放状态已经发生变化')
  }
}

async function scheduleRetry(
  database: D1Database,
  claimed: ClaimedTask,
  nextAttemptAt: number,
  now: number,
  errorCode: string | null,
): Promise<void> {
  const results = await database.batch([
    finishAttemptStatement(database, claimed, 'retry_scheduled', 1, errorCode, now),
    database
      .prepare(
        `UPDATE background_tasks
         SET task_status = 'retry_wait', next_attempt_at = ?1,
             lease_owner_reference = NULL, lease_expires_at = NULL,
             last_error_code = ?7, last_error_summary = ?8,
             last_error_at = ?9, updated_at = ?2
         WHERE id = ?3 AND task_status = 'running'
           AND attempt_count = ?4 AND lease_token = ?5 AND lease_owner_reference = ?6`,
      )
      .bind(
        nextAttemptAt,
        now,
        claimed.task.id,
        claimed.attemptNumber,
        claimed.leaseToken,
        claimed.workerReference,
        errorCode,
        errorCode === null ? null : '后台任务执行失败，已安排重试',
        errorCode === null ? null : now,
      ),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('后台任务重试状态已经发生变化')
  }
}

async function finishWithAttention(
  database: D1Database,
  claimed: ClaimedTask,
  errorCode: string,
  now: number,
): Promise<void> {
  const statements = [
    finishAttemptStatement(database, claimed, 'needs_attention', 0, errorCode, now),
    finishTaskStatement(
      database,
      claimed,
      'needs_attention',
      errorCode,
      '后台任务的数据状态需要管理员检查',
      now,
    ),
  ]
  if (claimed.task.target_type === 'deletion_operation') {
    statements.push(
      database
        .prepare(
          `UPDATE deletion_operations
           SET operation_status = 'needs_attention', last_error_code = ?1,
               last_error_summary = '后台删除任务需要管理员检查', updated_at = ?2
           WHERE id = ?3 AND operation_status NOT IN ('completed', 'cancelled')`,
        )
        .bind(errorCode, now, claimed.task.target_reference),
    )
  }
  if (claimed.task.target_type === 'message_search') {
    statements.push(
      database
        .prepare(
          `UPDATE message_search_states
           SET index_status = 'needs_attention', chunk_count = 0,
               last_error_code = ?1, indexed_at = NULL, updated_at = ?2
           WHERE message_id = ?3 AND index_generation = ?4
             AND index_status <> 'ready'`,
        )
        .bind(errorCode, now, claimed.task.target_reference, claimed.task.input_version),
    )
  }
  if (claimed.task.target_type === 'backup_run') {
    statements.push(
      database
        .prepare(
          `UPDATE backup_runs
           SET backup_status = 'failed', last_error_code = ?1,
               completed_at = ?2, updated_at = ?2
           WHERE id = ?3 AND backup_status NOT IN ('succeeded', 'cancelled', 'failed')`,
        )
        .bind(errorCode, now, claimed.task.target_reference),
    )
  }
  const results = await database.batch(statements)
  if (results.slice(0, 2).some((result) => result.meta.changes !== 1)) {
    throw new Error('后台任务失败状态已经发生变化')
  }
}

function finishAttemptStatement(
  database: D1Database,
  claimed: ClaimedTask,
  status: 'succeeded' | 'retry_scheduled' | 'needs_attention',
  retryable: 0 | 1,
  errorCode: string | null,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE background_task_attempts
       SET attempt_status = ?1, retryable = ?2,
           error_code = ?3, error_summary = ?4, finished_at = ?5
       WHERE task_id = ?6 AND attempt_number = ?7 AND lease_token = ?8
         AND worker_reference = ?9 AND attempt_status = 'running'
         AND EXISTS (
           SELECT 1 FROM background_tasks
           WHERE id = ?6 AND task_status = 'running'
             AND attempt_count = ?7 AND lease_token = ?8
             AND lease_owner_reference = ?9
         )`,
    )
    .bind(
      status,
      retryable,
      errorCode,
      errorCode === null ? null : '后台任务执行未完成',
      now,
      claimed.task.id,
      claimed.attemptNumber,
      claimed.leaseToken,
      claimed.workerReference,
    )
}

function finishTaskStatement(
  database: D1Database,
  claimed: ClaimedTask,
  status: 'succeeded' | 'needs_attention',
  errorCode: string | null,
  errorSummary: string | null,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE background_tasks
       SET task_status = ?1, next_attempt_at = NULL,
           lease_owner_reference = NULL, lease_expires_at = NULL,
           last_error_code = ?2, last_error_summary = ?3,
           last_error_at = ?4, completed_at = ?5, updated_at = ?6
       WHERE id = ?7 AND task_status = 'running'
         AND attempt_count = ?8 AND lease_token = ?9 AND lease_owner_reference = ?10`,
    )
    .bind(
      status,
      errorCode,
      errorSummary,
      errorCode === null ? null : now,
      status === 'succeeded' ? now : null,
      now,
      claimed.task.id,
      claimed.attemptNumber,
      claimed.leaseToken,
      claimed.workerReference,
    )
}

async function readTask(database: D1Database, taskId: string): Promise<BackgroundTaskRow | null> {
  if (!isUuid(taskId)) return null
  return database
    .prepare(
      `SELECT id, task_type, target_type, target_reference, input_version,
              task_status, attempt_count, max_attempts, next_attempt_at,
              lease_owner_reference, lease_token, lease_expires_at
       FROM background_tasks WHERE id = ?1 LIMIT 1`,
    )
    .bind(taskId)
    .first<BackgroundTaskRow>()
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
