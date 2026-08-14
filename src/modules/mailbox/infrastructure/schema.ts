import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { users } from '../../identity/infrastructure/schema'
import { mailboxEntries } from '../../mail-receiving/infrastructure/schema'

export const mailboxUserStates = sqliteTable(
  'mailbox_user_states',
  {
    mailboxEntryId: text('mailbox_entry_id')
      .notNull()
      .references(() => mailboxEntries.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isRead: integer('is_read', { mode: 'boolean' }),
    isStarred: integer('is_starred', { mode: 'boolean' }),
    isArchived: integer('is_archived', { mode: 'boolean' }),
    locationOverride: text('location_override'),
    previousLocation: text('previous_location'),
    remoteImagesAllowed: integer('remote_images_allowed', { mode: 'boolean' }),
    trashedAt: integer('trashed_at'),
    trashDueAt: integer('trash_due_at'),
    hiddenAt: integer('hidden_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxEntryId, table.userId] }),
    index('mailbox_user_states_user_index').on(table.userId, table.mailboxEntryId),
    index('mailbox_user_states_unread_index').on(table.userId, table.isRead, table.mailboxEntryId),
    check(
      'mailbox_user_states_not_empty_check',
      sql`${table.isRead} is not null or ${table.isStarred} is not null or ${table.isArchived} is not null or ${table.locationOverride} is not null or ${table.remoteImagesAllowed} is not null`,
    ),
  ],
)

export const trustedSenderAddresses = sqliteTable(
  'trusted_sender_addresses',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canonicalSenderAddress: text('canonical_sender_address').notNull(),
    displaySenderAddress: text('display_sender_address').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.canonicalSenderAddress] }),
    check(
      'trusted_sender_addresses_address_check',
      sql`instr(${table.canonicalSenderAddress}, '@') > 1`,
    ),
  ],
)
