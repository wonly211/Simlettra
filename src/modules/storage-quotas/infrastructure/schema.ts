import { blob, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { users } from '../../identity/infrastructure/schema'
import { organizations } from '../../organizations/infrastructure/schema'

export const logicalStorageQuotaPolicies = sqliteTable(
  'logical_storage_quota_policies',
  {
    id: text('id').primaryKey().notNull(),
    storageMode: text('storage_mode').notNull(),
    ownerType: text('owner_type').notNull(),
    defaultOwnerType: text('default_owner_type'),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    policyVersion: integer('policy_version').notNull(),
    limitBytes: integer('limit_bytes').notNull(),
    policyStatus: text('policy_status').notNull(),
    effectiveAt: integer('effective_at').notNull(),
    retiredAt: integer('retired_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('logical_storage_quota_policies_identity_unique').on(
      table.storageMode,
      table.ownerType,
      table.defaultOwnerType,
      table.userId,
      table.organizationId,
      table.policyVersion,
    ),
  ],
)

export const logicalStorageUsageAccounts = sqliteTable(
  'logical_storage_usage_accounts',
  {
    id: text('id').primaryKey().notNull(),
    storageMode: text('storage_mode').notNull(),
    ownerType: text('owner_type').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    committedBytes: integer('committed_bytes').notNull(),
    reservedBytes: integer('reserved_bytes').notNull(),
    usageVersion: integer('usage_version').notNull(),
    reconciledAt: integer('reconciled_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('logical_storage_usage_accounts_owner_index').on(
      table.storageMode,
      table.ownerType,
      table.userId,
      table.organizationId,
    ),
  ],
)

export const logicalStorageReservations = sqliteTable(
  'logical_storage_reservations',
  {
    id: text('id').primaryKey().notNull(),
    storageUsageAccountId: text('storage_usage_account_id')
      .notNull()
      .references(() => logicalStorageUsageAccounts.id, { onDelete: 'cascade' }),
    quotaPolicyId: text('quota_policy_id')
      .notNull()
      .references(() => logicalStorageQuotaPolicies.id),
    operationKind: text('operation_kind').notNull(),
    operationReference: text('operation_reference').notNull(),
    reservedBytes: integer('reserved_bytes').notNull(),
    limitBytesSnapshot: integer('limit_bytes_snapshot').notNull(),
    reservationKeyDigest: blob('reservation_key_digest', { mode: 'buffer' }).notNull(),
    reservationStatus: text('reservation_status').notNull(),
    expiresAt: integer('expires_at').notNull(),
    committedAt: integer('committed_at'),
    releasedAt: integer('released_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('logical_storage_reservations_key_unique').on(table.reservationKeyDigest),
    index('logical_storage_reservations_work_index').on(
      table.reservationStatus,
      table.expiresAt,
      table.storageUsageAccountId,
    ),
  ],
)

export const logicalStorageUsageEntries = sqliteTable(
  'logical_storage_usage_entries',
  {
    id: text('id').primaryKey().notNull(),
    storageUsageAccountId: text('storage_usage_account_id')
      .notNull()
      .references(() => logicalStorageUsageAccounts.id, { onDelete: 'cascade' }),
    storageReservationId: text('storage_reservation_id').references(
      () => logicalStorageReservations.id,
      { onDelete: 'set null' },
    ),
    entryKind: text('entry_kind').notNull(),
    ownerReference: text('owner_reference').notNull(),
    bytesDelta: integer('bytes_delta').notNull(),
    idempotencyKeyDigest: blob('idempotency_key_digest', { mode: 'buffer' }).notNull(),
    committedAt: integer('committed_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('logical_storage_usage_entries_key_unique').on(table.idempotencyKeyDigest),
    index('logical_storage_usage_entries_owner_index').on(
      table.storageUsageAccountId,
      table.committedAt,
      table.id,
    ),
  ],
)

export const internalDeliveryRejections = sqliteTable(
  'internal_delivery_rejections',
  {
    id: text('id').primaryKey().notNull(),
    sendOperationId: text('send_operation_id').notNull(),
    recipientRole: text('recipient_role').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    addressText: text('address_text').notNull(),
    canonicalAddress: text('canonical_address').notNull(),
    ownerType: text('owner_type').notNull(),
    userId: text('user_id').references(() => users.id),
    organizationId: text('organization_id').references(() => organizations.id),
    failureCode: text('failure_code').notNull(),
    failureDetail: text('failure_detail').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('internal_delivery_rejections_sequence_unique').on(
      table.sendOperationId,
      table.recipientRole,
      table.sequenceNumber,
    ),
    index('internal_delivery_rejections_operation_drizzle_index').on(
      table.sendOperationId,
      table.recipientRole,
      table.sequenceNumber,
    ),
  ],
)
