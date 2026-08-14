import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from '../../identity/infrastructure/schema'
import { mailboxEntries, messages } from '../../mail-receiving/infrastructure/schema'
import { organizations } from '../../organizations/infrastructure/schema'

export const messageRelations = sqliteTable(
  'message_relations',
  {
    id: text('id').primaryKey().notNull(),
    childMessageId: text('child_message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    relationType: text('relation_type').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    targetReference: text('target_reference').notNull(),
    targetMessageId: text('target_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('message_relations_child_type_sequence_unique').on(
      table.childMessageId,
      table.relationType,
      table.sequenceNumber,
    ),
    index('message_relations_target_reference_index').on(
      table.targetReference,
      table.childMessageId,
    ),
    index('message_relations_target_message_index').on(table.targetMessageId, table.childMessageId),
  ],
)

export const mailboxConversations = sqliteTable(
  'mailbox_conversations',
  {
    id: text('id').primaryKey().notNull(),
    mailboxType: text('mailbox_type').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    rootReference: text('root_reference').notNull(),
    latestAt: integer('latest_at').notNull(),
    rebuiltAt: integer('rebuilt_at').notNull(),
  },
  (table) => [
    uniqueIndex('mailbox_conversations_user_root_unique')
      .on(table.userId, table.rootReference)
      .where(sql`${table.mailboxType} = 'user'`),
    uniqueIndex('mailbox_conversations_organization_root_unique')
      .on(table.organizationId, table.rootReference)
      .where(sql`${table.mailboxType} = 'organization'`),
    index('mailbox_conversations_user_list_index').on(table.userId, table.latestAt, table.id),
    index('mailbox_conversations_organization_list_index').on(
      table.organizationId,
      table.latestAt,
      table.id,
    ),
  ],
)

export const mailboxConversationEntries = sqliteTable(
  'mailbox_conversation_entries',
  {
    mailboxEntryId: text('mailbox_entry_id')
      .primaryKey()
      .notNull()
      .references(() => mailboxEntries.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => mailboxConversations.id, { onDelete: 'cascade' }),
    sortAt: integer('sort_at').notNull(),
    linkedAt: integer('linked_at').notNull(),
  },
  (table) => [
    index('mailbox_conversation_entries_conversation_index').on(
      table.conversationId,
      table.sortAt,
      table.mailboxEntryId,
    ),
  ],
)
