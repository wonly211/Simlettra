import { blob, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { users } from '../../identity/infrastructure/schema'

export const exportRuns = sqliteTable(
  'export_runs',
  {
    id: text('id').primaryKey().notNull(),
    requestedByUserId: text('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    scopeType: text('scope_type').notNull(),
    organizationId: text('organization_id'),
    scopeDigest: blob('scope_digest', { mode: 'buffer' }).notNull(),
    frozenMessageCount: integer('frozen_message_count').notNull(),
    outputFormat: text('output_format').notNull().default('zip_eml'),
    exportStatus: text('export_status').notNull(),
    artifactCount: integer('artifact_count').notNull().default(0),
    completedAt: integer('completed_at'),
    expiresAt: integer('expires_at').notNull(),
    deletedAt: integer('deleted_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('export_runs_requester_index').on(table.requestedByUserId, table.createdAt, table.id),
    index('export_runs_expiry_index').on(table.exportStatus, table.expiresAt, table.id),
  ],
)

export const exportItems = sqliteTable(
  'export_items',
  {
    id: text('id').primaryKey().notNull(),
    exportRunId: text('export_run_id')
      .notNull()
      .references(() => exportRuns.id, { onDelete: 'cascade' }),
    mailboxEntryId: text('mailbox_entry_id').notNull(),
    messageId: text('message_id').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    sourceQuality: text('source_quality').notNull(),
    sourceObjectId: text('source_object_id'),
    itemStatus: text('item_status').notNull(),
    artifactSequenceNumber: integer('artifact_sequence_number'),
    outputFileName: text('output_file_name'),
    outputSizeBytes: integer('output_size_bytes'),
    outputSha256: blob('output_sha256', { mode: 'buffer' }),
    errorCode: text('error_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('export_items_run_sequence_unique').on(table.exportRunId, table.sequenceNumber),
    unique('export_items_run_entry_unique').on(table.exportRunId, table.mailboxEntryId),
    unique('export_items_run_message_unique').on(table.exportRunId, table.messageId),
    index('export_items_run_status_index').on(
      table.exportRunId,
      table.itemStatus,
      table.sequenceNumber,
    ),
  ],
)

export const exportArtifacts = sqliteTable(
  'export_artifacts',
  {
    id: text('id').primaryKey().notNull(),
    exportRunId: text('export_run_id')
      .notNull()
      .references(() => exportRuns.id, { onDelete: 'cascade' }),
    sequenceNumber: integer('sequence_number').notNull(),
    objectKey: text('object_key').notNull().unique(),
    storageMode: text('storage_mode').notNull(),
    fileName: text('file_name').notNull(),
    mediaType: text('media_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: blob('sha256', { mode: 'buffer' }).notNull(),
    backendVersionReference: text('backend_version_reference'),
    artifactStatus: text('artifact_status').notNull(),
    storedAt: integer('stored_at').notNull(),
    activatedAt: integer('activated_at'),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('export_artifacts_run_sequence_unique').on(table.exportRunId, table.sequenceNumber),
    index('export_artifacts_run_index').on(
      table.exportRunId,
      table.artifactStatus,
      table.sequenceNumber,
    ),
  ],
)
