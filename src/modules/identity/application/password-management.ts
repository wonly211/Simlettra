import type { AuthenticatedUser } from '../../../shared/contracts/authentication'
import {
  createPasswordGuardedAuditEventStatement,
  type AuditContext,
  type PasswordCredentialAuditGuard,
} from '../../audit/public'
import {
  AddressValidationError,
  normalizeCompleteEmailAddress,
} from '../../addresses/domain/email-address'
import {
  generateValidTemporaryPassword,
  hashPassword,
  PasswordValidationError,
  TEMPORARY_PASSWORD_DURATION_MS,
  validatePassword,
  verifyPassword,
  type PasswordContext,
  type PasswordRecord,
} from '../domain/password'
import type { AuthenticatedSession } from './session-service'
import {
  assertLoginAllowed,
  clearLoginFailures,
  createLoginRateLimitKeys,
  recordLoginFailure,
} from '../security/login-rate-limit'

type PasswordInputField = 'currentPassword' | 'newPassword' | 'primaryAddress'

interface CredentialContextRow {
  user_id: string
  status: string
  display_name: string
  timezone: string | null
  canonical_address: string
  format_version: number
  algorithm: string
  iterations: number
  salt: ArrayBuffer
  derived_key: ArrayBuffer
  must_change: number
  temporary_expires_at: number | null
  is_administrator: number
}

export interface AdministratorSubject {
  userId: string
  displayName: string
  primaryAddress: string
}

export class PasswordManagementInputError extends Error {
  constructor(
    readonly field: PasswordInputField,
    message: string,
  ) {
    super(message)
  }
}

export class CurrentPasswordIncorrectError extends Error {
  constructor() {
    super('当前密码不正确')
  }
}

export class TemporaryPasswordExpiredError extends Error {
  constructor() {
    super('临时密码已经失效，请联系系统管理员重新设置')
  }
}

export class AdministratorPermissionError extends Error {
  constructor() {
    super('只有系统管理员可以执行此操作')
  }
}

export class PasswordResetTargetError extends Error {
  constructor(
    readonly code: 'not_found' | 'administrator_self_reset' | 'unavailable',
    message: string,
  ) {
    super(message)
  }
}

export class PasswordUpdateConflictError extends Error {
  constructor(message = '密码已被其他操作更新，请重新登录后再试') {
    super(message)
  }
}

export async function changeOwnPassword(options: {
  database: D1Database
  session: AuthenticatedSession
  currentPassword?: string
  newPassword: string
  revokeOtherSessions: boolean
  source: string
  audit: AuditContext
  now?: number
}): Promise<{ user: AuthenticatedUser; revokedOtherSessions: number }> {
  const now = options.now ?? Date.now()
  const credential = await findCredentialByUserId(options.database, options.session.userId)
  if (!credential || credential.status !== 'active') {
    throw new CurrentPasswordIncorrectError()
  }

  const passwordRecord = passwordRecordFromRow(credential)
  const isTemporary = credential.must_change === 1
  if (isTemporary) {
    if (!credential.temporary_expires_at || credential.temporary_expires_at <= now) {
      throw new TemporaryPasswordExpiredError()
    }
  } else {
    const rateLimitKeys = await createLoginRateLimitKeys(
      credential.canonical_address,
      options.source,
    )
    await assertLoginAllowed(options.database, rateLimitKeys, now)
    if (
      typeof options.currentPassword !== 'string' ||
      !(await verifyPassword(options.currentPassword, passwordRecord))
    ) {
      await recordLoginFailure(options.database, rateLimitKeys, now)
      throw new CurrentPasswordIncorrectError()
    }
    await clearLoginFailures(options.database, rateLimitKeys)
  }

  validateNewPassword(options.newPassword, credential)
  if (await verifyPassword(options.newPassword, passwordRecord)) {
    throw new PasswordManagementInputError('newPassword', '新密码不能与当前密码相同')
  }

  const newRecord = await hashPassword(options.newPassword)
  const statements: D1PreparedStatement[] = [
    passwordUpdateStatement(
      options.database,
      credential,
      credential.user_id,
      newRecord,
      false,
      null,
      now,
    ),
  ]
  const revokeOtherSessions = isTemporary || options.revokeOtherSessions
  let revokeResultIndex: number | null = null
  if (revokeOtherSessions) {
    revokeResultIndex = statements.length
    statements.push(
      options.database
        .prepare(
          `UPDATE sessions
           SET revoked_at = ?1, revoked_reason = 'password_changed'
           WHERE user_id = ?2 AND id <> ?3 AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM password_credentials
               WHERE user_id = ?2
                 AND derived_key = ?4
                 AND salt = ?5
                 AND updated_at = ?1
             )`,
        )
        .bind(now, credential.user_id, options.session.id, newRecord.derivedKey, newRecord.salt),
    )
  }

  const auditResultIndex = statements.length
  statements.push(
    createPasswordGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: credential.user_id,
        actionName: 'password.changed',
        targetType: 'user',
        targetReference: credential.user_id,
        outcome: 'succeeded',
        reasonCode: isTemporary ? 'required_change_completed' : 'user_requested',
        occurredAt: now,
      },
      passwordAuditGuard(credential.user_id, newRecord, now),
    ),
  )

  const results = await options.database.batch(statements)
  if (results[0]?.meta.changes !== 1 || results[auditResultIndex]?.meta.changes !== 1) {
    throw new PasswordUpdateConflictError()
  }

  return {
    user: authenticatedUserFromRow(credential, false, null),
    revokedOtherSessions:
      revokeResultIndex === null ? 0 : (results[revokeResultIndex]?.meta.changes ?? 0),
  }
}

