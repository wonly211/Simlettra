import { sql } from 'drizzle-orm'
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core'

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey().notNull(),
    status: text('status').notNull(),
    displayName: text('display_name').notNull(),
    timezone: text('timezone'),
    invitationPolicy: text('invitation_policy').notNull().default('manual'),
    deletionRequestedAt: integer('deletion_requested_at'),
    deletionDueAt: integer('deletion_due_at'),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('users_status_index').on(table.status, table.id),
    check(
      'users_status_check',
      sql`${table.status} in ('active', 'disabled', 'deletion_pending', 'deleting', 'deleted')`,
    ),
    check('users_display_name_length_check', sql`length(${table.displayName}) between 1 and 80`),
    check(
      'users_invitation_policy_check',
      sql`${table.invitationPolicy} in ('reject_all', 'manual', 'auto_accept')`,
    ),
    check('users_updated_at_check', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
)

export const passwordCredentials = sqliteTable(
  'password_credentials',
  {
    userId: text('user_id')
      .primaryKey()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    formatVersion: integer('format_version').notNull(),
    algorithm: text('algorithm').notNull(),
    iterations: integer('iterations').notNull(),
    salt: blob('salt', { mode: 'buffer' }).notNull(),
    derivedKey: blob('derived_key', { mode: 'buffer' }).notNull(),
    mustChange: integer('must_change', { mode: 'boolean' }).notNull().default(false),
    temporaryExpiresAt: integer('temporary_expires_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('password_credentials_format_version_check', sql`${table.formatVersion} >= 1`),
    check('password_credentials_algorithm_check', sql`length(${table.algorithm}) > 0`),
    check('password_credentials_iterations_check', sql`${table.iterations} >= 600000`),
    check('password_credentials_salt_length_check', sql`length(${table.salt}) = 16`),
    check('password_credentials_key_length_check', sql`length(${table.derivedKey}) = 32`),
  ],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenDigest: blob('token_digest', { mode: 'buffer' }).notNull(),
    csrfTokenDigest: blob('csrf_token_digest', { mode: 'buffer' }).notNull(),
    clientLabel: text('client_label').notNull(),
    createdAt: integer('created_at').notNull(),
    lastActivityAt: integer('last_activity_at').notNull(),
    idleExpiresAt: integer('idle_expires_at').notNull(),
    absoluteExpiresAt: integer('absolute_expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    unique('sessions_token_digest_unique').on(table.tokenDigest),
    index('sessions_user_active_index')
      .on(table.userId, table.absoluteExpiresAt, table.id)
      .where(sql`${table.revokedAt} is null`),
    check('sessions_token_digest_length_check', sql`length(${table.tokenDigest}) = 32`),
    check('sessions_csrf_digest_length_check', sql`length(${table.csrfTokenDigest}) = 32`),
    check(
      'sessions_client_label_length_check',
      sql`length(${table.clientLabel}) between 1 and 120`,
    ),
    check('sessions_last_activity_check', sql`${table.lastActivityAt} >= ${table.createdAt}`),
    check('sessions_idle_expiry_check', sql`${table.idleExpiresAt} > ${table.createdAt}`),
    check('sessions_absolute_expiry_check', sql`${table.absoluteExpiresAt} > ${table.createdAt}`),
    check('sessions_expiry_order_check', sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`),
  ],
)

export const loginRateLimits = sqliteTable(
  'login_rate_limits',
  {
    scopeType: text('scope_type').notNull(),
    scopeKeyDigest: blob('scope_key_digest', { mode: 'buffer' }).notNull(),
    windowStartedAt: integer('window_started_at').notNull(),
    failureCount: integer('failure_count').notNull(),
    blockedUntil: integer('blocked_until'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeType, table.scopeKeyDigest] }),
    index('login_rate_limits_expiry_index').on(table.blockedUntil, table.updatedAt),
    check('login_rate_limits_scope_check', sql`${table.scopeType} in ('account', 'source')`),
    check('login_rate_limits_digest_length_check', sql`length(${table.scopeKeyDigest}) = 32`),
    check('login_rate_limits_failure_count_check', sql`${table.failureCount} >= 0`),
    check(
      'login_rate_limits_updated_at_check',
      sql`${table.updatedAt} >= ${table.windowStartedAt}`,
    ),
  ],
)
