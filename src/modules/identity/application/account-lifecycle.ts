import type {
  AccountDeletionBlocker,
  AccountRecoverySessionSummary,
} from '../../../shared/contracts/user-lifecycle'
import { normalizeCompleteEmailAddress } from '../../addresses/domain/email-address'
import {
  createAuditEventStatement,
  createDeletionOperationGuardedAuditEventStatement,
  type AuditContext,
} from '../../audit/public'
import { removeMailboxEntryForLifecycle } from '../../mailbox/public'
import type { MailObjectStore } from '../../mail-receiving/infrastructure/object-storage'
import { sha256Bytes } from '../../mail-receiving/domain/content-digest'
import {
  verifyPassword,
  verifyPasswordAgainstVirtualRecord,
  type PasswordRecord,
} from '../domain/password'
import {
  constantTimeEqual,
  createSessionTokens,
  digestToken,
  isPlausibleToken,
} from '../domain/session'
import {
  assertLoginAllowed,
  createLoginRateLimitKeys,
  recordLoginFailure,
} from '../security/login-rate-limit'
import { AdministratorPermissionError } from './password-management'
import type { AuthenticatedSession } from './session-service'

const RECOVERY_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const RECOVERY_SESSION_DURATION_MS = 30 * 60 * 1000
const LIFECYCLE_POLICY_VERSION = 1
const MAILBOX_BATCH_SIZE = 20
const OBJECT_BATCH_SIZE = 20

interface PasswordRow {
  user_id: string
  status: string
  display_name: string
  canonical_address: string
  deletion_due_at: number | null
  format_version: number
  algorithm: string
  iterations: number
  salt: ArrayBuffer
  derived_key: ArrayBuffer
  is_administrator: number
}

interface RecoverySessionRow {
  id: string
  user_id: string
  csrf_token_digest: ArrayBuffer
  expires_at: number
  display_name: string
  canonical_address: string
  deletion_due_at: number
}

interface LifecycleOperationRow {
  id: string
  operation_kind: string
  target_type: string
  target_reference: string
  requested_by_user_id: string
  policy_version: number
  operation_status: string
  recovery_due_at: number | null
}

export interface AuthenticatedRecoverySession {
  id: string
  userId: string
  csrfTokenDigest: Uint8Array
  summary: AccountRecoverySessionSummary
}

export class AccountLifecycleInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

export class AccountLifecycleAccessError extends Error {
  constructor(
    readonly code:
      | 'invalid_credentials'
      | 'administrator_transfer_required'
      | 'dependencies_unresolved'
      | 'state_conflict'
      | 'recovery_expired'
      | 'recovery_session_invalid',
    message: string,
  ) {
    super(message)
  }
}

export async function getAccountLifecycleOverview(options: {
  database: D1Database
  session: AuthenticatedSession
}): Promise<{ canRequestDeletion: boolean; blockers: AccountDeletionBlocker[]; recoveryDays: 7 }> {
  const blockers = await readDeletionBlockers(options.database, options.session.userId)
  return { canRequestDeletion: blockers.length === 0, blockers, recoveryDays: 7 }
}

