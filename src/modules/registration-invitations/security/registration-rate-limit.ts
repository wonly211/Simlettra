const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000
const MAX_FAILURES = 5

interface RateLimitRow {
  window_started_at: number
  failure_count: number
  blocked_until: number | null
}

export class AccountRegistrationRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('尝试次数过多，请稍后再试')
  }
}

export async function assertAccountRegistrationAllowed(
  database: D1Database,
  sourceDigest: Uint8Array,
  now: number,
): Promise<void> {
  const row = await database
    .prepare(
      `SELECT window_started_at, failure_count, blocked_until
       FROM account_registration_rate_limits
       WHERE source_key_digest = ?1`,
    )
    .bind(sourceDigest)
    .first<RateLimitRow>()
  if (row?.blocked_until && row.blocked_until > now) {
    throw new AccountRegistrationRateLimitedError(
      Math.max(1, Math.ceil((row.blocked_until - now) / 1000)),
    )
  }
}

export async function recordAccountRegistrationFailure(
  database: D1Database,
  sourceDigest: Uint8Array,
  now: number,
): Promise<void> {
  const existing = await database
    .prepare(
      `SELECT window_started_at, failure_count, blocked_until
       FROM account_registration_rate_limits
       WHERE source_key_digest = ?1`,
    )
    .bind(sourceDigest)
    .first<RateLimitRow>()
  const withinWindow = existing !== null && now - existing.window_started_at < RATE_LIMIT_WINDOW_MS
  const windowStartedAt = withinWindow ? existing.window_started_at : now
  const failureCount = withinWindow ? existing.failure_count + 1 : 1
  const blockedUntil = failureCount >= MAX_FAILURES ? now + RATE_LIMIT_BLOCK_MS : null

  await database
    .prepare(
      `INSERT INTO account_registration_rate_limits (
         source_key_digest, window_started_at, failure_count, blocked_until, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (source_key_digest) DO UPDATE SET
         window_started_at = excluded.window_started_at,
         failure_count = excluded.failure_count,
         blocked_until = excluded.blocked_until,
         updated_at = excluded.updated_at`,
    )
    .bind(sourceDigest, windowStartedAt, failureCount, blockedUntil, now)
    .run()
}

export function clearAccountRegistrationRateLimitStatement(
  database: D1Database,
  sourceDigest: Uint8Array,
): D1PreparedStatement {
  return database
    .prepare('DELETE FROM account_registration_rate_limits WHERE source_key_digest = ?1')
    .bind(sourceDigest)
}
