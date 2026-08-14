import { blob, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

export const cloudflareResourceConfigurations = sqliteTable('cloudflare_resource_configurations', {
  singletonId: integer('singleton_id').primaryKey().notNull(),
  accountId: text('account_id').notNull(),
  d1DatabaseId: text('d1_database_id').notNull(),
  storageResourceReference: text('storage_resource_reference').notNull(),
  apiTokenCiphertext: blob('api_token_ciphertext', { mode: 'buffer' }).notNull(),
  apiTokenNonce: blob('api_token_nonce', { mode: 'buffer' }).notNull(),
  credentialAlgorithm: text('credential_algorithm').notNull(),
  credentialKeyVersion: integer('credential_key_version').notNull(),
  configurationVersion: integer('configuration_version').notNull(),
  configurationStatus: text('configuration_status').notNull(),
  lastTestedAt: integer('last_tested_at'),
  lastTestResult: text('last_test_result'),
  lastTestSummary: text('last_test_summary'),
  deletedAt: integer('deleted_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const platformResourceThresholds = sqliteTable(
  'platform_resource_thresholds',
  {
    id: text('id').primaryKey().notNull(),
    resourceKind: text('resource_kind').notNull(),
    thresholdVersion: integer('threshold_version').notNull(),
    warningRatioBps: integer('warning_ratio_bps').notNull(),
    stopRatioBps: integer('stop_ratio_bps').notNull(),
    thresholdStatus: text('threshold_status').notNull(),
    effectiveAt: integer('effective_at').notNull(),
    retiredAt: integer('retired_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('platform_resource_thresholds_kind_version_unique').on(
      table.resourceKind,
      table.thresholdVersion,
    ),
  ],
)

export const platformResourceSnapshots = sqliteTable(
  'platform_resource_snapshots',
  {
    id: text('id').primaryKey().notNull(),
    resourceKind: text('resource_kind').notNull(),
    scopeKind: text('scope_kind').notNull(),
    scopeReference: text('scope_reference').notNull(),
    freeLimitBytes: integer('free_limit_bytes').notNull(),
    currentResourceLimitBytes: integer('current_resource_limit_bytes').notNull(),
    accountUsedBytes: integer('account_used_bytes'),
    simlettraUsedBytes: integer('simlettra_used_bytes'),
    remainingBytes: integer('remaining_bytes'),
    currentResourceRemainingBytes: integer('current_resource_remaining_bytes'),
    itemCount: integer('item_count'),
    dataSource: text('data_source').notNull(),
    fetchStatus: text('fetch_status').notNull(),
    observedAt: integer('observed_at'),
    fetchedAt: integer('fetched_at').notNull(),
    errorCode: text('error_code'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('platform_resource_snapshots_latest_drizzle_index').on(
      table.resourceKind,
      table.fetchedAt,
      table.id,
    ),
  ],
)

export const platformCapacityReservations = sqliteTable(
  'platform_capacity_reservations',
  {
    id: text('id').primaryKey().notNull(),
    platformResourceSnapshotId: text('platform_resource_snapshot_id')
      .notNull()
      .references(() => platformResourceSnapshots.id),
    platformResourceThresholdId: text('platform_resource_threshold_id')
      .notNull()
      .references(() => platformResourceThresholds.id),
    resourceKind: text('resource_kind').notNull(),
    operationKind: text('operation_kind').notNull(),
    operationReference: text('operation_reference').notNull(),
    estimatedBytes: integer('estimated_bytes').notNull(),
    safetyMarginBytes: integer('safety_margin_bytes').notNull(),
    stopLimitBytesSnapshot: integer('stop_limit_bytes_snapshot').notNull(),
    currentResourceStopLimitBytesSnapshot: integer(
      'current_resource_stop_limit_bytes_snapshot',
    ).notNull(),
    reservationKeyDigest: blob('reservation_key_digest', { mode: 'buffer' }).notNull(),
    reservationStatus: text('reservation_status').notNull(),
    expiresAt: integer('expires_at').notNull(),
    committedAt: integer('committed_at'),
    reconciledAt: integer('reconciled_at'),
    releasedAt: integer('released_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('platform_capacity_reservations_key_unique').on(table.reservationKeyDigest),
    index('platform_capacity_reservations_work_drizzle_index').on(
      table.resourceKind,
      table.reservationStatus,
      table.expiresAt,
    ),
  ],
)
