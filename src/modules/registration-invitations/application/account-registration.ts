import type { AuthenticatedUser, SessionSummary } from '../../../shared/contracts/authentication'
import type {
  AccountRegistrationInvitationSummary,
  CreateAccountRegistrationInvitationRequest,
  RegisterAccountWithInvitationRequest,
} from '../../../shared/contracts/account-registration'
import type { AvailableMailDomain } from '../../../shared/contracts/user-management'
import {
  AddressPolicyInputError,
  readAddressPolicySnapshot,
  validateLocalPartAgainstAddressPolicy,
} from '../../addresses/application/address-policy-management'
import { AddressValidationError, normalizeEmailAddress } from '../../addresses/domain/email-address'
import {
  createAccountRegistrationInvitationGuardedAuditEventStatement,
  createAuditEventStatement,
  type AuditContext,
} from '../../audit/public'
import {
  hashPassword,
  PasswordValidationError,
  validatePassword,
} from '../../identity/domain/password'
import {
  createSessionTokens,
  SESSION_ABSOLUTE_DURATION_MS,
  SESSION_IDLE_DURATION_MS,
} from '../../identity/domain/session'
import type { AuthenticatedSession } from '../../identity/public'
import {
  decryptInvitationCode,
  digestInvitationCode,
  digestRegistrationSource,
  encryptInvitationCode,
  generateInvitationCode,
  InvitationCodeConfigurationError,
  normalizeInvitationCode,
} from '../domain/invitation-code'
import {
  AccountRegistrationRateLimitedError,
  assertAccountRegistrationAllowed,
  clearAccountRegistrationRateLimitStatement,
  recordAccountRegistrationFailure,
} from '../security/registration-rate-limit'

const INVITATION_ENCRYPTION_ALGORITHM = 'AES-GCM-256'

export type AccountRegistrationField =
  keyof CreateAccountRegistrationInvitationRequest | keyof RegisterAccountWithInvitationRequest

interface MailDomainRow {
  id: string
  display_name: string
  canonical_name: string
}

interface InvitationRow {
  id: string
  code_ciphertext: ArrayBuffer
  code_nonce: ArrayBuffer
  encryption_algorithm: string
  encryption_key_version: number
  domain_id: string | null
  domain_name_snapshot: string
  created_at: number
  revoked_at: number | null
  consumed_at: number | null
  used_display_name: string | null
  used_primary_address: string | null
}

interface AvailableInvitationRow {
  id: string
  domain_id: string
  domain_name: string
}

export class AccountRegistrationInputError extends Error {
  constructor(
    readonly field: AccountRegistrationField,
    message: string,
  ) {
    super(message)
  }
}

export class AccountRegistrationAccessError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_available' | 'conflict',
    message: string,
    readonly field?: AccountRegistrationField,
  ) {
    super(message)
  }
}

export class AccountRegistrationPermissionError extends Error {
  constructor() {
    super('只有系统管理员可以管理账号邀请码')
  }
}

export interface AccountRegistrationResult {
  user: AuthenticatedUser
  session: SessionSummary
  sessionToken: string
  csrfToken: string
}

export async function getAccountRegistrationInvitationOverview(options: {
  database: D1Database
  session: AuthenticatedSession
  encryptionKeyBase64?: string
}): Promise<{
  invitations: AccountRegistrationInvitationSummary[]
  domains: AvailableMailDomain[]
}> {
  requireAdministrator(options.session)
  const [invitationResult, domainResult] = await Promise.all([
    options.database
      .prepare(
        `SELECT
           invitation.id,
           invitation.code_ciphertext,
           invitation.code_nonce,
           invitation.encryption_algorithm,
           invitation.encryption_key_version,
           invitation.domain_id,
           invitation.domain_name_snapshot,
           invitation.created_at,
           invitation.revoked_at,
           consumption.consumed_at,
           consumption.user_display_name_snapshot AS used_display_name,
           consumption.primary_address_snapshot AS used_primary_address
         FROM account_registration_invitations AS invitation
         LEFT JOIN account_registration_invitation_consumptions AS consumption
           ON consumption.invitation_id = invitation.id
         ORDER BY invitation.created_at DESC, invitation.id DESC`,
      )
      .all<InvitationRow>(),
    listActiveDomains(options.database),
  ])

  return {
    invitations: await Promise.all(
      invitationResult.results.map((row) => invitationSummary(row, options.encryptionKeyBase64)),
    ),
    domains: domainResult.map(domainSummary),
  }
}

