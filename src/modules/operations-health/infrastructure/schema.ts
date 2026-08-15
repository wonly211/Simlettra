import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const scheduledMaintenanceRuns = sqliteTable(
  'scheduled_maintenance_runs',
  {
    id: text('id').primaryKey().notNull(),
    runReference: text('run_reference').notNull().unique(),
    runStatus: text('run_status').notNull(),
    currentStep: text('current_step').notNull(),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
    startedAt: integer('started_at').notNull(),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('scheduled_maintenance_runs_latest_drizzle_index').on(table.startedAt, table.id),
    index('scheduled_maintenance_runs_status_drizzle_index').on(
      table.runStatus,
      table.startedAt,
      table.id,
    ),
  ],
)
