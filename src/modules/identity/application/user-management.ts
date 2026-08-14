import type {
  AvailableMailDomain,
  CreateManagedUserRequest,
  ManagedUserStatus,
  ManagedUserSummary,
} from '../../../shared/contracts/user-management'
import { AddressValidationError, normalizeEmailAddress } from '../../addresses/domain/email-address'
import {
  AddressPolicyInputError,
  readAddressPolicySnapshot,
  validateLocalPartAgainstAddressPolicy,
} from '../../addresses/application/address-policy-management'
import {
  createAuditEventStatement,
  createUserStateGuardedAuditEventStatement,
  type AuditContext,
} from '../../audit/public'
import {
  generateValidTemporaryPassword,
  hashPassword,
  TEMPORARY_PASSWORD_DURATION_MS,
} from '../domain/password'
import { AdministratorPermissionError } from './password-management'
import type { AuthenticatedSession } from './session-service'

type UserManagementField = keyof CreateManagedUserRequest

interface ManagedUserRow {
  id: string
  status: string
  display_name: string
  timezone: string | null
  canonical_address: string
  created_at: number
  updated_at: number
  is_administrator: number
}

interface MailDomainRow {
  id: string
  display_name: string
  canonical_name: string
}

export class UserManagementInputError extends Error {
  constructor(
    readonly field: UserManagementField,
    message: string,
  ) {
    super(message)
  }
}

export class UserCreationConflictError extends Error {
  readonly code = 'primary_address_unavailable'
}

export class ManagedUserTargetError extends Error {
  constructor(
    readonly code: 'not_found' | 'administrator_protected' | 'state_unavailable' | 'conflict',
    message: string,
  ) {
    super(message)
  }
}

export async function getUserManagementOverview(options: {
  database: D1Database
  session: AuthenticatedSession
}): Promise<{ users: ManagedUserSummary[]; domains: AvailableMailDomain[] }> {
  requireAdministrator(options.session)

  const [userResult, domainResult] = await Promise.all([
    options.database
      .prepare(
        `SELECT
          users.id,
          users.status,
          users.display_name,
          users.timezone,
          users.created_at,
          users.updated_at,
          email_addresses.canonical_address,
          CASE WHEN system_instances.current_admin_user_id = users.id THEN 1 ELSE 0 END
            AS is_administrator
         FROM users
         JOIN address_bindings
           ON address_bindings.user_id = users.id
          AND address_bindings.owner_type = 'user'
          AND address_bindings.address_role = 'primary'
          AND address_bindings.ended_at IS NULL
         JOIN email_addresses ON email_addresses.id = address_bindings.address_id
         LEFT JOIN system_instances ON system_instances.singleton_id = 1
         WHERE users.status IN ('active', 'disabled')
         ORDER BY is_administrator DESC, users.created_at, users.id`,
      )
      .all<ManagedUserRow>(),
    options.database
      .prepare(
        `SELECT id, display_name, canonical_name
         FROM mail_domains
         WHERE status = 'active'
         ORDER BY canonical_name, id`,
      )
      .all<MailDomainRow>(),
  ])

  return {
    users: userResult.results.map(managedUserFromRow),
    domains: domainResult.results.map((domain) => ({
      id: domain.id,
      displayName: domain.display_name,
      canonicalName: domain.canonical_name,
    })),
  }
}

