import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import {
  RECOVERY_CSRF_COOKIE_NAME,
  RECOVERY_CSRF_HEADER_NAME,
  RECOVERY_SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/user-lifecycle'
import type { CreateManagedUserResponse } from '../../src/shared/contracts/user-management'
import { processLifecycleCleanupTask } from '../../src/modules/identity/public'
import type { MailObjectStore } from '../../src/modules/mail-receiving/infrastructure/object-storage'

const testEnvironment = env as Env & { INIT_KEY: string }
const origin = 'https://simlettra.test'
const administratorEmail = 'owner@example.com'
const administratorPassword = '长河-Glass-47-Quiet'

describe('用户注销与恢复 HTTP 边界', { timeout: 45_000 }, () => {
  it('管理员转让后可以申请注销，并通过独立受限会话取消注销', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const successor = await createSuccessor(administrator)

    const blockedOverview = await request('/api/auth/account-lifecycle', {
      headers: administrator.headers,
    })
    expect(blockedOverview.status).toBe(200)
    await expect(blockedOverview.json()).resolves.toMatchObject({
      data: {
        canRequestDeletion: false,
        blockers: [{ code: 'administrator_transfer_required' }],
        recoveryDays: 7,
      },
    })

    const transferred = await jsonRequest('/api/auth/administrator/transfer', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { successorUserId: successor.userId },
    })
    expect(transferred.status).toBe(200)

    const deletion = await jsonRequest('/api/auth/account-deletion', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: {
        currentPassword: administratorPassword,
        confirmation: 'DELETE_MY_ACCOUNT',
      },
    })
    expect(deletion.status).toBe(200)
    await expect(deletion.json()).resolves.toMatchObject({
      data: { deletionRequested: true, revokedSessions: 1 },
    })
    expect((await request('/api/auth/session', { headers: administrator.headers })).status).toBe(
      401,
    )

    const recoveryLogin = await jsonRequest('/api/auth/account-recovery/login', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.202' },
      body: { email: administratorEmail, password: administratorPassword },
    })
    expect(recoveryLogin.status).toBe(200)
    const recovery = extractRecoveryCookies(recoveryLogin)

    expect(
      (
        await jsonRequest('/api/auth/account-recovery/cancel', {
          method: 'POST',
          headers: { Cookie: recovery.cookie },
        })
      ).status,
    ).toBe(403)

    const cancelled = await jsonRequest('/api/auth/account-recovery/cancel', {
      method: 'POST',
      headers: recoveryMutationHeaders(recovery),
    })
    expect(cancelled.status).toBe(200)
    await expect(cancelled.json()).resolves.toMatchObject({
      data: { deletionCancelled: true, restoredMemberships: 0 },
    })
    expect((await login('203.0.113.203')).status).toBe(200)

    const state = await env.DB.prepare(
      `SELECT users.status, operation.operation_status, task.task_status
       FROM users
       JOIN deletion_operations AS operation
         ON operation.target_reference = users.id AND operation.operation_kind = 'user_delete'
       JOIN background_tasks AS task
         ON task.target_reference = operation.id AND task.task_type = 'user_cleanup'
       WHERE users.id = ?1`,
    )
      .bind(successor.previousAdministratorUserId)
      .first<{ status: string; operation_status: string; task_status: string }>()
    expect(state).toEqual({
      status: 'active',
      operation_status: 'cancelled',
      task_status: 'cancelled',
    })
  })

  it('七天冷静期结束后分步任务永久清理账号并保留稳定占位', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const successor = await createSuccessor(administrator)
    await jsonRequest('/api/auth/administrator/transfer', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { successorUserId: successor.userId },
    })
    await jsonRequest('/api/auth/account-deletion', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: {
        currentPassword: administratorPassword,
        confirmation: 'DELETE_MY_ACCOUNT',
      },
    })

    const operation = await env.DB.prepare(
      `SELECT id, policy_version, recovery_due_at
       FROM deletion_operations
       WHERE operation_kind = 'user_delete' AND target_reference = ?1`,
    )
      .bind(successor.previousAdministratorUserId)
      .first<{ id: string; policy_version: number; recovery_due_at: number }>()
    if (!operation) throw new Error('缺少用户注销操作')

    await expect(
      processLifecycleCleanupTask({
        database: env.DB,
        objectStore: emptyObjectStore,
        deletionOperationId: operation.id,
        inputVersion: operation.policy_version,
        now: operation.recovery_due_at + 1,
      }),
    ).resolves.toEqual({ status: 'succeeded' })

    const user = await env.DB.prepare(
      `SELECT status, display_name, deleted_at FROM users WHERE id = ?1`,
    )
      .bind(successor.previousAdministratorUserId)
      .first<{ status: string; display_name: string; deleted_at: number | null }>()
    expect(user).toMatchObject({ status: 'deleted', display_name: '已删除用户' })
    expect(user?.deleted_at).toBe(operation.recovery_due_at + 1)
    expect((await login('203.0.113.204')).status).toBe(401)

    const cleanup = await env.DB.prepare(
      `SELECT operation_status FROM deletion_operations WHERE id = ?1`,
    )
      .bind(operation.id)
      .first<{ operation_status: string }>()
    expect(cleanup).toEqual({ operation_status: 'completed' })
  })
})

