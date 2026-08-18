import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'

describe('后台任务重试收口', () => {
  it('显式重试达到最大次数时立即进入需要检查，不留下永久 retry_wait', async () => {
    const taskId = crypto.randomUUID()
    const startedAt = Date.now()
    await insertRetryTask(taskId, startedAt)
    const message: BackgroundTaskMessage = { taskId, inputVersion: 1 }

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const now = startedAt + attempt * 10
      await processBackgroundTaskMessage({
        database: env.DB,
        message,
        workerReference: `retry-test-${attempt}`,
        now,
        executeTask: async () => ({
          status: 'retry',
          nextAttemptAt: now + 1,
          errorCode: 'temporary_dependency_unavailable',
        }),
      })
    }

    await expect(readTask(taskId)).resolves.toMatchObject({
      task_status: 'needs_attention',
      attempt_count: 5,
      last_error_code: 'temporary_dependency_unavailable',
    })
    await processBackgroundTaskMessage({
      database: env.DB,
      message,
      workerReference: 'retry-test-sixth',
      now: startedAt + 100,
      executeTask: async () => ({ status: 'succeeded' }),
    })
    await expect(readTask(taskId)).resolves.toMatchObject({
      task_status: 'needs_attention',
      attempt_count: 5,
    })
  })

  it('升级前已经耗尽次数的 retry_wait 任务会自动收口为需要检查', async () => {
    const taskId = crypto.randomUUID()
    const now = Date.now()
    await insertRetryTask(taskId, now - 1_000)
    await transitionToExhaustedRetryWait(taskId, now - 900)
    await env.DB.prepare(`UPDATE background_tasks SET next_attempt_at = ?1 WHERE id = ?2`)
      .bind(now + 60_000, taskId)
      .run()

    await expect(
      processBackgroundTaskMessage({
        database: env.DB,
        message: { taskId, inputVersion: 1 },
        workerReference: 'legacy-exhausted-task',
        now,
        executeTask: async () => ({ status: 'succeeded' }),
      }),
    ).resolves.toBe('completed')
    await expect(readTask(taskId)).resolves.toMatchObject({
      task_status: 'needs_attention',
      attempt_count: 5,
      last_error_code: 'temporary_dependency_unavailable',
    })
  })
})

async function insertRetryTask(id: string, nextAttemptAt: number) {
  await env.DB.prepare(
    `INSERT INTO background_tasks (
       id, task_type, target_type, target_reference, input_version,
       task_key_digest, task_status, priority, attempt_count, max_attempts,
       next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
       last_error_code, last_error_summary, last_error_at, completed_at,
       created_at, updated_at
     ) VALUES (
       ?1, 'test_retry', 'test_target', ?1, 1,
       zeroblob(32), 'pending', 1, 0, 5,
       ?2, NULL, 0, NULL,
       NULL, NULL, NULL, NULL,
       ?2, ?2
     )`,
  )
    .bind(id, nextAttemptAt)
    .run()
}

async function transitionToExhaustedRetryWait(id: string, baseTime: number) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const runningAt = baseTime + attempt * 10
    const workerReference = `legacy-worker-${attempt}`
    await env.DB.prepare(
      `UPDATE background_tasks
       SET task_status = 'running', attempt_count = ?1,
           next_attempt_at = NULL, lease_owner_reference = ?2,
           lease_token = ?1, lease_expires_at = ?3, updated_at = ?4
       WHERE id = ?5`,
    )
      .bind(attempt, workerReference, runningAt + 5, runningAt, id)
      .run()
    await env.DB.prepare(
      `UPDATE background_tasks
       SET task_status = 'retry_wait', next_attempt_at = ?1,
           lease_owner_reference = NULL, lease_expires_at = NULL,
           last_error_code = 'temporary_dependency_unavailable',
           last_error_summary = '历史任务等待重试',
           last_error_at = ?1, updated_at = ?1
       WHERE id = ?2`,
    )
      .bind(runningAt + 1, id)
      .run()
  }
}

function readTask(id: string) {
  return env.DB.prepare(
    `SELECT task_status, attempt_count, last_error_code
     FROM background_tasks WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      task_status: string
      attempt_count: number
      last_error_code: string | null
    }>()
}