export async function transferSystemAdministrator(options: {
  database: D1Database
  session: AuthenticatedSession
  successorUserId: string
  audit: AuditContext
  now?: number
}): Promise<{ previousAdministratorUserId: string; administratorUserId: string }> {
  if (options.session.user.role !== 'administrator') throw new AdministratorPermissionError()
  if (!isUuid(options.successorUserId) || options.successorUserId === options.session.userId) {
    throw new AccountLifecycleInputError('successorUserId', '请选择另一名当前已启用用户')
  }
  const target = await options.database
    .prepare("SELECT id FROM users WHERE id = ?1 AND status = 'active' LIMIT 1")
    .bind(options.successorUserId)
    .first<{ id: string }>()
  if (!target) throw new AccountLifecycleInputError('successorUserId', '请选择当前已启用用户')
  const now = options.now ?? Date.now()
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE system_instances
         SET current_admin_user_id = ?1, updated_at = ?2
         WHERE singleton_id = 1 AND current_admin_user_id = ?3`,
      )
      .bind(target.id, now, options.session.userId),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.session.userId,
      actionName: 'administrator.transferred',
      targetType: 'user',
      targetReference: target.id,
      outcome: 'succeeded',
      reasonCode: 'administrator_requested',
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new AccountLifecycleAccessError('state_conflict', '管理员身份已经发生变化')
  }
  return {
    previousAdministratorUserId: options.session.userId,
    administratorUserId: target.id,
  }
}

export async function requestAccountDeletion(options: {
  database: D1Database
  session: AuthenticatedSession
  currentPassword: string
  confirmation: string
  audit: AuditContext
  now?: number
}): Promise<{ deletionDueAt: string; revokedSessions: number }> {
  if (options.confirmation !== 'DELETE_MY_ACCOUNT') {
    throw new AccountLifecycleInputError('confirmation', '请输入指定确认文字')
  }
  const candidate = await findPasswordUser(options.database, options.session.user.primaryAddress)
  if (!candidate || candidate.user_id !== options.session.userId || candidate.status !== 'active') {
    throw new AccountLifecycleAccessError('state_conflict', '账号状态已经发生变化')
  }
  if (!(await verifyPassword(options.currentPassword, passwordRecord(candidate)))) {
    throw new AccountLifecycleAccessError('invalid_credentials', '当前密码不正确')
  }
  const blockers = await readDeletionBlockers(options.database, options.session.userId)
  if (blockers.some((blocker) => blocker.code === 'administrator_transfer_required')) {
    throw new AccountLifecycleAccessError(
      'administrator_transfer_required',
      '请先把系统管理员身份转让给另一名已启用用户',
    )
  }
  if (blockers.length > 0) {
    throw new AccountLifecycleAccessError(
      'dependencies_unresolved',
      '请先转让或永久删除仍由你创建的组织',
    )
  }

  const now = Math.max(options.now ?? Date.now(), 1)
  const deletionDueAt = now + RECOVERY_DURATION_MS
  const operationId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  const taskDigest = await sha256Bytes(`user_cleanup\n${operationId}\n${LIFECYCLE_POLICY_VERSION}`)
  const impact = await options.database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM mailbox_entries
         WHERE mailbox_type = 'user' AND user_id = ?1) AS mailbox_count,
        (SELECT COUNT(DISTINCT message_id) FROM mailbox_entries
         WHERE mailbox_type = 'user' AND user_id = ?1) AS message_count,
        COALESCE((SELECT SUM(message.raw_size_bytes)
         FROM mailbox_entries AS entry JOIN messages AS message ON message.id = entry.message_id
         WHERE entry.mailbox_type = 'user' AND entry.user_id = ?1), 0) AS size_bytes`,
    )
    .bind(options.session.userId)
    .first<{ mailbox_count: number; message_count: number; size_bytes: number }>()

  const steps = lifecycleStepDefinitions()
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO deletion_operations (
          id, operation_kind, target_type, target_reference,
          requested_by_user_id, policy_version, is_recoverable,
          requested_at, recovery_due_at, impact_mailbox_entry_count,
          impact_message_count, impact_object_count, impact_size_bytes,
          operation_status, created_at, updated_at
         ) VALUES (?1, 'user_delete', 'user', ?2, ?2, ?3, 1,
           ?4, ?5, ?6, ?7, 0, ?8, 'recovery_pending', ?4, ?4)`,
      )
      .bind(
        operationId,
        options.session.userId,
        LIFECYCLE_POLICY_VERSION,
        now,
        deletionDueAt,
        impact?.mailbox_count ?? 0,
        impact?.message_count ?? 0,
        impact?.size_bytes ?? 0,
      ),
  ]
  for (const [stepKey, sequence, stepKind, status] of steps) {
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
        `INSERT INTO account_deletion_membership_snapshots (
          deletion_operation_id, membership_id, organization_id, joined_at, created_at
         )
         SELECT ?1, membership.id, membership.organization_id, membership.joined_at, ?2
         FROM organization_memberships AS membership
         JOIN organizations AS organization ON organization.id = membership.organization_id
         WHERE membership.user_id = ?3 AND membership.left_at IS NULL
           AND organization.creator_user_id <> ?3`,
      )
      .bind(operationId, now, options.session.userId),
    options.database
      .prepare(
        `UPDATE organization_memberships
         SET left_at = ?1, left_reason = 'member_exited'
         WHERE user_id = ?2 AND left_at IS NULL
           AND EXISTS (
             SELECT 1 FROM organizations
             WHERE organizations.id = organization_memberships.organization_id
               AND organizations.creator_user_id <> ?2
           )`,
      )
      .bind(now, options.session.userId),
    options.database
      .prepare(
        `UPDATE users
         SET status = 'deletion_pending', deletion_requested_at = ?1,
             deletion_due_at = ?2, updated_at = ?1
         WHERE id = ?3 AND status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM system_instances WHERE current_admin_user_id = ?3
           )
           AND NOT EXISTS (
             SELECT 1 FROM organizations WHERE creator_user_id = ?3
           )`,
      )
      .bind(now, deletionDueAt, options.session.userId),
    options.database
      .prepare(
        `UPDATE sessions SET revoked_at = ?1, revoked_reason = 'user_deletion_pending'
         WHERE user_id = ?2 AND revoked_at IS NULL
           AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND status = 'deletion_pending')`,
      )
      .bind(now, options.session.userId),
    options.database
      .prepare(
        `INSERT INTO background_tasks (
          id, task_type, target_type, target_reference, input_version,
          task_key_digest, task_status, priority, attempt_count,
          max_attempts, next_attempt_at, lease_owner_reference,
          lease_token, lease_expires_at, created_at, updated_at
         ) VALUES (?1, 'user_cleanup', 'deletion_operation', ?2, ?3,
           ?4, 'pending', 3, 0, 100, ?5, NULL, 0, NULL, ?6, ?6)`,
      )
      .bind(taskId, operationId, LIFECYCLE_POLICY_VERSION, taskDigest, deletionDueAt, now),
    createDeletionOperationGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.session.userId,
        actionName: 'user.deletion_requested',
        targetType: 'user',
        targetReference: options.session.userId,
        outcome: 'succeeded',
        reasonCode: 'user_confirmed',
        occurredAt: now,
      },
      { deletionOperationId: operationId },
    ),
  )

  const results = await options.database.batch(statements)
  const statusIndex = steps.length + 3
  const revokeIndex = steps.length + 4
  if (
    results[0]?.meta.changes !== 1 ||
    results[statusIndex]?.meta.changes !== 1 ||
    results.at(-2)?.meta.changes !== 1 ||
    results.at(-1)?.meta.changes !== 1
  ) {
    throw new AccountLifecycleAccessError('state_conflict', '账号或依赖状态已经发生变化')
  }
  return {
    deletionDueAt: toIso(deletionDueAt),
    revokedSessions: results[revokeIndex]?.meta.changes ?? 0,
  }
}

export async function loginForAccountRecovery(options: {
  database: D1Database
  email: string
  password: string
  source: string
  clientLabel: string
  now?: number
}): Promise<{
  sessionToken: string
  csrfToken: string
  summary: AccountRecoverySessionSummary
}> {
  const now = options.now ?? Date.now()
  const canonicalAddress = normalizeLoginAddress(options.email)
  const accountKey = canonicalAddress ?? options.email.trim().toLowerCase()
  const rateLimitKeys = await createLoginRateLimitKeys(accountKey, options.source)
  await assertLoginAllowed(options.database, rateLimitKeys, now)
  const candidate = canonicalAddress
    ? await findPasswordUser(options.database, canonicalAddress)
    : null
  const passwordAccepted = candidate
    ? await verifyPassword(options.password, passwordRecord(candidate))
    : (await verifyPasswordAgainstVirtualRecord(options.password), false)
  const accepted =
    candidate &&
    candidate.status === 'deletion_pending' &&
    candidate.deletion_due_at !== null &&
    candidate.deletion_due_at > now &&
    candidate.is_administrator === 0 &&
    passwordAccepted
  if (!accepted || !candidate || candidate.deletion_due_at === null) {
    await recordLoginFailure(options.database, rateLimitKeys, now)
    throw new AccountLifecycleAccessError(
      'invalid_credentials',
      '邮箱地址或密码不正确，或者账号当前不能恢复',
    )
  }

  const tokens = await createSessionTokens()
  const sessionId = crypto.randomUUID()
  const expiresAt = Math.min(now + RECOVERY_SESSION_DURATION_MS, candidate.deletion_due_at)
  await options.database.batch([
    options.database
      .prepare(
        `INSERT INTO account_recovery_sessions (
          id, user_id, token_digest, csrf_token_digest, client_label,
          created_at, expires_at, last_activity_at, consumed_at,
          revoked_at, revoked_reason
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, NULL, NULL, NULL)`,
      )
      .bind(
        sessionId,
        candidate.user_id,
        tokens.sessionTokenDigest,
        tokens.csrfTokenDigest,
        normalizeClientLabel(options.clientLabel),
        now,
        expiresAt,
      ),
    options.database
      .prepare(
        "DELETE FROM login_rate_limits WHERE scope_type = 'account' AND scope_key_digest = ?1",
      )
      .bind(rateLimitKeys.accountDigest),
    options.database
      .prepare(
        "DELETE FROM login_rate_limits WHERE scope_type = 'source' AND scope_key_digest = ?1",
      )
      .bind(rateLimitKeys.sourceDigest),
  ])
  return {
    sessionToken: tokens.sessionToken,
    csrfToken: tokens.csrfToken,
    summary: recoverySummary(candidate, expiresAt),
  }
}

export async function authenticateRecoverySession(options: {
  database: D1Database
  sessionToken: string | undefined
  now?: number
}): Promise<AuthenticatedRecoverySession | null> {
  if (!isPlausibleToken(options.sessionToken)) return null
  const now = options.now ?? Date.now()
  const row = await options.database
    .prepare(
      `SELECT recovery.id, recovery.user_id, recovery.csrf_token_digest,
              recovery.expires_at, users.display_name,
              address.canonical_address, users.deletion_due_at
       FROM account_recovery_sessions AS recovery
       JOIN users ON users.id = recovery.user_id
       JOIN address_bindings AS binding
         ON binding.user_id = users.id AND binding.owner_type = 'user'
        AND binding.address_role = 'primary' AND binding.ended_at IS NULL
       JOIN email_addresses AS address ON address.id = binding.address_id
       WHERE recovery.token_digest = ?1 AND recovery.consumed_at IS NULL
         AND recovery.revoked_at IS NULL AND recovery.expires_at > ?2
         AND users.status = 'deletion_pending' AND users.deletion_due_at > ?2
       LIMIT 1`,
    )
    .bind(await digestToken(options.sessionToken), now)
    .first<RecoverySessionRow>()
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    csrfTokenDigest: new Uint8Array(row.csrf_token_digest),
    summary: {
      userId: row.user_id,
      displayName: row.display_name,
      primaryAddress: row.canonical_address,
      deletionDueAt: toIso(row.deletion_due_at),
      sessionExpiresAt: toIso(row.expires_at),
    },
  }
}

export async function verifyRecoverySessionCsrf(
  session: AuthenticatedRecoverySession,
  suppliedToken: string | undefined,
): Promise<boolean> {
  if (!isPlausibleToken(suppliedToken)) return false
  return constantTimeEqual(await digestToken(suppliedToken), session.csrfTokenDigest)
}

export async function cancelAccountDeletion(options: {
  database: D1Database
  session: AuthenticatedRecoverySession
  audit: AuditContext
  now?: number
}): Promise<{ restoredMemberships: number }> {
  const now = options.now ?? Date.now()
  const operation = await options.database
    .prepare(
      `SELECT id FROM deletion_operations
       WHERE operation_kind = 'user_delete' AND target_type = 'user'
         AND target_reference = ?1 AND operation_status = 'recovery_pending'
         AND recovery_due_at > ?2 LIMIT 1`,
    )
    .bind(options.session.userId, now)
    .first<{ id: string }>()
  if (!operation) {
    throw new AccountLifecycleAccessError('recovery_expired', '账号恢复期已经结束')
  }
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE users SET status = 'active', deletion_requested_at = NULL,
             deletion_due_at = NULL, updated_at = ?1
         WHERE id = ?2 AND status = 'deletion_pending' AND deletion_due_at > ?1`,
      )
      .bind(now, options.session.userId),
    options.database
      .prepare(
        `UPDATE organization_memberships
         SET left_at = NULL, left_reason = NULL
         WHERE id IN (
           SELECT snapshot.membership_id
           FROM account_deletion_membership_snapshots AS snapshot
           JOIN organizations AS organization ON organization.id = snapshot.organization_id
           WHERE snapshot.deletion_operation_id = ?1 AND organization.status = 'active'
         ) AND left_at IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM organization_memberships AS current
             WHERE current.organization_id = organization_memberships.organization_id
               AND current.user_id = organization_memberships.user_id
               AND current.left_at IS NULL
           )`,
      )
      .bind(operation.id),
    options.database
      .prepare(
        `UPDATE deletion_operations SET operation_status = 'cancelled',
             cancelled_at = ?1, updated_at = ?1
         WHERE id = ?2 AND operation_status = 'recovery_pending'`,
      )
      .bind(now, operation.id),
    options.database
      .prepare(
        `UPDATE background_tasks SET task_status = 'cancelled', next_attempt_at = NULL,
             completed_at = ?1, updated_at = ?1
         WHERE task_type = 'user_cleanup' AND target_type = 'deletion_operation'
           AND target_reference = ?2 AND task_status IN ('pending', 'retry_wait')`,
      )
      .bind(now, operation.id),
    options.database
      .prepare(
        `UPDATE account_recovery_sessions SET consumed_at = ?1
         WHERE id = ?2 AND user_id = ?3 AND consumed_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(now, options.session.id, options.session.userId),
    options.database
      .prepare(
        `UPDATE account_recovery_sessions
         SET revoked_at = ?1, revoked_reason = 'account_deletion_cancelled'
         WHERE user_id = ?2 AND id <> ?3 AND consumed_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(now, options.session.userId, options.session.id),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.session.userId,
      actionName: 'user.deletion_cancelled',
      targetType: 'user',
      targetReference: options.session.userId,
      outcome: 'succeeded',
      reasonCode: 'user_recovered',
      occurredAt: now,
    }),
  ])
  if (
    results[0]?.meta.changes !== 1 ||
    results[2]?.meta.changes !== 1 ||
    results[4]?.meta.changes !== 1
  ) {
    throw new AccountLifecycleAccessError('state_conflict', '账号恢复状态已经发生变化')
  }
  return { restoredMemberships: results[1]?.meta.changes ?? 0 }
}