export async function createAccountRegistrationInvitation(options: {
  database: D1Database
  session: AuthenticatedSession
  input: CreateAccountRegistrationInvitationRequest
  encryptionKeyBase64?: string
  audit: AuditContext
  now?: number
}): Promise<AccountRegistrationInvitationSummary> {
  requireAdministrator(options.session)
  const domain = selectInvitationDomain(
    await listActiveDomains(options.database),
    options.input.domainId,
  )
  const now = options.now ?? Date.now()
  const invitationId = crypto.randomUUID()
  const code = generateInvitationCode()
  const normalizedCode = normalizeInvitationCode(code)
  if (!normalizedCode) throw new Error('生成的邀请码格式无效')
  const [codeDigest, encrypted] = await Promise.all([
    digestInvitationCode(normalizedCode),
    encryptInvitationCode({
      code,
      invitationId,
      ...(options.encryptionKeyBase64 ? { encryptionKeyBase64: options.encryptionKeyBase64 } : {}),
    }),
  ])

  const results = await options.database.batch([
    options.database
      .prepare(
        `INSERT INTO account_registration_invitations (
           id, code_digest, code_ciphertext, code_nonce,
           encryption_algorithm, encryption_key_version,
           domain_id, domain_name_snapshot, created_by_user_id, created_at, revoked_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)`,
      )
      .bind(
        invitationId,
        codeDigest,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.algorithm,
        encrypted.keyVersion,
        domain.id,
        domain.canonical_name,
        options.session.userId,
        now,
      ),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.session.userId,
      actionName: 'account_registration.invitation_created',
      targetType: 'account_registration_invitation',
      targetReference: invitationId,
      outcome: 'succeeded',
      reasonCode: 'administrator_requested',
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new AccountRegistrationAccessError('conflict', '邀请码没有完整建立，请刷新后重试')
  }

  return {
    id: invitationId,
    code,
    status: 'available',
    domainId: domain.id,
    domainName: domain.canonical_name,
    createdAt: toIso(now),
    revokedAt: null,
    usedAt: null,
    usedBy: null,
  }
}

export async function revokeAccountRegistrationInvitation(options: {
  database: D1Database
  session: AuthenticatedSession
  invitationId: string
  encryptionKeyBase64?: string
  audit: AuditContext
  now?: number
}): Promise<AccountRegistrationInvitationSummary> {
  requireAdministrator(options.session)
  if (!isUuid(options.invitationId)) {
    throw new AccountRegistrationAccessError('not_found', '邀请码不存在')
  }
  const existing = await findInvitationById(options.database, options.invitationId)
  if (!existing) throw new AccountRegistrationAccessError('not_found', '邀请码不存在')
  if (existing.revoked_at !== null || existing.consumed_at !== null) {
    throw new AccountRegistrationAccessError('not_available', '该邀请码已经使用或撤销')
  }
  const now = Math.max(options.now ?? Date.now(), existing.created_at)
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE account_registration_invitations
         SET revoked_at = ?1
         WHERE id = ?2 AND revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM account_registration_invitation_consumptions
             WHERE invitation_id = ?2
           )`,
      )
      .bind(now, options.invitationId),
    createAccountRegistrationInvitationGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.session.userId,
        actionName: 'account_registration.invitation_revoked',
        targetType: 'account_registration_invitation',
        targetReference: options.invitationId,
        outcome: 'succeeded',
        reasonCode: 'administrator_requested',
        occurredAt: now,
      },
      { invitationId: options.invitationId, revokedAt: now },
    ),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new AccountRegistrationAccessError('conflict', '邀请码状态已经变化，请刷新后重试')
  }
  return invitationSummary({ ...existing, revoked_at: now }, options.encryptionKeyBase64)
}

export async function verifyAccountRegistrationInvitation(options: {
  database: D1Database
  code: string
  source: string
  encryptionKeyBase64?: string
  now?: number
}): Promise<{ domainName: string }> {
  const now = options.now ?? Date.now()
  const sourceDigest = await digestRegistrationSource({
    source: options.source,
    ...(options.encryptionKeyBase64 ? { encryptionKeyBase64: options.encryptionKeyBase64 } : {}),
  })
  await assertAccountRegistrationAllowed(options.database, sourceDigest, now)
  const invitation = await resolveAvailableInvitation(
    options.database,
    options.code,
    sourceDigest,
    now,
  )
  await clearAccountRegistrationRateLimitStatement(options.database, sourceDigest).run()
  return { domainName: invitation.domain_name }
}

export async function registerAccountWithInvitation(options: {
  database: D1Database
  input: RegisterAccountWithInvitationRequest
  source: string
  clientLabel: string
  encryptionKeyBase64?: string
  audit: AuditContext
  now?: number
}): Promise<AccountRegistrationResult> {
  const now = options.now ?? Date.now()
  const sourceDigest = await digestRegistrationSource({
    source: options.source,
    ...(options.encryptionKeyBase64 ? { encryptionKeyBase64: options.encryptionKeyBase64 } : {}),
  })
  await assertAccountRegistrationAllowed(options.database, sourceDigest, now)
  const invitation = await resolveAvailableInvitation(
    options.database,
    options.input.code,
    sourceDigest,
    now,
  )
  const displayName = normalizeDisplayName(options.input.displayName)
  const timezone = normalizeTimezone(options.input.timezone)
  let address
  try {
    address = normalizeEmailAddress(options.input.localPart, invitation.domain_name)
    validateLocalPartAgainstAddressPolicy(
      address.localPart,
      await readAddressPolicySnapshot(options.database),
    )
  } catch (error) {
    if (error instanceof AddressValidationError || error instanceof AddressPolicyInputError) {
      throw new AccountRegistrationInputError('localPart', error.message)
    }
    throw error
  }
  try {
    validatePassword(options.input.password, {
      displayName,
      localPart: address.localPart,
      canonicalDomain: address.canonicalDomain,
    })
  } catch (error) {
    if (error instanceof PasswordValidationError) {
      throw new AccountRegistrationInputError('password', error.message)
    }
    throw error
  }
  if (
    await options.database
      .prepare('SELECT 1 FROM address_claims WHERE canonical_address = ?1 COLLATE NOCASE LIMIT 1')
      .bind(address.canonicalAddress)
      .first()
  ) {
    throw new AccountRegistrationAccessError(
      'conflict',
      '该主邮箱地址已经被使用或保留',
      'localPart',
    )
  }

  const passwordRecord = await hashPassword(options.input.password)
  const tokens = await createSessionTokens()
  const userId = crypto.randomUUID()
  const addressId = crypto.randomUUID()
  const bindingId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const consumptionId = crypto.randomUUID()
  const clientLabel = normalizeClientLabel(options.clientLabel)
  const idleExpiresAt = now + SESSION_IDLE_DURATION_MS
  const absoluteExpiresAt = now + SESSION_ABSOLUTE_DURATION_MS
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
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7)`,
      )
      .bind(
        userId,
        passwordRecord.formatVersion,
        passwordRecord.algorithm,
        passwordRecord.iterations,
        passwordRecord.salt,
        passwordRecord.derivedKey,
        now,
      ),
    options.database
      .prepare(
        `INSERT INTO user_alias_policies (
           user_id, alias_limit, self_creation_enabled,
           updated_by_user_id, created_at, updated_at
         ) VALUES (?1, 20, 1, ?1, ?2, ?2)`,
      )
      .bind(userId, now),
    options.database
      .prepare(
        `INSERT INTO user_organization_policies (
           user_id, organization_limit, updated_by_user_id, created_at, updated_at
         ) VALUES (?1, 5, ?1, ?2, ?2)`,
      )
      .bind(userId, now),
    options.database
      .prepare(
        `INSERT INTO email_addresses (
           id, domain_id, display_address, canonical_address, created_at
         ) VALUES (?1, ?2, ?3, ?3, ?4)`,
      )
      .bind(addressId, invitation.domain_id, address.canonicalAddress, now),
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
    options.database
      .prepare(
        `INSERT INTO sessions (
           id, user_id, token_digest, csrf_token_digest, client_label,
           created_at, last_activity_at, idle_expires_at, absolute_expires_at,
           revoked_at, revoked_reason
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, NULL, NULL)`,
      )
      .bind(
        sessionId,
        userId,
        tokens.sessionTokenDigest,
        tokens.csrfTokenDigest,
        clientLabel,
        now,
        idleExpiresAt,
        absoluteExpiresAt,
      ),
    options.database
      .prepare(
        `INSERT INTO account_registration_invitation_consumptions (
           id, invitation_id, user_id, user_display_name_snapshot,
           primary_address_snapshot, consumed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(consumptionId, invitation.id, userId, displayName, address.canonicalAddress, now),
    clearAccountRegistrationRateLimitStatement(options.database, sourceDigest),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: userId,
      actionName: 'account_registration.completed',
      targetType: 'user',
      targetReference: userId,
      outcome: 'succeeded',
      reasonCode: 'account_registration_invitation',
      occurredAt: now,
    }),
  ]

  try {
    const results = await options.database.batch(statements)
    if (
      (results[0]?.meta.changes ?? 0) < 1 ||
      results[9]?.meta.changes !== 1 ||
      results[11]?.meta.changes !== 1
    ) {
      throw new AccountRegistrationAccessError('conflict', '注册数据没有完整建立，请刷新后重试')
    }
  } catch (error) {
    if (error instanceof AccountRegistrationAccessError) throw error
    if (isConstraintError(error)) {
      throw new AccountRegistrationAccessError(
        'conflict',
        '邀请码已失效或邮箱地址已被使用，请重新检查',
      )
    }
    throw error
  }

  return {
    user: {
      id: userId,
      displayName,
      primaryAddress: address.canonicalAddress,
      timezone,
      role: 'user',
      passwordChangeRequired: false,
      temporaryPasswordExpiresAt: null,
    },
    session: {
      id: sessionId,
      clientLabel,
      createdAt: toIso(now),
      lastActivityAt: toIso(now),
      idleExpiresAt: toIso(idleExpiresAt),
      absoluteExpiresAt: toIso(absoluteExpiresAt),
      current: true,
    },
    sessionToken: tokens.sessionToken,
    csrfToken: tokens.csrfToken,
  }
}

async function resolveAvailableInvitation(
  database: D1Database,
  code: string,
  sourceDigest: Uint8Array,
  now: number,
): Promise<AvailableInvitationRow> {
  const normalizedCode = normalizeInvitationCode(code)
  const digest = await digestInvitationCode(normalizedCode ?? 'INVALID-ACCOUNT-INVITATION')
  const invitation = normalizedCode
    ? await database
        .prepare(
          `SELECT invitation.id, invitation.domain_id, domain.canonical_name AS domain_name
           FROM account_registration_invitations AS invitation
           JOIN mail_domains AS domain ON domain.id = invitation.domain_id
           WHERE invitation.code_digest = ?1
             AND invitation.revoked_at IS NULL
             AND domain.status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM account_registration_invitation_consumptions
               WHERE invitation_id = invitation.id
             )
           LIMIT 1`,
        )
        .bind(digest)
        .first<AvailableInvitationRow>()
    : null
  if (!invitation) {
    await recordAccountRegistrationFailure(database, sourceDigest, now)
    if (!normalizedCode) {
      throw new AccountRegistrationInputError('code', '请输入完整的邀请码')
    }
    throw new AccountRegistrationAccessError('not_available', '邀请码无效、已使用或已撤销')
  }
  return invitation
}

async function findInvitationById(
  database: D1Database,
  invitationId: string,
): Promise<InvitationRow | null> {
  return database
    .prepare(
      `SELECT
         invitation.id,
         invitation.code_ciphertext,
         invitation.code_nonce,
         invitation.encryption_algorithm,
         invitation.encryption_key_version,
         invitation.domain_id,
         invitation.domain_name_snapshot,
         invitation.created_at,
         invitation.revoked_at,
         consumption.consumed_at,
         consumption.user_display_name_snapshot AS used_display_name,
         consumption.primary_address_snapshot AS used_primary_address
       FROM account_registration_invitations AS invitation
       LEFT JOIN account_registration_invitation_consumptions AS consumption
         ON consumption.invitation_id = invitation.id
       WHERE invitation.id = ?1
       LIMIT 1`,
    )
    .bind(invitationId)
    .first<InvitationRow>()
}

async function invitationSummary(
  row: InvitationRow,
  encryptionKeyBase64?: string,
): Promise<AccountRegistrationInvitationSummary> {
  if (
    row.encryption_algorithm !== INVITATION_ENCRYPTION_ALGORITHM ||
    row.encryption_key_version !== 1
  ) {
    throw new InvitationCodeConfigurationError('邀请码使用了当前版本无法读取的加密格式')
  }
  const code = await decryptInvitationCode({
    ciphertext: row.code_ciphertext,
    nonce: row.code_nonce,
    invitationId: row.id,
    ...(encryptionKeyBase64 ? { encryptionKeyBase64 } : {}),
  })
  const status =
    row.consumed_at !== null ? 'used' : row.revoked_at !== null ? 'revoked' : 'available'
  return {
    id: row.id,
    code,
    status,
    domainId: row.domain_id,
    domainName: row.domain_name_snapshot,
    createdAt: toIso(row.created_at),
    revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
    usedAt: row.consumed_at === null ? null : toIso(row.consumed_at),
    usedBy:
      row.used_display_name && row.used_primary_address
        ? {
            displayName: row.used_display_name,
            primaryAddress: row.used_primary_address,
          }
        : null,
  }
}

async function listActiveDomains(database: D1Database): Promise<MailDomainRow[]> {
  const result = await database
    .prepare(
      `SELECT id, display_name, canonical_name
       FROM mail_domains
       WHERE status = 'active'
       ORDER BY canonical_name, id`,
    )
    .all<MailDomainRow>()
  return result.results
}

function selectInvitationDomain(domains: MailDomainRow[], domainId?: string): MailDomainRow {
  if (domains.length === 0) {
    throw new AccountRegistrationInputError('domainId', '当前没有已启用的邮件域名')
  }
  if (domains.length === 1) {
    if (domainId && domainId !== domains[0]!.id) {
      throw new AccountRegistrationInputError('domainId', '请选择当前已启用的邮件域名')
    }
    return domains[0]!
  }
  if (!domainId) {
    throw new AccountRegistrationInputError('domainId', '有多个邮件域名时必须指定邀请码所属域名')
  }
  const domain = domains.find((item) => item.id === domainId)
  if (!domain) throw new AccountRegistrationInputError('domainId', '请选择当前已启用的邮件域名')
  return domain
}

function domainSummary(domain: MailDomainRow): AvailableMailDomain {
  return {
    id: domain.id,
    displayName: domain.display_name,
    canonicalName: domain.canonical_name,
  }
}

function requireAdministrator(session: AuthenticatedSession): void {
  if (session.user.role !== 'administrator') throw new AccountRegistrationPermissionError()
}

function normalizeDisplayName(input: string): string {
  const value = input.trim()
  if ([...value].length < 1 || [...value].length > 80 || containsControlCharacter(value)) {
    throw new AccountRegistrationInputError('displayName', '显示名称必须包含 1 至 80 个有效字符')
  }
  return value
}

function normalizeTimezone(input: string): string {
  const value = input.trim()
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format()
  } catch {
    throw new AccountRegistrationInputError('timezone', '请输入有效的时区')
  }
  return value
}

function normalizeClientLabel(input: string): string {
  const value = input.trim().replace(/\s+/gu, ' ')
  return [...(value || '未知浏览器')].slice(0, 120).join('')
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /constraint failed|unique constraint|foreign key constraint|账号邀请码不可用/iu.test(
      error.message,
    )
  )
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function toIso(value: number): string {
  return new Date(value).toISOString()
}

export { AccountRegistrationRateLimitedError, InvitationCodeConfigurationError }