export async function resetUserPasswordAsAdministrator(options: {
  database: D1Database
  session: AuthenticatedSession
  primaryAddress: string
  audit: AuditContext
  now?: number
}): Promise<{
  user: { displayName: string; primaryAddress: string }
  temporaryPassword: string
  expiresAt: string
  revokedSessions: number
}> {
  const now = options.now ?? Date.now()
  if (options.session.user.role !== 'administrator') {
    throw new AdministratorPermissionError()
  }

  let canonicalAddress: string
  try {
    canonicalAddress = normalizeCompleteEmailAddress(options.primaryAddress).canonicalAddress
  } catch (error) {
    if (error instanceof AddressValidationError) {
      throw new PasswordManagementInputError('primaryAddress', '请输入有效的用户主邮箱地址')
    }
    throw error
  }

  const target = await findCredentialByPrimaryAddress(options.database, canonicalAddress)
  if (!target) {
    throw new PasswordResetTargetError('not_found', '没有找到使用该主邮箱地址的用户')
  }
  if (target.is_administrator === 1 || target.user_id === options.session.userId) {
    throw new PasswordResetTargetError(
      'administrator_self_reset',
      '系统管理员必须使用 init_key 恢复自己的密码',
    )
  }
  if (target.status !== 'active') {
    throw new PasswordResetTargetError('unavailable', '该用户当前不能登录，不能生成临时密码')
  }

  const temporaryPassword = createValidTemporaryPassword(target)
  const temporaryRecord = await hashPassword(temporaryPassword)
  const expiresAt = now + TEMPORARY_PASSWORD_DURATION_MS
  const results = await options.database.batch([
    passwordUpdateStatement(
      options.database,
      target,
      target.user_id,
      temporaryRecord,
      true,
      expiresAt,
      now,
    ),
    options.database
      .prepare(
        `UPDATE sessions
         SET revoked_at = ?1, revoked_reason = 'administrator_password_reset'
         WHERE user_id = ?2 AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM password_credentials
             WHERE user_id = ?2
               AND derived_key = ?3
               AND salt = ?4
               AND updated_at = ?1
           )`,
      )
      .bind(now, target.user_id, temporaryRecord.derivedKey, temporaryRecord.salt),
    createPasswordGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.session.userId,
        actionName: 'password.temporary_reset',
        targetType: 'user',
        targetReference: target.user_id,
        outcome: 'succeeded',
        reasonCode: 'administrator_requested',
        occurredAt: now,
      },
      passwordAuditGuard(target.user_id, temporaryRecord, now),
    ),
  ])
  if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
    throw new PasswordUpdateConflictError('用户密码已被其他操作更新，请重新执行重置')
  }

  return {
    user: {
      displayName: target.display_name,
      primaryAddress: target.canonical_address,
    },
    temporaryPassword,
    expiresAt: toIso(expiresAt),
    revokedSessions: results[1]?.meta.changes ?? 0,
  }
}

