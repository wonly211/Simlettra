import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createMailObjectStore } from '../../src/modules/mail-receiving/public'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'
import { processSystemBackupTask } from '../../src/modules/backups/public'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type {
  CreateSystemBackupResponse,
  SystemBackupOverviewResponse,
} from '../../src/shared/contracts/system-backups'

interface TestEnvironment extends Env {
  INIT_KEY: string
  TASK_QUEUE: Queue<BackgroundTaskMessage>
  MAIL_OBJECTS_R2: R2Bucket
}

const testEnvironment = env as TestEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'

describe('管理员本地备份清单', { timeout: 60_000 }, () => {
  it('未登录不能读取或创建备份', async () => {
    const overview = await request('/api/auth/admin/backups')
    expect(overview.status).toBe(401)

    const created = await jsonRequest('/api/auth/admin/backups', {
      method: 'POST',
      headers: { Origin: origin },
      body: {},
    })
    expect(created.status).toBe(401)
  })

  it('管理员可以分批生成清单，空表进入清单且不新增云端备份对象', async () => {
    await initializeSystem()
    const session = extractCookies(await login())
    const before = await testEnvironment.MAIL_OBJECTS_R2.list()

    const created = await jsonRequest('/api/auth/admin/backups', {
      method: 'POST',
      headers: mutationHeaders(session),
      body: {},
    })
    expect(created.status).toBe(202)
    const createdPayload = await created.json<CreateSystemBackupResponse>()
    const backupId = createdPayload.data.backup.id
    expect(createdPayload.data.backup.status).toBe('planned')

    await processBackupUntilDone(backupId)

    const overview = await request('/api/auth/admin/backups', {
      headers: { Cookie: session.cookie },
    })
    expect(overview.status).toBe(200)
    const overviewPayload = await overview.json<SystemBackupOverviewResponse>()
    const backup = overviewPayload.data.backups.find((item) => item.id === backupId)
    expect(backup).toMatchObject({ status: 'succeeded', tableCount: expect.any(Number) })
    expect(backup!.tableCount).toBeGreaterThan(0)

    const after = await testEnvironment.MAIL_OBJECTS_R2.list()
    expect(after.objects.length).toBe(before.objects.length)

    const manifestResponse = await request(`/api/auth/admin/backups/${backupId}/manifest`, {
      headers: { Cookie: session.cookie },
    })
    expect(manifestResponse.status).toBe(200)
    const manifest = await manifestResponse.json<{
      product: string
      migrationVersion: string
      entries: Array<{ id: string; kind: string; logicalKey: string; sizeBytes: number }>
    }>()
    expect(manifest.product).toBe('澄笺 | Simlettra')
    expect(manifest.migrationVersion).toBe('0025-补齐早期内部投递容量拒绝事实.sql')
    expect(manifest.entries.some((entry) => entry.logicalKey.startsWith('users/'))).toBe(true)

    const userEntry = await env.DB.prepare(
      `SELECT id FROM backup_manifest_entries
       WHERE backup_run_id = ?1 AND entry_kind = 'd1_table' AND logical_key LIKE 'users/%'
       ORDER BY logical_key LIMIT 1`,
    )
      .bind(backupId)
      .first<{ id: string }>()
    expect(userEntry).not.toBeNull()
    const part = await request(`/api/auth/admin/backups/${backupId}/parts/${userEntry!.id}`, {
      headers: { Cookie: session.cookie },
    })
    expect(part.status).toBe(200)
    expect(part.headers.get('content-type')).toContain('application/x-ndjson')
    expect((await part.arrayBuffer()).byteLength).toBeGreaterThan(0)

    await env.DB.prepare(
      `UPDATE users SET display_name = '来源变化' WHERE id = (SELECT current_admin_user_id FROM system_instances WHERE singleton_id = 1)`,
    ).run()
    const changedPart = await request(
      `/api/auth/admin/backups/${backupId}/parts/${userEntry!.id}`,
      {
        headers: { Cookie: session.cookie },
      },
    )
    expect(changedPart.status).toBe(409)
    await expect(changedPart.json()).resolves.toMatchObject({
      error: { code: 'source_changed' },
    })
  })
})

async function initializeSystem() {
  const response = await jsonRequest('/api/initialization/complete', {
    method: 'POST',
    headers: {
      'X-Simlettra-Init-Key': encodeInitializationKeyHeader(testEnvironment.INIT_KEY),
    },
    body: {
      adminDisplayName: '系统管理员',
      domainName: 'example.com',
      localPart: 'owner',
      password,
      timezone: 'Asia/Shanghai',
    },
  })
  expect(response.status).toBe(201)
}

function login() {
  return jsonRequest('/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin },
    body: { email: 'owner@example.com', password },
  })
}

async function processBackupUntilDone(backupId: string) {
  const store = createMailObjectStore(testEnvironment, 'r2')
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await env.DB.prepare(`SELECT backup_status FROM backup_runs WHERE id = ?1`)
      .bind(backupId)
      .first<{ backup_status: string }>()
    if (status?.backup_status === 'succeeded') return
    if (status?.backup_status === 'failed') throw new Error('备份任务失败')
    const task = await env.DB.prepare(
      `SELECT id, input_version, next_attempt_at FROM background_tasks
       WHERE task_type = 'generate_system_backup' AND target_reference = ?1
         AND task_status IN ('pending', 'retry_wait')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
      .bind(backupId)
      .first<{ id: string; input_version: number; next_attempt_at: number | null }>()
    if (!task) throw new Error('备份任务检查点不存在')
    await processBackgroundTaskMessage({
      database: env.DB,
      message: { taskId: task.id, inputVersion: task.input_version },
      workerReference: `backup-test-${attempt}`,
      now: Math.max(Date.now(), task.next_attempt_at ?? Date.now()),
      executeTask: (context) =>
        processSystemBackupTask({
          database: env.DB,
          objectStore: store,
          storageMode: 'r2',
          backupRunId: context.targetReference,
          now: context.now,
        }),
    })
  }
  throw new Error('备份任务超过测试步数上限')
}

function request(path: string, init?: RequestInit) {
  return workerExports.default.fetch(new Request(`${origin}${path}`, init))
}

function jsonRequest(
  path: string,
  options: { method: string; headers?: Record<string, string>; body: object },
) {
  return request(path, {
    method: options.method,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify(options.body),
  })
}

function extractCookies(response: Response) {
  const header = response.headers.get('set-cookie') ?? ''
  const session = new RegExp(`${SESSION_COOKIE_NAME}=([^;,]+)`).exec(header)?.[1] ?? ''
  const csrf = new RegExp(`${CSRF_COOKIE_NAME}=([^;,]+)`).exec(header)?.[1] ?? ''
  return { cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`, csrf }
}

function mutationHeaders(session: ReturnType<typeof extractCookies>) {
  return {
    Cookie: session.cookie,
    Origin: origin,
    [CSRF_HEADER_NAME]: session.csrf,
  }
}
