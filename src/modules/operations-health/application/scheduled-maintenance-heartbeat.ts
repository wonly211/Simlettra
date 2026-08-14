export interface ScheduledMaintenanceRun {
  id: string
  runReference: string
  startedAt: number
}

export async function startScheduledMaintenanceRun(options: {
  database: D1Database
  runReference?: string
  now?: number
}): Promise<ScheduledMaintenanceRun> {
  const now = options.now ?? Date.now()
  const run: ScheduledMaintenanceRun = {
    id: crypto.randomUUID(),
    runReference: options.runReference ?? crypto.randomUUID(),
    startedAt: now,
  }
  await options.database
    .prepare(
      `INSERT INTO scheduled_maintenance_runs (
         id, run_reference, run_status, current_step,
         error_code, error_summary, started_at, completed_at, created_at, updated_at
       ) VALUES (?1, ?2, 'running', 'starting', NULL, NULL, ?3, NULL, ?3, ?3)`,
    )
    .bind(run.id, run.runReference, now)
    .run()
  return run
}

export async function completeScheduledMaintenanceRun(options: {
  database: D1Database
  run: ScheduledMaintenanceRun
  now?: number
}): Promise<void> {
  const now = options.now ?? Date.now()
  const result = await options.database
    .prepare(
      `UPDATE scheduled_maintenance_runs
       SET run_status = 'succeeded', current_step = 'completed', completed_at = ?1, updated_at = ?1
       WHERE id = ?2 AND run_reference = ?3 AND run_status = 'running'`,
    )
    .bind(now, options.run.id, options.run.runReference)
    .run()
  if (result.meta.changes !== 1) throw new Error('定时维护运行状态已经发生变化')
}

export async function failScheduledMaintenanceRun(options: {
  database: D1Database
  run: ScheduledMaintenanceRun
  step: string
  now?: number
}): Promise<void> {
  const now = options.now ?? Date.now()
  const safeStep = normalizeStep(options.step)
  const result = await options.database
    .prepare(
      `UPDATE scheduled_maintenance_runs
       SET run_status = 'failed', current_step = ?1,
           error_code = ?2, error_summary = ?3,
           completed_at = ?4, updated_at = ?4
       WHERE id = ?5 AND run_reference = ?6 AND run_status = 'running'`,
    )
    .bind(
      safeStep,
      `scheduled_${safeStep}_failed`,
      `定时维护在 ${scheduledMaintenanceStepLabel(safeStep)} 步骤失败`,
      now,
      options.run.id,
      options.run.runReference,
    )
    .run()
  if (result.meta.changes !== 1) throw new Error('定时维护运行状态已经发生变化')
}

function normalizeStep(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : 'unknown'
}

function scheduledMaintenanceStepLabel(step: string): string {
  return (
    {
      expired_mailbox_trash: '清理到期垃圾箱',
      pending_search_tasks: '补建搜索任务',
      pending_conversation_tasks: '补建会话任务',
      pending_organization_cleanup: '补建组织清理任务',
      due_background_tasks: '补投后台任务',
      platform_resources: '刷新资源用量',
      platform_capacity_reservations: '释放平台容量预留',
      logical_storage_reservations: '释放逻辑容量预留',
    }[step] ?? '未知维护'
  )
}
