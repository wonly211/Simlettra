import { sql } from 'drizzle-orm'
import { blob, check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { users } from '../../identity/infrastructure/schema'

export const systemInstances = sqliteTable(
  'system_instances',
  {
    singletonId: integer('singleton_id').primaryKey().notNull(),
    storageMode: text('storage_mode').notNull(),
    currentAdminUserId: text('current_admin_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    initializedAt: integer('initialized_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('system_instances_singleton_check', sql`${table.singletonId} = 1`),
    check('system_instances_storage_mode_check', sql`${table.storageMode} in ('kv', 'r2')`),
    check('system_instances_updated_at_check', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
)

export const initializationRateLimits = sqliteTable(
  'initialization_rate_limits',
  {
    sourceKeyDigest: blob('source_key_digest', { mode: 'buffer' }).primaryKey().notNull(),
    windowStartedAt: integer('window_started_at').notNull(),
    failureCount: integer('failure_count').notNull(),
    blockedUntil: integer('blocked_until'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('initialization_rate_limits_expiry_index').on(table.blockedUntil, table.updatedAt),
    check(
      'initialization_rate_limits_digest_length_check',
      sql`length(${table.sourceKeyDigest}) = 32`,
    ),
    check('initialization_rate_limits_failure_count_check', sql`${table.failureCount} >= 0`),
    check(
      'initialization_rate_limits_updated_at_check',
      sql`${table.updatedAt} >= ${table.windowStartedAt}`,
    ),
  ],
)