const emptyObjectStore: MailObjectStore = {
  mode: 'r2',
  async put() {
    return null
  },
  async get() {
    return null
  },
  async delete() {},
}

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
      password: administratorPassword,
      timezone: 'Asia/Shanghai',
    },
  })
  expect(response.status).toBe(201)
}

async function createSuccessor(administrator: ReturnType<typeof extractAuthenticationCookies>) {
  const previousAdministrator = await env.DB.prepare(
    'SELECT current_admin_user_id AS id FROM system_instances WHERE singleton_id = 1',
  ).first<{ id: string }>()
  const domain = await env.DB.prepare(
    "SELECT id FROM mail_domains WHERE canonical_name = 'example.com'",
  ).first<{ id: string }>()
  if (!previousAdministrator || !domain) throw new Error('测试初始化数据不完整')

  const response = await jsonRequest('/api/auth/administrator/users', {
    method: 'POST',
    headers: mutationHeaders(administrator),
    body: {
      displayName: '继任管理员',
      localPart: 'successor',
      domainId: domain.id,
      timezone: 'Asia/Shanghai',
    },
  })
  expect(response.status).toBe(201)
  const payload = await response.json<CreateManagedUserResponse>()
  return {
    userId: payload.data.user.id,
    previousAdministratorUserId: previousAdministrator.id,
  }
}

function login(source: string = '203.0.113.201') {
  return jsonRequest('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': source,
      'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
    },
    body: { email: administratorEmail, password: administratorPassword },
  })
}

function request(path: string, init?: RequestInit) {
  return workerExports.default.fetch(new Request(`${origin}${path}`, init))
}

function jsonRequest(
  path: string,
  options: Omit<RequestInit, 'body'> & { body?: Record<string, unknown> },
) {
  const { body, ...requestOptions } = options
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  if (!headers.has('Origin')) headers.set('Origin', origin)
  return request(path, {
    ...requestOptions,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

function extractAuthenticationCookies(response: Response) {
  const header = response.headers.get('set-cookie') ?? ''
  const sessionToken = header.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
  const csrfToken = header.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
  if (!sessionToken || !csrfToken) throw new Error('登录响应缺少认证 Cookie')
  const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`
  return { cookie, csrfToken, headers: { Cookie: cookie } }
}

function extractRecoveryCookies(response: Response) {
  const header = response.headers.get('set-cookie') ?? ''
  const sessionToken = header.match(
    new RegExp(`${RECOVERY_SESSION_COOKIE_NAME}=([^;,]+)`, 'u'),
  )?.[1]
  const csrfToken = header.match(new RegExp(`${RECOVERY_CSRF_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
  if (!sessionToken || !csrfToken) throw new Error('恢复响应缺少恢复 Cookie')
  const cookie = `${RECOVERY_SESSION_COOKIE_NAME}=${sessionToken}; ${RECOVERY_CSRF_COOKIE_NAME}=${csrfToken}`
  return { cookie, csrfToken }
}

function mutationHeaders(session: ReturnType<typeof extractAuthenticationCookies>) {
  return {
    Cookie: session.cookie,
    Origin: origin,
    [CSRF_HEADER_NAME]: session.csrfToken,
    'CF-Connecting-IP': '203.0.113.201',
    'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
  }
}

function recoveryMutationHeaders(session: ReturnType<typeof extractRecoveryCookies>) {
  return {
    Cookie: session.cookie,
    Origin: origin,
    [RECOVERY_CSRF_HEADER_NAME]: session.csrfToken,
    'CF-Connecting-IP': '203.0.113.202',
    'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
  }
}