export async function createManagedUser(options: {
  database: D1Database
  session: AuthenticatedSession
  input: CreateManagedUserRequest
  audit: AuditContext
  now?: number
}): Promise<{
  user: ManagedUserSummary
  temporaryPassword: string
  expiresAt: string
}> {
  requireAdministrator(options.session)
  const now = options.now ?? Date.now()
  const displayName = normalizeDisplayName(options.input.displayName)
  const timezone = normalizeTimezone(options.input.timezone)
  const domain = await findActiveMailDomain(options.database, options.input.domainId)
  if (!domain) throw new UserManagementInputError('domainId', '请选择当前已启用的邮件域名')

  let address
  try {
    address = normalizeEmailAddress(options.input.localPart, domain.canonical_name)
    validateLocalPartAgainstAddressPolicy(
      address.localPart,
      await readAddressPolicySnapshot(options.database),
    )
  } catch (error) {
    if (error instanceof AddressValidationError || error instanceof AddressPolicyInputError) {
      throw new UserManagementInputError('localPart', error.message)
    }
    throw error
  }

  const existingClaim = await options.database
    .prepare('SELECT 1 FROM address_claims WHERE canonical_address = ?1 COLLATE NOCASE LIMIT 1')
    .bind(address.canonicalAddress)
    .first()
  if (existingClaim) throw new UserCreationConflictError('该主邮箱地址已经被使用或保留')

  const temporaryPassword = generateValidTemporaryPassword({
    displayName,
    localPart: address.localPart,
    canonicalDomain: address.canonicalDomain,
  })
  const passwordRecord = await hashPassword(temporaryPassword)
  const expiresAt = now + TEMPORARY_PASSWORD_DURATION_MS
  const userId = crypto.randomUUID()
  const addressId = crypto.randomUUID()
  const bindingId = crypto.randomUUID()

  const statements = [
    options.database
      .prepare(
        `INSERT INTO users (
          id, status, display_name, timezone, invitation_policy, created_at, updated_at
         ) VALUES (?1, 'active', ?2, ?3, 'manual', ?4, ?4)`,
      )
      .bind(userId, displayName, timezone, now),
    options.database
      .prepare(
        `INSERT INTO password_credentials (
          user_id, format_version, algorithm, iterations, salt, derived_key,
          must_change, temporary_expires_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)`,
      )
      .bind(
        userId,
        passwordRecord.formatVersion,
        passwordRecord.algorithm,
        passwordRecord.iterations,
        passwordRecord.salt,
        passwordRecord.derivedKey,
        expiresAt,
        now,
      ),
    options.database
      .prepare(
        `INSERT INTO user_alias_policies (
          user_id, alias_limit, self_creation_enabled,
          updated_by_user_id, created_at, updated_at
         ) VALUES (?1, 20, 1, ?2, ?3, ?3)`,
      )
      .bind(userId, options.session.userId, now),
    options.database
      .prepare(
        `INSERT INTO user_organization_policies (
          user_id, organization_limit, updated_by_user_id, created_at, updated_at
         ) VALUES (?1, 5, ?2, ?3, ?3)`,
      )
      .bind(userId, options.session.userId, now),
    options.database
      .prepare(
        `INSERT INTO email_addresses (
          id, domain_id, display_address, canonical_address, created_at
         ) VALUES (?1, ?2, ?3, ?3, ?4)`,
      )
      .bind(addressId, domain.id, address.canonicalAddress, now),
    options.database
      .prepare(
        `INSERT INTO address_claims (
          canonical_address, address_id, status, reserved_until, created_at, updated_at
         ) VALUES (?1, ?2, 'active', NULL, ?3, ?3)`,
      )
      .bind(address.canonicalAddress, addressId, now),
    options.database
      .prepare(
        `INSERT INTO address_bindings (
          id, address_id, owner_type, user_id, organization_id,
          address_role, started_at, ended_at, ended_reason
         ) VALUES (?1, ?2, 'user', ?3, NULL, 'primary', ?4, NULL, NULL)`,
      )
      .bind(bindingId, addressId, userId, now),
    options.database
      .prepare(
        `INSERT INTO user_address_preferences (
          user_id, address_id, is_pinned, sort_order, is_default_sender,
          sender_display_name, created_at, updated_at
         ) VALUES (?1, ?2, 1, 0, 1, ?3, ?4, ?4)`,
      )
      .bind(userId, addressId, displayName, now),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.session.userId,
      actionName: 'user.created',
      targetType: 'user',
      targetReference: userId,
      outcome: 'succeeded',
      reasonCode: 'administrator_created',
      occurredAt: now,
    }),
  ]

  try {
    const results = await options.database.batch(statements)
    if (
      (results[0]?.meta.changes ?? 0) < 1 ||
      results.slice(1).some((result) => result.meta.changes !== 1)
    ) {
      throw new UserCreationConflictError('用户数据没有完整建立')
    }
  } catch (error) {
    if (error instanceof UserCreationConflictError || isConstraintError(error)) {
      throw new UserCreationConflictError('该主邮箱地址已经被使用或用户数据发生冲突')
    }
    throw error
  }

  return {
    user: {
      id: userId,
      displayName,
      primaryAddress: address.canonicalAddress,
      timezone,
      status: 'active',
      role: 'user',
      createdAt: toIso(now),
    },
    temporaryPassword,
    expiresAt: toIso(expiresAt),
  }
}