export async function processLifecycleCleanupTask(options: {
  database: D1Database
  objectStore: MailObjectStore
  deletionOperationId: string
  inputVersion: number
  now?: number
}): Promise<
  | { status: 'succeeded' }
  | { status: 'retry'; nextAttemptAt: number }
  | { status: 'needs_attention'; errorCode: string }
> {
  const now = options.now ?? Date.now()
  const operation = await readLifecycleOperation(options.database, options.deletionOperationId)
  if (!operation || operation.policy_version !== options.inputVersion) {
    return { status: 'needs_attention', errorCode: 'lifecycle_operation_mismatch' }
  }
  if (operation.operation_status === 'completed') return { status: 'succeeded' }
  if (operation.operation_status === 'cancelled') return { status: 'succeeded' }
  if (operation.recovery_due_at !== null && operation.recovery_due_at > now) {
    return { status: 'retry', nextAttemptAt: operation.recovery_due_at }
  }
  if (operation.operation_kind === 'user_delete' && operation.target_type === 'user') {
    return processUserCleanup(options.database, options.objectStore, operation, now)
  }
  if (
    operation.operation_kind === 'organization_delete' &&
    operation.target_type === 'organization'
  ) {
    return processOrganizationCleanup(options.database, options.objectStore, operation, now)
  }
  return { status: 'needs_attention', errorCode: 'lifecycle_operation_kind_invalid' }
}

