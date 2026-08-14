import { sql } from 'drizzle-orm'
import {
  blob,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { emailAddresses } from '../../addresses/infrastructure/schema'
import { users } from '../../identity/infrastructure/schema'
import { messageDeliveries } from '../../mail-receiving/infrastructure/schema'

export const notificationSubscriptions = sqliteTable(
  'notification_subscriptions',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    channelType: text('channel_type').notNull(),
    publicOptionsJson: text('public_options_json').notNull(),
    subscriptionStatus: text('subscription_status').notNull(),
    pausedAt: integer('paused_at'),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('notification_subscriptions_user_index').on(
      table.userId,
      table.subscriptionStatus,
      table.createdAt,
      table.id,
    ),
  ],
)

export const notificationSubscriptionScopes = sqliteTable(
  'notification_subscription_scopes',
  {
    id: text('id').primaryKey().notNull(),
    notificationSubscriptionId: text('notification_subscription_id')
      .notNull()
      .references(() => notificationSubscriptions.id, { onDelete: 'cascade' }),
    scopeKind: text('scope_kind').notNull(),
    emailAddressId: text('email_address_id').references(() => emailAddresses.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('notification_subscription_all_personal_unique')
      .on(table.notificationSubscriptionId)
      .where(sql`${table.scopeKind} = 'all_personal'`),
    uniqueIndex('notification_subscription_address_scope_unique')
      .on(table.notificationSubscriptionId, table.emailAddressId)
      .where(sql`${table.emailAddressId} IS NOT NULL`),
    index('notification_subscription_scopes_address_index').on(
      table.emailAddressId,
      table.scopeKind,
      table.notificationSubscriptionId,
    ),
  ],
)

export const notificationSubscriptionSecrets = sqliteTable('notification_subscription_secrets', {
  notificationSubscriptionId: text('notification_subscription_id')
    .primaryKey()
    .notNull()
    .references(() => notificationSubscriptions.id, { onDelete: 'cascade' }),
  credentialCiphertext: blob('credential_ciphertext', { mode: 'buffer' }).notNull(),
  credentialNonce: blob('credential_nonce', { mode: 'buffer' }).notNull(),
  credentialAlgorithm: text('credential_algorithm').notNull(),
  credentialKeyVersion: integer('credential_key_version').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const notificationOperations = sqliteTable(
  'notification_operations',
  {
    id: text('id').primaryKey().notNull(),
    notificationSubscriptionId: text('notification_subscription_id')
      .notNull()
      .references(() => notificationSubscriptions.id, { onDelete: 'restrict' }),
    messageDeliveryId: text('message_delivery_id')
      .notNull()
      .references(() => messageDeliveries.id, { onDelete: 'restrict' }),
    payloadFormatVersion: integer('payload_format_version').notNull(),
    payloadObjectSetVersion: integer('payload_object_set_version').notNull(),
    payloadSizeBytes: integer('payload_size_bytes').notNull(),
    payloadSha256: blob('payload_sha256', { mode: 'buffer' }).notNull(),
    operationStatus: text('operation_status').notNull(),
    providerReference: text('provider_reference'),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [
    unique('notification_operations_subscription_delivery_unique').on(
      table.notificationSubscriptionId,
      table.messageDeliveryId,
    ),
    index('notification_operations_work_index').on(
      table.operationStatus,
      table.createdAt,
      table.id,
    ),
    index('notification_operations_subscription_index').on(
      table.notificationSubscriptionId,
      table.createdAt,
      table.id,
    ),
  ],
)

export const notificationAttempts = sqliteTable(
  'notification_attempts',
  {
    id: text('id').primaryKey().notNull(),
    notificationOperationId: text('notification_operation_id')
      .notNull()
      .references(() => notificationOperations.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    attemptStatus: text('attempt_status').notNull(),
    httpStatus: integer('http_status'),
    providerReference: text('provider_reference'),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('notification_attempts_operation_number_unique').on(
      table.notificationOperationId,
      table.attemptNumber,
    ),
    index('notification_attempts_operation_index').on(
      table.notificationOperationId,
      table.attemptNumber,
    ),
  ],
)
