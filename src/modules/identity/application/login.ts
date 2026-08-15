import type { AuthenticatedUser, SessionSummary } from '../../../shared/contracts/authentication'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'
import { normalizeCompleteEmailAddress } from '../../addresses/domain/email-address'
import {
  verifyPassword,
  verifyPasswordAgainstVirtualRecord,
  type PasswordRecord,
} from '../domain/password'
import {
  createSessionTokens,
  SESSION_ABSOLUTE_DURATION_MS,
  SESSION_IDLE_DURATION_MS,
} from '../domain/session'
import {
  assertLoginAllowed,
  createLoginRateLimitKeys,
  recordLoginFailure,
} from '../security/login-rate-limit'

export class AuthenticationFailedError extends Error {
  constructor() {
    super('邮箱地址或密码不正确，或者账号当前不可登录')
  }
}

interface LoginCandidateRow {
  id: string
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

export interface LoginResult {
  user: AuthenticatedUser
  session: SessionSummary
  sessionToken: string
  csrfToken: string
}

export async function loginWithPassword(options: {
  database: D1Database
  email: string
  password: string
  source: string
  clientLabel: string
  audit: AuditContext
  now?: number
}): Promise<LoginResult> {
  const now = options.now ?? Date.now()
  const canonicalAddress = normalizeLoginAddress(options.email)
  const accountKey = canonicalAddress ?? options.email.trim().toLowerCase()
  const rateLimitKeys = await createLoginRateLimitKeys(accountKey, options.source)

  await assertLoginAllowed(options.database, rateLimitKeys, now)

  const candidate = canonicalAddress
    ? await findLoginCandidate(options.database, canonicalAddress)
    : null

  let passwordAccepted = false
  if (candidate) {
    passwordAccepted = await verifyPassword(options.password, passwordRecordFromRow(candidate))
  } else {
    await verifyPasswordAgainstVirtualRecord(options.password)
  }

  const temporaryPasswordExpired =
    candidate?.must_change === 1 &&
    (!candidate.temporary_expires_at || candidate.temporary_expires_at <= now)

  if (
    !candidate ||
    !passwordAccepted ||
    candidate.status !== 'active' ||
    temporaryPasswordExpired
  ) {
    await recordLoginFailure(options.database, rateLimitKeys, now)
    throw new AuthenticationFailedError()
  }

  const tokens = await createSessionTokens()
  const sessionId = crypto.randomUUID()
  const absoluteExpiresAt = Math.min(
    now + SESSION_ABSOLUTE_DURATION_MS,
    candidate.must_change === 1 && candidate.temporary_expires_at
      ? candidate.temporary_expires_at
      : Number.POSITIVE_INFINITY,
  )
  const idleExpiresAt = Math.min(now + SESSION_IDLE_DURATION_MS, absoluteExpiresAt)
  const clientLabel = normalizeClientLabel(options.clientLabel)

  await options.database.batch([
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
        candidate.id,
        tokens.sessionTokenDigest,
        tokens.csrfTokenDigest,
        clientLabel,
        now,
        idleExpiresAt,
        absoluteExpiresAt,
      ),
    options.database
      .prepare(
        `DELETE FROM login_rate_limits
         WHERE scope_type = 'account' AND scope_key_digest = ?1`,
      )
      .bind(rateLimitKeys.accountDigest),
    options.database
      .prepare(
        `DELETE FROM login_rate_limits
         WHERE scope_type = 'source' AND scope_key_digest = ?1`,
      )
      .bind(rateLimitKeys.sourceDigest),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: candidate.id,
      actionName: 'authentication.login',
      targetType: 'user',
      targetReference: candidate.id,
      outcome: 'succeeded',
      reasonCode: candidate.must_change === 1 ? 'temporary_password' : 'password',
      occurredAt: now,
    }),
  ])

  return {
    user: {
      id: candidate.id,
      displayName: candidate.display_name,
      primaryAddress: candidate.canonical_address,
      timezone: candidate.timezone,
      role: candidate.is_administrator === 1 ? 'administrator' : 'user',
      passwordChangeRequired: candidate.must_change === 1,
      temporaryPasswordExpiresAt: candidate.temporary_expires_at
        ? toIso(candidate.temporary_expires_at)
        : null,
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

async function findLoginCandidate(
  database: D1Database,
  canonicalAddress: string,
): Promise<LoginCandidateRow | null> {
  return database
    .prepare(
      `SELECT
        users.id,
        users.status,
        users.display_name,
        users.timezone,
        email_addresses.canonical_address,
        password_credentials.format_version,
        password_credentials.algorithm,
        password_credentials.iterations,
        password_credentials.salt,
        password_credentials.derived_key
        ,password_credentials.must_change
        ,password_credentials.temporary_expires_at
        ,CASE WHEN system_instances.current_admin_user_id = users.id THEN 1 ELSE 0 END
          AS is_administrator
       FROM address_bindings
       JOIN email_addresses ON email_addresses.id = address_bindings.address_id
       JOIN users ON users.id = address_bindings.user_id
       JOIN password_credentials ON password_credentials.user_id = users.id
       LEFT JOIN system_instances ON system_instances.singleton_id = 1
       WHERE address_bindings.owner_type = 'user'
         AND address_bindings.address_role = 'primary'
         AND address_bindings.ended_at IS NULL
         AND email_addresses.canonical_address = ?1 COLLATE NOCASE
       LIMIT 1`,
    )
    .bind(canonicalAddress)
    .first<LoginCandidateRow>()
}

function normalizeLoginAddress(value: string): string | null {
  try {
    return normalizeCompleteEmailAddress(value).canonicalAddress
  } catch {
    return null
  }
}

function passwordRecordFromRow(row: LoginCandidateRow): PasswordRecord {
  return {
    formatVersion: row.format_version,
    algorithm: row.algorithm,
    iterations: row.iterations,
    salt: new Uint8Array(row.salt),
    derivedKey: new Uint8Array(row.derived_key),
  }
}

function normalizeClientLabel(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return [...(normalized || '未知浏览器')].slice(0, 120).join('')
}

function toIso(value: number): string {
  return new Date(value).toISOString()
}