async function processUserCleanup(
  database: D1Database,
  objectStore: MailObjectStore,
  operation: LifecycleOperationRow,
  now: number,
) {
  await database.batch([
    database
      .prepare(
        `UPDATE users SET status = 'deleting', updated_at = ?1
         WHERE id = ?2 AND status = 'deletion_pending' AND deletion_due_at <= ?1`,
      )
      .bind(now, operation.target_reference),
    database
      .prepare(
        `UPDATE deletion_operations SET operation_status = 'running', updated_at = ?1
         WHERE id = ?2 AND operation_status IN ('recovery_pending', 'ready')`,
      )
      .bind(now, operation.id),
  ])

  const mailboxEntries = await database
    .prepare(
      `SELECT id FROM mailbox_entries
       WHERE mailbox_type = 'user' AND user_id = ?1
       ORDER BY occurred_at, id LIMIT ?2`,
    )
    .bind(operation.target_reference, MAILBOX_BATCH_SIZE)
    .all<{ id: string }>()
  for (const entry of mailboxEntries.results) {
    await removeMailboxEntryForLifecycle({
      database,
      entryId: entry.id,
      ownerType: 'user',
      ownerId: operation.target_reference,
      requestedByUserId: operation.requested_by_user_id,
      parentDeletionOperationId: operation.id,
      now,
    })
  }
  if (mailboxEntries.results.length > 0) return { status: 'retry' as const, nextAttemptAt: now }

  const draftObjects = await database
    .prepare(
      `SELECT object.id, object.object_key, object.object_status
       FROM object_registry AS object
       JOIN drafts ON drafts.id = object.owner_reference
       WHERE object.owner_kind = 'draft' AND drafts.owner_user_id = ?1
         AND object.object_status <> 'deleted'
       ORDER BY object.created_at, object.id LIMIT ?2`,
    )
    .bind(operation.target_reference, OBJECT_BATCH_SIZE)
    .all<{ id: string; object_key: string; object_status: string }>()
  for (const object of draftObjects.results) {
    if (object.object_status !== 'pending_delete') {
      await database
        .prepare(
          `UPDATE object_registry SET object_status = 'pending_delete', is_current = 0,
               delete_after = COALESCE(delete_after, ?1), updated_at = ?1
           WHERE id = ?2 AND object_status <> 'deleted'`,
        )
        .bind(now, object.id)
        .run()
    }
    await objectStore.delete(object.object_key)
    if (await objectStore.get(object.object_key)) throw new Error('草稿对象删除尚未生效')
    await database
      .prepare(
        `UPDATE object_registry SET object_status = 'deleted', deleted_at = ?1, updated_at = ?1
         WHERE id = ?2 AND object_status = 'pending_delete'`,
      )
      .bind(now, object.id)
      .run()
  }
  if (draftObjects.results.length > 0) return { status: 'retry' as const, nextAttemptAt: now }

  const activeMessageTasks = await countRows(
    database,
    `SELECT COUNT(*) AS count
     FROM lifecycle_cleanup_children AS child_link
     JOIN deletion_operations AS child
       ON child.id = child_link.child_deletion_operation_id
     WHERE child_link.parent_deletion_operation_id = ?1
       AND child.operation_status NOT IN ('completed', 'cancelled')`,
    operation.id,
  )
  if (activeMessageTasks > 0) return { status: 'retry' as const, nextAttemptAt: now + 60_000 }

  await redactUserPersonalData(database, operation, now)
  return { status: 'succeeded' as const }
}

