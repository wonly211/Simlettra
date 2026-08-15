const LOGIN_WINDOW_MS = 15 * 60 * 1000
const ACCOUNT_FAILURE_LIMIT = 5
const SOURCE_FAILURE_LIMIT = 20

export class LoginRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('登录尝试过多，请稍后再试')
  }
}

export interface LoginRateLimitKeys {
  accountDigest: Uint8Array
  sourceDigest: Uint8Array
}

export async function createLoginRateLimitKeys(
  accountKey: string,
  source: string,
): Promise<LoginRateLimitKeys> {
  return {
    accountDigest: await digestScope(accountKey),
    sourceDigest: await digestScope(source),
  }
}

export async function assertLoginAllowed(
  database: D1Database,
  keys: LoginRateLimitKeys,
  now: number,
): Promise<void> {
  const results = await database.batch([
    database
      .prepare(
        `SELECT blocked_until FROM login_rate_limits
         WHERE scope_type = 'account' AND scope_key_digest = ?1`,
      )
      .bind(keys.accountDigest),
    database
      .prepare(
        `SELECT blocked_until FROM login_rate_limits
         WHERE scope_type = 'source' AND scope_key_digest = ?1`,
      )
      .bind(keys.sourceDigest),
  ])

  const blockedUntil = results
    .flatMap((result) => result.results as Array<{ blocked_until: number | null }>)
    .reduce((latest, row) => Math.max(latest, row.blocked_until ?? 0), 0)

  if (blockedUntil > now) {
    throw new LoginRateLimitedError(Math.max(1, Math.ceil((blockedUntil - now) / 1000)))
  }
}

export async function recordLoginFailure(
  database: D1Database,
  keys: LoginRateLimitKeys,
  now: number,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `INSERT INTO login_rate_limits (
          scope_type, scope_key_digest, window_started_at,
          failure_count, blocked_until, updated_at
         ) VALUES ('account', ?1, ?2, 1, NULL, ?2)
         ON CONFLICT(scope_type, scope_key_digest) DO UPDATE SET
          window_started_at = CASE
            WHEN ?2 - window_started_at >= ?3 THEN ?2
            ELSE window_started_at
          END,
          failure_count = CASE
            WHEN ?2 - window_started_at >= ?3 THEN 1
            ELSE failure_count + 1
          END,
          blocked_until = CASE
            WHEN ?2 - window_started_at >= ?3 THEN NULL
            WHEN failure_count + 1 < ?4 THEN blocked_until
            ELSE max(
              coalesce(blocked_until, 0),
              ?2 + CASE failure_count + 1
                WHEN 5 THEN 30000
                WHEN 6 THEN 60000
                WHEN 7 THEN 120000
                WHEN 8 THEN 240000
                WHEN 9 THEN 480000
                ELSE 900000
              END
            )
          END,
          updated_at = ?2`,
      )
      .bind(keys.accountDigest, now, LOGIN_WINDOW_MS, ACCOUNT_FAILURE_LIMIT),
    database
      .prepare(
        `INSERT INTO login_rate_limits (
          scope_type, scope_key_digest, window_started_at,
          failure_count, blocked_until, updated_at
         ) VALUES ('source', ?1, ?2, 1, NULL, ?2)
         ON CONFLICT(scope_type, scope_key_digest) DO UPDATE SET
          window_started_at = CASE
            WHEN ?2 - window_started_at >= ?3 THEN ?2
            ELSE window_started_at
          END,
          failure_count = CASE
            WHEN ?2 - window_started_at >= ?3 THEN 1
            ELSE failure_count + 1
          END,
          blocked_until = CASE
            WHEN ?2 - window_started_at >= ?3 THEN NULL
            WHEN failure_count + 1 < ?4 THEN blocked_until
            ELSE max(coalesce(blocked_until, 0), window_started_at + ?3)
          END,
          updated_at = ?2`,
      )
      .bind(keys.sourceDigest, now, LOGIN_WINDOW_MS, SOURCE_FAILURE_LIMIT),
  ])
}

export async function clearLoginFailures(
  database: D1Database,
  keys: LoginRateLimitKeys,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `DELETE FROM login_rate_limits
         WHERE scope_type = 'account' AND scope_key_digest = ?1`,
      )
      .bind(keys.accountDigest),
    database
      .prepare(
        `DELETE FROM login_rate_limits
         WHERE scope_type = 'source' AND scope_key_digest = ?1`,
      )
      .bind(keys.sourceDigest),
  ])
}

async function digestScope(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.normalize('NFKC'))),
  )
}
