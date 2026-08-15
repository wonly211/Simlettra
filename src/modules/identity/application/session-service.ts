import type { AuthenticatedUser, SessionSummary } from '../../../shared/contracts/authentication'
import {
  constantTimeEqual,
  digestToken,
  isPlausibleToken,
  SESSION_ACTIVITY_WRITE_INTERVAL_MS,
  SESSION_IDLE_DURATION_MS,
} from '../domain/session'

interface SessionRow {
  id: string
  user_id: string
  token_digest: ArrayBuffer
  csrf_token_digest: ArrayBuffer
  client_label: string
  created_at: number
  last_activity_at: number
  idle_expires_at: number
  absolute_expires_at: number
  revoked_at: number | null
  status: string
  display_name: string
  timezone: string | null
  canonical_address: string
  must_change: number
  temporary_expires_at: number | null
  is_administrator: number
}

interface SessionListRow {
  id: string
  client_label: string
  created_at: number
  last_activity_at: number
  idle_expires_at: number
  absolute_expires_at: number
}

export interface AuthenticatedSession {
  id: string
  userId: string
  csrfTokenDigest: Uint8Array
  user: AuthenticatedUser
  summary: SessionSummary
}

export class SessionNotFoundError extends Error {
  constructor() {
    super('该会话不存在或已经退出')
  }
}

export async function authenticateSession(options: {
  database: D1Database
  sessionToken: string | undefined
  now?: number
  touch?: boolean
}): Promise<AuthenticatedSession | null> {
  if (!isPlausibleToken(options.sessionToken)) return null

  const now = options.now ?? Date.now()
  const tokenDigest = await digestToken(options.sessionToken)
  const row = await options.database
    .prepare(
      `SELECT
        sessions.id,
        sessions.user_id,
        sessions.token_digest,
        sessions.csrf_token_digest,
        sessions.client_label,
        sessions.created_at,
        sessions.last_activity_at,
        sessions.idle_expires_at,
        sessions.absolute_expires_at,
        sessions.revoked_at,
        users.status,
        users.display_name,
        users.timezone,
        email_addresses.canonical_address,
        password_credentials.must_change,
        password_credentials.temporary_expires_at,
        CASE WHEN system_instances.current_admin_user_id = users.id THEN 1 ELSE 0 END
          AS is_administrator
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       JOIN password_credentials ON password_credentials.user_id = users.id
       JOIN address_bindings
         ON address_bindings.user_id = users.id
        AND address_bindings.owner_type = 'user'
        AND address_bindings.address_role = 'primary'
        AND address_bindings.ended_at IS NULL
       JOIN email_addresses ON email_addresses.id = address_bindings.address_id
       LEFT JOIN system_instances ON system_instances.singleton_id = 1
       WHERE sessions.token_digest = ?1
       LIMIT 1`,
    )
    .bind(tokenDigest)
    .first<SessionRow>()

  if (!row || row.revoked_at !== null || row.status !== 'active') return null

  if (row.must_change === 1 && (!row.temporary_expires_at || row.temporary_expires_at <= now)) {
    await revokeExpiredSession(options.database, row.id, now, 'temporary_password_expired')
    return null
  }

  if (row.idle_expires_at <= now || row.absolute_expires_at <= now) {
    await revokeExpiredSession(options.database, row.id, now, 'expired')
    return null
  }

  let lastActivityAt = row.last_activity_at
  let idleExpiresAt = row.idle_expires_at
  if (options.touch !== false && row.last_activity_at <= now - SESSION_ACTIVITY_WRITE_INTERVAL_MS) {
    lastActivityAt = now
    idleExpiresAt = Math.min(now + SESSION_IDLE_DURATION_MS, row.absolute_expires_at)
    await options.database
      .prepare(
        `UPDATE sessions
         SET last_activity_at = ?1, idle_expires_at = ?2
         WHERE id = ?3
           AND revoked_at IS NULL
           AND last_activity_at <= ?4`,
      )
      .bind(now, idleExpiresAt, row.id, now - SESSION_ACTIVITY_WRITE_INTERVAL_MS)
      .run()
  }

  return {
    id: row.id,
    userId: row.user_id,
    csrfTokenDigest: new Uint8Array(row.csrf_token_digest),
    user: {
      id: row.user_id,
      displayName: row.display_name,
      primaryAddress: row.canonical_address,
      timezone: row.timezone,
      role: row.is_administrator === 1 ? 'administrator' : 'user',
      passwordChangeRequired: row.must_change === 1,
      temporaryPasswordExpiresAt: row.temporary_expires_at ? toIso(row.temporary_expires_at) : null,
    },
    summary: sessionSummary(row, row.id, lastActivityAt, idleExpiresAt),
  }
}

export async function verifySessionCsrf(
  session: AuthenticatedSession,
  suppliedToken: string | undefined,
): Promise<boolean> {
  if (!isPlausibleToken(suppliedToken)) return false
  return constantTimeEqual(await digestToken(suppliedToken), session.csrfTokenDigest)
}

export async function listUserSessions(options: {
  database: D1Database
  session: AuthenticatedSession
  now?: number
}): Promise<SessionSummary[]> {
  const now = options.now ?? Date.now()
  const result = await options.database
    .prepare(
      `SELECT id, client_label, created_at, last_activity_at, idle_expires_at, absolute_expires_at
       FROM sessions
       WHERE user_id = ?1
         AND revoked_at IS NULL
         AND idle_expires_at > ?2
         AND absolute_expires_at > ?2
       ORDER BY CASE WHEN id = ?3 THEN 0 ELSE 1 END, last_activity_at DESC, id`,
    )
    .bind(options.session.userId, now, options.session.id)
    .all<SessionListRow>()

  return result.results.map((row) => sessionSummary(row, options.session.id))
}

export async function revokeUserSession(options: {
  database: D1Database
  session: AuthenticatedSession
  targetSessionId: string
  reason?: 'user_logout' | 'user_revoked'
  now?: number
}): Promise<{ currentSessionRevoked: boolean }> {
  const now = options.now ?? Date.now()
  const result = await options.database
    .prepare(
      `UPDATE sessions
       SET revoked_at = ?1, revoked_reason = ?2
       WHERE id = ?3 AND user_id = ?4 AND revoked_at IS NULL`,
    )
    .bind(now, options.reason ?? 'user_revoked', options.targetSessionId, options.session.userId)
    .run()

  if (result.meta.changes !== 1) throw new SessionNotFoundError()

  return { currentSessionRevoked: options.targetSessionId === options.session.id }
}

function sessionSummary(
  row: SessionListRow,
  currentSessionId: string,
  lastActivityAt = row.last_activity_at,
  idleExpiresAt = row.idle_expires_at,
): SessionSummary {
  return {
    id: row.id,
    clientLabel: row.client_label,
    createdAt: toIso(row.created_at),
    lastActivityAt: toIso(lastActivityAt),
    idleExpiresAt: toIso(idleExpiresAt),
    absoluteExpiresAt: toIso(row.absolute_expires_at),
    current: row.id === currentSessionId,
  }
}

function toIso(value: number): string {
  return new Date(value).toISOString()
}

async function revokeExpiredSession(
  database: D1Database,
  sessionId: string,
  now: number,
  reason: 'expired' | 'temporary_password_expired',
): Promise<void> {
  await database
    .prepare(
      `UPDATE sessions
       SET revoked_at = ?1, revoked_reason = ?2
       WHERE id = ?3 AND revoked_at IS NULL`,
    )
    .bind(now, reason, sessionId)
    .run()
}
