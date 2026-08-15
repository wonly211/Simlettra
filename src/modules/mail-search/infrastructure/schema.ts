import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { messages } from '../../mail-receiving/infrastructure/schema'

export const messageSearchStates = sqliteTable(
  'message_search_states',
  {
    messageId: text('message_id')
      .primaryKey()
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    objectSetVersion: integer('object_set_version').notNull(),
    indexGeneration: integer('index_generation').notNull(),
    indexStatus: text('index_status').notNull(),
    chunkCount: integer('chunk_count').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    indexedAt: integer('indexed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('message_search_states_work_index').on(
      table.indexStatus,
      table.updatedAt,
      table.messageId,
    ),
    check('message_search_states_object_version_check', sql`${table.objectSetVersion} >= 1`),
    check('message_search_states_generation_check', sql`${table.indexGeneration} >= 1`),
  ],
)

export const messageSearchChunks = sqliteTable(
  'message_search_chunks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    indexGeneration: integer('index_generation').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('message_search_chunks_message_generation_chunk_unique').on(
      table.messageId,
      table.indexGeneration,
      table.chunkIndex,
    ),
    index('message_search_chunks_message_index').on(
      table.messageId,
      table.indexGeneration,
      table.chunkIndex,
      table.id,
    ),
  ],
)