export async function changeManagedUserStatus(options: {
  database: D1Database
  session: AuthenticatedSession
  userId: string
  status: ManagedUserStatus
  audit: AuditContext
  now?: number
}): Promise<{ user: ManagedUserSummary; changed: boolean; revokedSessions: number }> {
  requireAdministrator(options.session)
  const target = await findManagedUser(options.database, options.userId)
  if (!target) throw new ManagedUserTargetError('not_found', '该用户不存在')
  if (target.is_administrator === 1) {
    throw new ManagedUserTargetError('administrator_protected', '唯一系统管理员不能被禁用')
  }
  if (target.status !== 'active' && target.status !== 'disabled') {
    throw new ManagedUserTargetError('state_unavailable', '该账号正在注销或清理，不能改变状态')
  }
  if (target.status === options.status) {
    return { user: managedUserFromRow(target), changed: false, revokedSessions: 0 }
  }

  const now = Math.max(options.now ?? Date.now(), target.updated_at + 1)
  const statusStatement = options.database
    .prepare(
      `UPDATE users
       SET status = ?1, updated_at = ?2
       WHERE id = ?3 AND status = ?4
         AND NOT EXISTS (
           SELECT 1 FROM system_instances
           WHERE singleton_id = 1 AND current_admin_user_id = ?3
         )`,
    )
    .bind(options.status, now, target.id, target.status)

  const statements: D1PreparedStatement[] = [statusStatement]
  let revokeResultIndex: number | null = null
  if (options.status === 'disabled') {
    revokeResultIndex = statements.length
    statements.push(
      options.database
        .prepare(
          `UPDATE sessions
           SET revoked_at = ?1, revoked_reason = 'user_disabled'
           WHERE user_id = ?2 AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM users
               WHERE id = ?2 AND status = 'disabled' AND updated_at = ?1
             )`,
        )
        .bind(now, target.id),
    )
  }

  const auditResultIndex = statements.length
  statements.push(
    createUserStateGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.session.userId,
        actionName: options.status === 'disabled' ? 'user.disabled' : 'user.enabled',
        targetType: 'user',
        targetReference: target.id,
        outcome: 'succeeded',
        reasonCode: 'administrator_requested',
        occurredAt: now,
      },
      { userId: target.id, status: options.status, updatedAt: now },
    ),
  )

  const results = await options.database.batch(statements)
  if (results[0]?.meta.changes !== 1 || results[auditResultIndex]?.meta.changes !== 1) {
    throw new ManagedUserTargetError('conflict', '账号状态已经发生变化，请刷新后重试')
  }

  return {
    user: managedUserFromRow({ ...target, status: options.status, updated_at: now }),
    changed: true,
    revokedSessions:
      revokeResultIndex === null ? 0 : (results[revokeResultIndex]?.meta.changes ?? 0),
  }
}

function requireAdministrator(session: AuthenticatedSession): void {
  if (session.user.role !== 'administrator') throw new AdministratorPermissionError()
}

async function findActiveMailDomain(
  database: D1Database,
  domainId: string,
): Promise<MailDomainRow | null> {
  if (!isUuid(domainId)) return null
  return database
    .prepare(
      `SELECT id, display_name, canonical_name
       FROM mail_domains
       WHERE id = ?1 AND status = 'active'
       LIMIT 1`,
    )
    .bind(domainId)
    .first<MailDomainRow>()
}

async function findManagedUser(
  database: D1Database,
  userId: string,
): Promise<ManagedUserRow | null> {
  if (!isUuid(userId)) return null
  return database
    .prepare(
      `SELECT
        users.id,
        users.status,
        users.display_name,
        users.timezone,
        users.created_at,
        users.updated_at,
        email_addresses.canonical_address,
        CASE WHEN system_instances.current_admin_user_id = users.id THEN 1 ELSE 0 END
          AS is_administrator
       FROM users
       JOIN address_bindings
         ON address_bindings.user_id = users.id
        AND address_bindings.owner_type = 'user'
        AND address_bindings.address_role = 'primary'
        AND address_bindings.ended_at IS NULL
       JOIN email_addresses ON email_addresses.id = address_bindings.address_id
       LEFT JOIN system_instances ON system_instances.singleton_id = 1
       WHERE users.id = ?1
       LIMIT 1`,
    )
    .bind(userId)
    .first<ManagedUserRow>()
}

function normalizeDisplayName(input: string): string {
  const displayName = input.trim()
  if (
    [...displayName].length < 1 ||
    [...displayName].length > 80 ||
    containsControlCharacter(displayName)
  ) {
    throw new UserManagementInputError('displayName', '显示名称必须包含 1 至 80 个有效字符')
  }
  return displayName
}

function normalizeTimezone(input: string): string {
  const timezone = input.trim()
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format()
  } catch {
    throw new UserManagementInputError('timezone', '请输入有效的时区')
  }
  return timezone
}

function managedUserFromRow(row: ManagedUserRow): ManagedUserSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    primaryAddress: row.canonical_address,
    timezone: row.timezone,
    status: row.status as ManagedUserStatus,
    role: row.is_administrator === 1 ? 'administrator' : 'user',
    createdAt: toIso(row.created_at),
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint|foreign key constraint/iu.test(error.message)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function toIso(value: number): string {
  return new Date(value).toISOString()
}
