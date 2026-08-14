import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core'

export const backupRuns = sqliteTable(
  'backup_runs',
  {
    id: text('id').primaryKey().notNull(),
    backupFormatVersion: integer('backup_format_version').notNull(),
    migrationVersion: text('migration_version').notNull(),
    storageMode: text('storage_mode').notNull(),
    encryptionMode: text('encryption_mode').notNull(),
    encryptionFormat: text('encryption_format'),
    kdfName: text('kdf_name'),
    backupStatus: text('backup_status').notNull(),
    tableCount: integer('table_count').notNull().default(0),
    objectCount: integer('object_count').notNull().default(0),
    totalBytes: integer('total_bytes').notNull().default(0),
    manifestSha256: blob('manifest_sha256', { mode: 'buffer' }),
    lastErrorCode: text('last_error_code'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('backup_runs_status_index').on(table.backupStatus, table.createdAt, table.id)],
)

export const backupCheckpoints = sqliteTable(
  'backup_checkpoints',
  {
    id: text('id').primaryKey().notNull(),
    backupRunId: text('backup_run_id')
      .notNull()
      .references(() => backupRuns.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').notNull(),
    sourceName: text('source_name').notNull(),
    cursorValue: text('cursor_value'),
    scannedCount: integer('scanned_count').notNull().default(0),
    writtenCount: integer('written_count').notNull().default(0),
    writtenBytes: integer('written_bytes').notNull().default(0),
    checkpointStatus: text('checkpoint_status').notNull(),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('backup_checkpoints_run_source_unique').on(
      table.backupRunId,
      table.sourceKind,
      table.sourceName,
    ),
    index('backup_checkpoints_run_status_index').on(
      table.backupRunId,
      table.checkpointStatus,
      table.sourceKind,
      table.sourceName,
    ),
  ],
)

export const backupManifestEntries = sqliteTable(
  'backup_manifest_entries',
  {
    id: text('id').primaryKey().notNull(),
    backupRunId: text('backup_run_id')
      .notNull()
      .references(() => backupRuns.id, { onDelete: 'cascade' }),
    entryKind: text('entry_kind').notNull(),
    logicalKey: text('logical_key').notNull(),
    rowCount: integer('row_count'),
    sizeBytes: integer('size_bytes'),
    contentSha256: blob('content_sha256', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('backup_manifest_entries_run_key_unique').on(
      table.backupRunId,
      table.entryKind,
      table.logicalKey,
    ),
    index('backup_manifest_entries_run_index').on(
      table.backupRunId,
      table.entryKind,
      table.logicalKey,
    ),
  ],
)

export const backupRequiredKeyVersions = sqliteTable(
  'backup_required_key_versions',
  {
    backupRunId: text('backup_run_id')
      .notNull()
      .references(() => backupRuns.id, { onDelete: 'cascade' }),
    keyPurpose: text('key_purpose').notNull(),
    keyVersion: integer('key_version').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.backupRunId, table.keyPurpose, table.keyVersion] })],
)

export const restoreRuns = sqliteTable(
  'restore_runs',
  {
    id: text('id').primaryKey().notNull(),
    sourceBackupReference: text('source_backup_reference').notNull(),
    sourceManifestSha256: blob('source_manifest_sha256', { mode: 'buffer' }).notNull(),
    targetMode: text('target_mode').notNull(),
    maintenanceModeEnabled: integer('maintenance_mode_enabled', { mode: 'boolean' }).notNull(),
    preRestoreBackupReference: text('pre_restore_backup_reference'),
    overwriteConfirmationDigest: blob('overwrite_confirmation_digest', { mode: 'buffer' }),
    restoreStatus: text('restore_status').notNull(),
    currentStage: text('current_stage').notNull(),
    lastErrorCode: text('last_error_code'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('restore_runs_status_index').on(table.restoreStatus, table.createdAt, table.id),
  ],
)

export const restoreCheckpoints = sqliteTable(
  'restore_checkpoints',
  {
    id: text('id').primaryKey().notNull(),
    restoreRunId: text('restore_run_id')
      .notNull()
      .references(() => restoreRuns.id, { onDelete: 'cascade' }),
    stageKind: text('stage_kind').notNull(),
    cursorValue: text('cursor_value'),
    processedCount: integer('processed_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    checkpointStatus: text('checkpoint_status').notNull(),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('restore_checkpoints_run_stage_unique').on(table.restoreRunId, table.stageKind),
  ],
)

export const restoreChecks = sqliteTable(
  'restore_checks',
  {
    id: text('id').primaryKey().notNull(),
    restoreRunId: text('restore_run_id')
      .notNull()
      .references(() => restoreRuns.id, { onDelete: 'cascade' }),
    checkKind: text('check_kind').notNull(),
    checkStatus: text('check_status').notNull(),
    expectedCount: integer('expected_count'),
    actualCount: integer('actual_count'),
    failureCode: text('failure_code'),
    checkedAt: integer('checked_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [unique('restore_checks_run_kind_unique').on(table.restoreRunId, table.checkKind)],
)