async function processOrganizationCleanup(
  database: D1Database,
  _objectStore: MailObjectStore,
  operation: LifecycleOperationRow,
  now: number,
) {
  await database.batch([
    database
      .prepare(
        `UPDATE organizations SET status = 'deleting', updated_at = ?1
         WHERE id = ?2 AND status = 'deletion_pending' AND deletion_due_at <= ?1`,
      )
      .bind(now, operation.target_reference),
    database
      .prepare(
        `UPDATE deletion_operations SET operation_status = 'running', updated_at = ?1
         WHERE id = ?2 AND operation_status IN ('recovery_pending', 'ready')`,
      )
      .bind(now, operation.id),
  ])

  const mailboxEntries = await database
    .prepare(
      `SELECT id FROM mailbox_entries
       WHERE mailbox_type = 'organization' AND organization_id = ?1
       ORDER BY occurred_at, id LIMIT ?2`,
    )
    .bind(operation.target_reference, MAILBOX_BATCH_SIZE)
    .all<{ id: string }>()
  for (const entry of mailboxEntries.results) {
    await removeMailboxEntryForLifecycle({
      database,
      entryId: entry.id,
      ownerType: 'organization',
      ownerId: operation.target_reference,
      requestedByUserId: operation.requested_by_user_id,
      parentDeletionOperationId: operation.id,
      now,
    })
  }
  if (mailboxEntries.results.length > 0) return { status: 'retry' as const, nextAttemptAt: now }

  const activeMessageTasks = await countRows(
    database,
    `SELECT COUNT(*) AS count
     FROM lifecycle_cleanup_children AS child_link
     JOIN deletion_operations AS child
       ON child.id = child_link.child_deletion_operation_id
     WHERE child_link.parent_deletion_operation_id = ?1
       AND child.operation_status NOT IN ('completed', 'cancelled')`,
    operation.id,
  )
  if (activeMessageTasks > 0) return { status: 'retry' as const, nextAttemptAt: now + 60_000 }

  await redactOrganizationData(database, operation, now)
  return { status: 'succeeded' as const }
}