export async function getAdministratorRecoverySubject(
  database: D1Database,
): Promise<AdministratorSubject | null> {
  const row = await database
    .prepare(
      `SELECT
        users.id AS user_id,
        users.display_name,
        email_addresses.canonical_address
       FROM system_instances
       JOIN users ON users.id = system_instances.current_admin_user_id
       JOIN address_bindings
         ON address_bindings.user_id = users.id
        AND address_bindings.owner_type = 'user'
        AND address_bindings.address_role = 'primary'
        AND address_bindings.ended_at IS NULL
       JOIN email_addresses ON email_addresses.id = address_bindings.address_id
       WHERE system_instances.singleton_id = 1
       LIMIT 1`,
    )
    .first<{ user_id: string; display_name: string; canonical_address: string }>()

  return row
    ? {
        userId: row.user_id,
        displayName: row.display_name,
        primaryAddress: row.canonical_address,
      }
    : null
}

export async function recoverAdministratorPassword(options: {
  database: D1Database
  newPassword: string
  audit: AuditContext
  now?: number
}): Promise<AdministratorSubject> {
  const now = options.now ?? Date.now()
  const subject = await getAdministratorRecoverySubject(options.database)
  if (!subject) throw new Error('系统尚未完成初始化')

  const credential = await findCredentialByUserId(options.database, subject.userId)
  if (!credential || credential.status !== 'active' || credential.is_administrator !== 1) {
    throw new Error('系统管理员账号状态异常')
  }

  validateNewPassword(options.newPassword, credential)
  const newRecord = await hashPassword(options.newPassword)
  const results = await options.database.batch([
    passwordUpdateStatement(
      options.database,
      credential,
      subject.userId,
      newRecord,
      false,
      null,
      now,
    ),
    options.database
      .prepare(
        `UPDATE sessions
         SET revoked_at = ?1, revoked_reason = 'administrator_recovery'
         WHERE user_id = ?2 AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM password_credentials
             WHERE user_id = ?2
               AND derived_key = ?3
               AND salt = ?4
               AND updated_at = ?1
           )`,
      )
      .bind(now, subject.userId, newRecord.derivedKey, newRecord.salt),
    createPasswordGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'system',
        actorUserId: null,
        actionName: 'password.administrator_recovered',
        targetType: 'user',
        targetReference: subject.userId,
        outcome: 'succeeded',
        reasonCode: 'init_key_authorized',
        occurredAt: now,
      },
      passwordAuditGuard(subject.userId, newRecord, now),
    ),
  ])
  if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
    throw new PasswordUpdateConflictError('管理员密码已被其他操作更新，请重新执行恢复')
  }

  return subject
}

async function findCredentialByUserId(
  database: D1Database,
  userId: string,
): Promise<CredentialContextRow | null> {
  return findCredential(database, 'users.id = ?1', userId)
}

async function findCredentialByPrimaryAddress(
  database: D1Database,
  primaryAddress: string,
): Promise<CredentialContextRow | null> {
  return findCredential(
    database,
    'email_addresses.canonical_address = ?1 COLLATE NOCASE',
    primaryAddress,
  )
}

