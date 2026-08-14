import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { users } from '../../identity/infrastructure/schema'

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey().notNull(),
    occurredAt: integer('occurred_at').notNull(),
    actorType: text('actor_type').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actionName: text('action_name').notNull(),
    targetType: text('target_type').notNull(),
    targetReference: text('target_reference').notNull(),
    outcome: text('outcome').notNull(),
    reasonCode: text('reason_code'),
    requestTraceId: text('request_trace_id').notNull(),
    sourceIpText: text('source_ip_text'),
    browserFamily: text('browser_family'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('audit_events_time_index').on(table.occurredAt, table.id),
    index('audit_events_target_index').on(
      table.targetType,
      table.targetReference,
      table.occurredAt,
      table.id,
    ),
    check(
      'audit_events_actor_type_check',
      sql`${table.actorType} in ('user', 'system', 'deleted_user')`,
    ),
    check('audit_events_action_name_check', sql`length(${table.actionName}) > 0`),
    check('audit_events_target_type_check', sql`length(${table.targetType}) > 0`),
    check('audit_events_target_reference_check', sql`length(${table.targetReference}) > 0`),
    check('audit_events_outcome_check', sql`${table.outcome} in ('succeeded', 'failed', 'denied')`),
    check('audit_events_request_trace_check', sql`length(${table.requestTraceId}) > 0`),
    check(
      'audit_events_actor_reference_check',
      sql`(${table.actorType} = 'user' and ${table.actorUserId} is not null)
        or ${table.actorType} in ('system', 'deleted_user')`,
    ),
  ],
)