async function redactUserPersonalData(
  database: D1Database,
  operation: LifecycleOperationRow,
  now: number,
) {
  const userId = operation.target_reference
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE notification_subscriptions
         SET subscription_status = 'deleted', paused_at = NULL, deleted_at = ?1, updated_at = ?1
         WHERE user_id = ?2 AND subscription_status <> 'deleted'`,
      )
      .bind(now, userId),
    database
      .prepare(
        `DELETE FROM notification_subscription_secrets
         WHERE notification_subscription_id IN (
           SELECT id FROM notification_subscriptions WHERE user_id = ?1
         )`,
      )
      .bind(userId),
    database
      .prepare(
        `UPDATE mail_forwarding_rules
         SET rule_status = 'deleted', deleted_at = ?1, updated_at = ?1
         WHERE user_id = ?2 AND rule_status <> 'deleted'`,
      )
      .bind(now, userId),
    database
      .prepare(
        `UPDATE external_email_targets
         SET display_email_address = '已删除外部邮箱',
             canonical_email_address = 'deleted-' || id || '@invalid.invalid',
             target_status = 'deleted', deleted_at = ?1,
             disabled_at = NULL, updated_at = ?1
         WHERE user_id = ?2 AND target_status <> 'deleted'`,
      )
      .bind(now, userId),
    database
      .prepare(
        `DELETE FROM object_registry
         WHERE owner_kind = 'draft' AND owner_reference IN (
           SELECT id FROM drafts WHERE owner_user_id = ?1
         ) AND object_status = 'deleted'`,
      )
      .bind(userId),
    database.prepare('DELETE FROM drafts WHERE owner_user_id = ?1').bind(userId),
    database.prepare('DELETE FROM trusted_sender_addresses WHERE user_id = ?1').bind(userId),
    database.prepare('DELETE FROM user_address_preferences WHERE user_id = ?1').bind(userId),
    database.prepare('DELETE FROM user_alias_policies WHERE user_id = ?1').bind(userId),
    database.prepare('DELETE FROM user_organization_policies WHERE user_id = ?1').bind(userId),
    database
      .prepare("DELETE FROM quota_policies WHERE scope_type = 'user' AND user_id = ?1")
      .bind(userId),
    database
      .prepare(
        "DELETE FROM logical_storage_quota_policies WHERE owner_type = 'user' AND user_id = ?1",
      )
      .bind(userId),
    database
      .prepare(
        "DELETE FROM logical_storage_usage_accounts WHERE owner_type = 'user' AND user_id = ?1",
      )
      .bind(userId),
    database
      .prepare(
        `UPDATE address_bindings SET ended_at = ?1, ended_reason = 'user_deleted'
         WHERE owner_type = 'user' AND user_id = ?2 AND ended_at IS NULL`,
      )
      .bind(now, userId),
    database
      .prepare(
        `DELETE FROM address_claims WHERE address_id IN (
          SELECT address_id FROM address_bindings WHERE owner_type = 'user' AND user_id = ?1
        )`,
      )
      .bind(userId),
    database
      .prepare(
        `UPDATE email_addresses SET retired_at = COALESCE(retired_at, ?1)
         WHERE id IN (
           SELECT address_id FROM address_bindings WHERE owner_type = 'user' AND user_id = ?2
         )`,
      )
      .bind(now, userId),
    database.prepare('DELETE FROM password_credentials WHERE user_id = ?1').bind(userId),
    database.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
    database.prepare('DELETE FROM account_recovery_sessions WHERE user_id = ?1').bind(userId),
    database
      .prepare(
        `UPDATE users SET status = 'deleted', display_name = '已删除用户', timezone = NULL,
             invitation_policy = 'manual', deleted_at = ?1, updated_at = ?1
         WHERE id = ?2 AND status = 'deleting'`,
      )
      .bind(now, userId),
  ]
  const userStatusResultIndex = statements.length - 1
  appendLifecycleCompletionStatements(statements, database, operation.id, now)
  const results = await database.batch(statements)
  if (results[userStatusResultIndex]?.meta.changes !== 1 || results.at(-1)?.meta.changes !== 1) {
    throw new Error('用户永久清理最终对账未通过')
  }
}

async function redactOrganizationData(
  database: D1Database,
  operation: LifecycleOperationRow,
  now: number,
) {
  const organizationId = operation.target_reference
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `DELETE FROM notification_subscription_scopes
         WHERE scope_kind = 'organization_address' AND email_address_id IN (
           SELECT address_id FROM address_bindings
           WHERE owner_type = 'organization' AND organization_id = ?1
         )`,
      )
      .bind(organizationId),
    database
      .prepare(
        `UPDATE organization_memberships SET left_at = COALESCE(left_at, ?1),
             left_reason = COALESCE(left_reason, 'organization_deleted')
         WHERE organization_id = ?2`,
      )
      .bind(now, organizationId),
    database
      .prepare('DELETE FROM organization_invitations WHERE organization_id = ?1')
      .bind(organizationId),
    database
      .prepare(
        `UPDATE address_bindings SET ended_at = ?1, ended_reason = 'organization_deleted'
         WHERE owner_type = 'organization' AND organization_id = ?2 AND ended_at IS NULL`,
      )
      .bind(now, organizationId),
    database
      .prepare(
        `DELETE FROM address_claims WHERE address_id IN (
          SELECT address_id FROM address_bindings
          WHERE owner_type = 'organization' AND organization_id = ?1
         )`,
      )
      .bind(organizationId),
    database
      .prepare(
        `UPDATE email_addresses SET retired_at = COALESCE(retired_at, ?1)
         WHERE id IN (
           SELECT address_id FROM address_bindings
           WHERE owner_type = 'organization' AND organization_id = ?2
         )`,
      )
      .bind(now, organizationId),
    database
      .prepare(
        "DELETE FROM logical_storage_quota_policies WHERE owner_type = 'organization' AND organization_id = ?1",
      )
      .bind(organizationId),
    database
      .prepare(
        "DELETE FROM logical_storage_usage_accounts WHERE owner_type = 'organization' AND organization_id = ?1",
      )
      .bind(organizationId),
    database
      .prepare(
        `UPDATE organizations SET name = '已删除组织', members_can_send = 0, updated_at = ?1
         WHERE id = ?2 AND status = 'deleting'`,
      )
      .bind(now, organizationId),
  ]
  appendLifecycleCompletionStatements(statements, database, operation.id, now)
  const results = await database.batch(statements)
  if ((results[8]?.meta.changes ?? 0) !== 1 || results.at(-1)?.meta.changes !== 1) {
    throw new Error('组织永久清理最终对账未通过')
  }
}

function appendLifecycleCompletionStatements(
  statements: D1PreparedStatement[],
  database: D1Database,
  operationId: string,
  now: number,
) {
  for (const [stepKey] of lifecycleStepDefinitions().slice(1)) {
    statements.push(
      database
        .prepare(
          `UPDATE deletion_operation_steps
           SET step_status = 'succeeded', attempt_count = attempt_count + 1,
               started_at = COALESCE(started_at, ?1), completed_at = ?1, updated_at = ?1
           WHERE deletion_operation_id = ?2 AND step_key = ?3
             AND step_status IN ('pending', 'running', 'retry_wait', 'needs_attention')`,
        )
        .bind(now, operationId, stepKey),
    )
  }
  statements.push(
    database
      .prepare(
        `UPDATE deletion_operations SET operation_status = 'completed',
             completed_at = ?1, updated_at = ?1
         WHERE id = ?2 AND operation_status = 'running'`,
      )
      .bind(now, operationId),
  )
}

async function readDeletionBlockers(database: D1Database, userId: string) {
  const [administrator, organizations] = await Promise.all([
    database
      .prepare('SELECT 1 FROM system_instances WHERE current_admin_user_id = ?1 LIMIT 1')
      .bind(userId)
      .first(),
    database
      .prepare(
        `SELECT id, name, status FROM organizations
         WHERE creator_user_id = ?1 ORDER BY created_at, id`,
      )
      .bind(userId)
      .all<{ id: string; name: string; status: string }>(),
  ])
  const blockers: AccountDeletionBlocker[] = []
  if (administrator) {
    blockers.push({
      code: 'administrator_transfer_required',
      reference: userId,
      label: '系统管理员身份',
      status: 'active',
    })
  }
  blockers.push(
    ...organizations.results.map((organization) => ({
      code: 'owned_organization' as const,
      reference: organization.id,
      label: organization.name,
      status: organization.status,
    })),
  )
  return blockers
}

async function findPasswordUser(database: D1Database, canonicalAddress: string) {
  return database
    .prepare(
      `SELECT users.id AS user_id, users.status, users.display_name,
              address.canonical_address, users.deletion_due_at,
              credential.format_version, credential.algorithm, credential.iterations,
              credential.salt, credential.derived_key,
              CASE WHEN system.current_admin_user_id = users.id THEN 1 ELSE 0 END AS is_administrator
       FROM users
       JOIN password_credentials AS credential ON credential.user_id = users.id
       JOIN address_bindings AS binding
         ON binding.user_id = users.id AND binding.owner_type = 'user'
        AND binding.address_role = 'primary' AND binding.ended_at IS NULL
       JOIN email_addresses AS address ON address.id = binding.address_id
       LEFT JOIN system_instances AS system ON system.singleton_id = 1
       WHERE address.canonical_address = ?1 COLLATE NOCASE LIMIT 1`,
    )
    .bind(canonicalAddress)
    .first<PasswordRow>()
}

function passwordRecord(row: PasswordRow): PasswordRecord {
  return {
    formatVersion: row.format_version,
    algorithm: row.algorithm,
    iterations: row.iterations,
    salt: new Uint8Array(row.salt),
    derivedKey: new Uint8Array(row.derived_key),
  }
}

function recoverySummary(row: PasswordRow, expiresAt: number): AccountRecoverySessionSummary {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    primaryAddress: row.canonical_address,
    deletionDueAt: toIso(row.deletion_due_at!),
    sessionExpiresAt: toIso(expiresAt),
  }
}

async function readLifecycleOperation(database: D1Database, operationId: string) {
  return database
    .prepare(
      `SELECT id, operation_kind, target_type, target_reference,
              requested_by_user_id, policy_version, operation_status, recovery_due_at
       FROM deletion_operations WHERE id = ?1 LIMIT 1`,
    )
    .bind(operationId)
    .first<LifecycleOperationRow>()
}

function lifecycleStepDefinitions() {
  return [
    ['revoke_access', 0, 'revoke_access', 'succeeded'],
    ['remove_mailbox_relations', 1, 'database_relations', 'pending'],
    ['remove_objects', 2, 'objects', 'pending'],
    ['remove_search_data', 3, 'search', 'pending'],
    ['remove_settings', 4, 'cache', 'pending'],
    ['release_addresses', 5, 'release_identity', 'pending'],
    ['reconcile_cleanup', 6, 'reconcile', 'pending'],
  ] as const
}

function normalizeLoginAddress(value: string): string | null {
  try {
    return normalizeCompleteEmailAddress(value).canonicalAddress
  } catch {
    return null
  }
}

function normalizeClientLabel(value: string) {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return [...(normalized || '未知浏览器')].slice(0, 120).join('')
}

async function countRows(database: D1Database, sql: string, reference: string) {
  const row = await database.prepare(sql).bind(reference).first<{ count: number }>()
  return row?.count ?? 0
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function toIso(value: number) {
  return new Date(value).toISOString()
}
