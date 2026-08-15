const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000
const RATE_LIMIT_MAX_FAILURES = 5

interface InitializationRateLimitRow {
  failure_count: number
  blocked_until: number | null
}

export class InitializationKeyError extends Error {
  constructor(
    readonly code: 'configuration_invalid' | 'invalid_key' | 'rate_limited',
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

export async function authorizeInitializationKey(options: {
  database: D1Database
  configuredKey: string
  providedKey: string
  source: string
  now?: number
}): Promise<void> {
  const now = options.now ?? Date.now()
  const configuredKey = options.configuredKey

  if (typeof configuredKey !== 'string' || configuredKey.length < 16) {
    throw new InitializationKeyError(
      'configuration_invalid',
      '部署配置中的初始化密钥缺失或长度不足',
    )
  }

  const sourceDigest = await createSourceDigest(configuredKey, options.source)
  const rateLimit = await options.database
    .prepare(
      `SELECT failure_count, blocked_until
       FROM initialization_rate_limits
       WHERE source_key_digest = ?1`,
    )
    .bind(sourceDigest)
    .first<InitializationRateLimitRow>()

  if (rateLimit?.blocked_until && rateLimit.blocked_until > now) {
    throw new InitializationKeyError(
      'rate_limited',
      '初始化密钥尝试次数过多，请稍后再试',
      Math.ceil((rateLimit.blocked_until - now) / 1000),
    )
  }

  const matches = await constantTimeTextEquals(configuredKey, options.providedKey)
  if (!matches) {
    await recordFailedAttempt(options.database, sourceDigest, now)
    throw new InitializationKeyError('invalid_key', '初始化密钥不正确')
  }

  await options.database
    .prepare('DELETE FROM initialization_rate_limits WHERE source_key_digest = ?1')
    .bind(sourceDigest)
    .run()
}

async function createSourceDigest(key: string, source: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(source))
  return new Uint8Array(digest)
}

async function constantTimeTextEquals(expected: string, received: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [expectedDigest, receivedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
  ])
  const expectedBytes = new Uint8Array(expectedDigest)
  const receivedBytes = new Uint8Array(receivedDigest)
  let difference = 0

  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= (expectedBytes[index] ?? 0) ^ (receivedBytes[index] ?? 0)
  }

  return difference === 0
}

async function recordFailedAttempt(
  database: D1Database,
  sourceDigest: Uint8Array,
  now: number,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO initialization_rate_limits (
          source_key_digest,
          window_started_at,
          failure_count,
          blocked_until,
          updated_at
       ) VALUES (?1, ?2, 1, NULL, ?2)
       ON CONFLICT(source_key_digest) DO UPDATE SET
         window_started_at = CASE
           WHEN excluded.updated_at - initialization_rate_limits.window_started_at >= ?3
             THEN excluded.window_started_at
           ELSE initialization_rate_limits.window_started_at
         END,
         failure_count = CASE
           WHEN excluded.updated_at - initialization_rate_limits.window_started_at >= ?3
             THEN 1
           ELSE initialization_rate_limits.failure_count + 1
         END,
         blocked_until = CASE
           WHEN (
             CASE
               WHEN excluded.updated_at - initialization_rate_limits.window_started_at >= ?3
                 THEN 1
               ELSE initialization_rate_limits.failure_count + 1
             END
           ) >= ?4
             THEN excluded.updated_at + ?5
           ELSE NULL
         END,
         updated_at = excluded.updated_at`,
    )
    .bind(sourceDigest, now, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_FAILURES, RATE_LIMIT_BLOCK_MS)
    .run()
}