async function findCredential(
  database: D1Database,
  predicate: string,
  value: string,
): Promise<CredentialContextRow | null> {
  return database
    .prepare(
      `SELECT
        users.id AS user_id,
        users.status,
        users.display_name,
        users.timezone,
        email_addresses.canonical_address,
        password_credentials.format_version,
        password_credentials.algorithm,
        password_credentials.iterations,
        password_credentials.salt,
        password_credentials.derived_key,
        password_credentials.must_change,
        password_credentials.temporary_expires_at,
        CASE WHEN system_instances.current_admin_user_id = users.id THEN 1 ELSE 0 END
          AS is_administrator
       FROM users
       JOIN password_credentials ON password_credentials.user_id = users.id
       JOIN address_bindings
         ON address_bindings.user_id = users.id
        AND address_bindings.owner_type = 'user'
        AND address_bindings.address_role = 'primary'
        AND address_bindings.ended_at IS NULL
       JOIN email_addresses ON email_addresses.id = address_bindings.address_id
       LEFT JOIN system_instances ON system_instances.singleton_id = 1
       WHERE ${predicate}
       LIMIT 1`,
    )
    .bind(value)
    .first<CredentialContextRow>()
}

function validateNewPassword(password: string, row: CredentialContextRow): void {
  try {
    validatePassword(password, passwordContextFromRow(row))
  } catch (error) {
    if (error instanceof PasswordValidationError) {
      throw new PasswordManagementInputError('newPassword', error.message)
    }
    throw error
  }
}

function createValidTemporaryPassword(row: CredentialContextRow): string {
  return generateValidTemporaryPassword(passwordContextFromRow(row))
}

function passwordContextFromRow(row: CredentialContextRow): PasswordContext {
  const separator = row.canonical_address.lastIndexOf('@')
  return {
    displayName: row.display_name,
    localPart: row.canonical_address.slice(0, separator),
    canonicalDomain: row.canonical_address.slice(separator + 1),
  }
}

function passwordRecordFromRow(row: CredentialContextRow): PasswordRecord {
  return {
    formatVersion: row.format_version,
    algorithm: row.algorithm,
    iterations: row.iterations,
    salt: new Uint8Array(row.salt),
    derivedKey: new Uint8Array(row.derived_key),
  }
}

function authenticatedUserFromRow(
  row: CredentialContextRow,
  passwordChangeRequired: boolean,
  temporaryPasswordExpiresAt: number | null,
): AuthenticatedUser {
  return {
    id: row.user_id,
    displayName: row.display_name,
    primaryAddress: row.canonical_address,
    timezone: row.timezone,
    role: row.is_administrator === 1 ? 'administrator' : 'user',
    passwordChangeRequired,
    temporaryPasswordExpiresAt: temporaryPasswordExpiresAt
      ? toIso(temporaryPasswordExpiresAt)
      : null,
  }
}

function passwordUpdateStatement(
  database: D1Database,
  previous: CredentialContextRow,
  userId: string,
  record: PasswordRecord,
  mustChange: boolean,
  temporaryExpiresAt: number | null,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE password_credentials
       SET format_version = ?1,
           algorithm = ?2,
           iterations = ?3,
           salt = ?4,
           derived_key = ?5,
           must_change = ?6,
           temporary_expires_at = ?7,
           updated_at = ?8
       WHERE user_id = ?9
         AND format_version = ?10
         AND algorithm = ?11
         AND iterations = ?12
         AND salt = ?13
         AND derived_key = ?14
         AND must_change = ?15
         AND (
           temporary_expires_at = ?16
           OR (temporary_expires_at IS NULL AND ?16 IS NULL)
         )`,
    )
    .bind(
      record.formatVersion,
      record.algorithm,
      record.iterations,
      record.salt,
      record.derivedKey,
      mustChange ? 1 : 0,
      temporaryExpiresAt,
      now,
      userId,
      previous.format_version,
      previous.algorithm,
      previous.iterations,
      new Uint8Array(previous.salt),
      new Uint8Array(previous.derived_key),
      previous.must_change,
      previous.temporary_expires_at,
    )
}

function passwordAuditGuard(
  userId: string,
  record: PasswordRecord,
  updatedAt: number,
): PasswordCredentialAuditGuard {
  return {
    userId,
    formatVersion: record.formatVersion,
    algorithm: record.algorithm,
    iterations: record.iterations,
    salt: record.salt,
    derivedKey: record.derivedKey,
    updatedAt,
  }
}

function toIso(value: number): string {
  return new Date(value).toISOString()
}
