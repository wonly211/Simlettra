import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core'
import { emailAddresses } from '../../addresses/infrastructure/schema'
import { users } from '../../identity/infrastructure/schema'
import { messages } from '../../mail-receiving/infrastructure/schema'

export const drafts = sqliteTable(
  'drafts',
  {
    id: text('id').primaryKey().notNull(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    senderAddressId: text('sender_address_id').references(() => emailAddresses.id, {
      onDelete: 'restrict',
    }),
    composeKind: text('compose_kind').notNull(),
    sourceMessageId: text('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    sourceReference: text('source_reference'),
    conflictParentDraftId: text('conflict_parent_draft_id'),
    currentRevisionNumber: integer('current_revision_number').notNull().default(1),
    trashedAt: integer('trashed_at'),
    trashDueAt: integer('trash_due_at'),
    consumedAt: integer('consumed_at'),
    deletingAt: integer('deleting_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('drafts_owner_list_index').on(table.ownerUserId, table.status, table.updatedAt, table.id),
    index('drafts_trash_expiry_index').on(table.trashDueAt, table.id),
  ],
)

export const draftContents = sqliteTable('draft_contents', {
  draftId: text('draft_id')
    .primaryKey()
    .notNull()
    .references(() => drafts.id, { onDelete: 'cascade' }),
  revisionNumber: integer('revision_number').notNull(),
  subject: text('subject').notNull().default(''),
  bodyFormat: text('body_format').notNull(),
  bodyContentGeneration: integer('body_content_generation').notNull(),
  contentDigest: blob('content_digest', { mode: 'buffer' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const draftRecipients = sqliteTable(
  'draft_recipients',
  {
    id: text('id').primaryKey().notNull(),
    draftId: text('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    revisionNumber: integer('revision_number').notNull(),
    recipientRole: text('recipient_role').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    displayName: text('display_name'),
    addressText: text('address_text').notNull(),
    canonicalAddress: text('canonical_address'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('draft_recipients_role_sequence_unique').on(
      table.draftId,
      table.recipientRole,
      table.sequenceNumber,
    ),
  ],
)

export const draftAttachments = sqliteTable(
  'draft_attachments',
  {
    id: text('id').primaryKey().notNull(),
    draftId: text('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    revisionNumber: integer('revision_number').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    untrustedFileName: text('untrusted_file_name').notNull(),
    mediaType: text('media_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentSha256: blob('content_sha256', { mode: 'buffer' }).notNull(),
    contentGeneration: integer('content_generation').notNull(),
    integrityCheckedAt: integer('integrity_checked_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [unique('draft_attachments_sequence_unique').on(table.draftId, table.sequenceNumber)],
)

export const draftMutationKeys = sqliteTable(
  'draft_mutation_keys',
  {
    draftId: text('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    mutationKeyDigest: blob('mutation_key_digest', { mode: 'buffer' }).notNull(),
    inputDigest: blob('input_digest', { mode: 'buffer' }).notNull(),
    expectedRevisionNumber: integer('expected_revision_number').notNull(),
    resultKind: text('result_kind').notNull(),
    resultDraftId: text('result_draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    resultRevisionNumber: integer('result_revision_number').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.draftId, table.mutationKeyDigest] })],
)
