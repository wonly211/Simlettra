import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { AddressPolicyResponse } from '../../src/shared/contracts/address-policy-management'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type {
  CreatePersonalAliasResponse,
  DeletePersonalAliasResponse,
} from '../../src/shared/contracts/personal-address-management'
import {
  enqueueDueBackgroundTasks,
  processBackgroundTaskMessage,
} from '../../src/modules/tasks/public'

const testEnvironment = env as Env & { INIT_KEY: string }
const origin = 'https://simlettra.test'
const administratorEmail = 'owner@example.com'
const administratorPassword = '长河-Glass-47-Quiet'

describe('地址策略与个人别名保留期 HTTP 边界', { timeout: 60_000 }, () => {
  it('管理员可以保存规范化的全局地址策略，旧版本不能覆盖新版本', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const initial = await getPolicy(administrator)
    expect(initial).toMatchObject({
      minimumLocalPartLength: 1,
      aliasRetentionDays: 0,
      blockedSubstrings: [],
      reservedNames: [],
      policyVersion: 1,
    })

    const updated = await updatePolicy(administrator, {
      minimumLocalPartLength: 4,
      aliasRetentionDays: 7,
      blockedSubstrings: [' Spam ', 'spam', 'abuse'],
      reservedNames: ['ADMIN', 'postmaster'],
      expectedVersion: initial.policyVersion,
    })
    expect(updated.status).toBe(200)
    await expect(updated.json<AddressPolicyResponse>()).resolves.toMatchObject({
      data: {
        policy: {
          minimumLocalPartLength: 4,
          aliasRetentionDays: 7,
          blockedSubstrings: ['abuse', 'spam'],
          reservedNames: ['admin', 'postmaster'],
          policyVersion: 2,
        },
      },
    })

    const stale = await updatePolicy(administrator, {
      minimumLocalPartLength: 2,
      aliasRetentionDays: 0,
      blockedSubstrings: [],
      reservedNames: [],
      expectedVersion: initial.policyVersion,
    })
    expect(stale.status).toBe(409)
    expect(await countAuditEvents('address_policy.updated')).toBe(1)
  })

  it('新地址遵守当前规则，规则变化不会停用已有地址', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const policy = await getPolicy(administrator)
    await updatePolicy(administrator, {
      minimumLocalPartLength: 5,
      aliasRetentionDays: 0,
      blockedSubstrings: ['spam'],
      reservedNames: ['admin'],
      expectedVersion: policy.policyVersion,
    })
    const domainId = await getDomainId()

    expect((await createAlias(administrator, 'four', domainId)).status).toBe(422)
    expect((await createAlias(administrator, 'spammer', domainId)).status).toBe(422)
    expect((await createAlias(administrator, 'admin', domainId)).status).toBe(422)
    expect((await createAlias(administrator, 'letters', domainId)).status).toBe(201)

    const primary = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM address_bindings
       JOIN email_addresses ON email_addresses.id = address_bindings.address_id
       WHERE email_addresses.canonical_address = ?1 AND address_bindings.ended_at IS NULL`,
    )
      .bind(administratorEmail)
      .first<{ count: number }>()
    expect(primary).toEqual({ count: 1 })
  })

  it('修改地址策略要求管理员身份、同源请求和 CSRF 令牌', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const policy = await getPolicy(administrator)
    const input = {
      minimumLocalPartLength: 2,
      aliasRetentionDays: 1,
      blockedSubstrings: [],
      reservedNames: [],
      expectedVersion: policy.policyVersion,
    }

    const noCsrf = await jsonRequest('/api/auth/administrator/address-policy', {
      method: 'PATCH',
      headers: administrator.headers,
      body: input,
    })
    expect(noCsrf.status).toBe(403)

    const user = await createUser(administrator, 'member')
    const member = extractAuthenticationCookies(
      await login(user.primaryAddress, user.temporaryPassword, '203.0.113.191'),
    )
    await jsonRequest('/api/auth/password/complete-required-change', {
      method: 'POST',
      headers: mutationHeaders(member),
      body: { newPassword: '远山-Window-58-Clear' },
    })
    expect(
      (await request('/api/auth/administrator/address-policy', { headers: member.headers })).status,
    ).toBe(403)
    expect((await updatePolicy(member, input)).status).toBe(403)
  })

  it('删除别名会冻结保留期，到期任务释放地址且重复消息无副作用', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const initial = await getPolicy(administrator)
    await updatePolicy(administrator, {
      minimumLocalPartLength: 1,
      aliasRetentionDays: 2,
      blockedSubstrings: [],
      reservedNames: [],
      expectedVersion: initial.policyVersion,
    })
    const domainId = await getDomainId()
    const created = await createAlias(administrator, 'reserved', domainId).then((response) =>
      response.json<CreatePersonalAliasResponse>(),
    )

    const deletedResponse = await deleteAlias(administrator, created.data.address.id)
    expect(deletedResponse.status).toBe(200)
    const deleted = await deletedResponse.json<DeletePersonalAliasResponse>()
    expect(deleted.data).toMatchObject({
      releasedImmediately: false,
      retentionDays: 2,
    })
    expect(deleted.data.releaseAt).not.toBeNull()
    expect((await createAlias(administrator, 'reserved', domainId)).status).toBe(409)

    const task = await env.DB.prepare(
      `SELECT id, input_version FROM background_tasks
       WHERE target_reference = ?1 AND task_type = 'alias_release'`,
    )
      .bind(deleted.data.deletionOperationId)
      .first<{ id: string; input_version: number }>()
    if (!task || !deleted.data.releaseAt) throw new Error('别名释放任务不存在')
    const dueAt = new Date(deleted.data.releaseAt).getTime()
    const message: BackgroundTaskMessage = { taskId: task.id, inputVersion: task.input_version }

    await expect(
      processBackgroundTaskMessage({
        database: env.DB,
        message,
        workerReference: 'test-before-due',
        now: dueAt - 1,
      }),
    ).resolves.toBe('ignored')

    const sent: BackgroundTaskMessage[] = []
    const queue = {
      sendBatch: async (messages: Iterable<{ body: BackgroundTaskMessage }>) => {
        sent.push(...[...messages].map((item) => item.body))
      },
    } as unknown as Queue<BackgroundTaskMessage>
    await expect(enqueueDueBackgroundTasks({ database: env.DB, queue, now: dueAt })).resolves.toBe(
      1,
    )
    expect(sent).toEqual([message])

    await expect(
      processBackgroundTaskMessage({
        database: env.DB,
        message,
        workerReference: 'test-at-due',
        now: dueAt,
      }),
    ).resolves.toBe('completed')
    await expect(
      processBackgroundTaskMessage({
        database: env.DB,
        message,
        workerReference: 'test-duplicate',
        now: dueAt + 1,
      }),
    ).resolves.toBe('ignored')

    expect(await readTaskStatus(task.id)).toBe('succeeded')
    expect(await readDeletionStatus(deleted.data.deletionOperationId)).toBe('completed')
    expect(await countClaims('reserved@example.com')).toBe(0)
    expect((await createAlias(administrator, 'reserved', domainId)).status).toBe(201)
  })

  it('地址策略审计失败时所有设置保持不变', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const initial = await getPolicy(administrator)
    await env.DB.prepare(
      `CREATE TRIGGER reject_address_policy_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action_name = 'address_policy.updated'
       BEGIN
         SELECT RAISE(ABORT, '测试拒绝地址策略审计');
       END;`,
    ).run()

    const response = await updatePolicy(administrator, {
      minimumLocalPartLength: 8,
      aliasRetentionDays: 9,
      blockedSubstrings: ['blocked'],
      reservedNames: ['reserved'],
      expectedVersion: initial.policyVersion,
    })
    expect(response.status).toBe(500)
    expect(await getPolicy(administrator)).toEqual(initial)
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
      password: administratorPassword,
      timezone: 'Asia/Shanghai',
    },
  })
  expect(response.status).toBe(201)
}

async function getPolicy(session: ReturnType<typeof extractAuthenticationCookies>) {
  const response = await request('/api/auth/administrator/address-policy', {
    headers: session.headers,
  })
  expect(response.status).toBe(200)
  return (await response.json<AddressPolicyResponse>()).data.policy
}

function updatePolicy(
  session: ReturnType<typeof extractAuthenticationCookies>,
  input: {
    minimumLocalPartLength: number
    aliasRetentionDays: number
    blockedSubstrings: string[]
    reservedNames: string[]
    expectedVersion: number
  },
) {
  return jsonRequest('/api/auth/administrator/address-policy', {
    method: 'PATCH',
    headers: mutationHeaders(session),
    body: input,
  })
}

function createAlias(
  session: ReturnType<typeof extractAuthenticationCookies>,
  localPart: string,
  domainId: string,
) {
  return jsonRequest('/api/auth/personal-addresses/aliases', {
    method: 'POST',
    headers: mutationHeaders(session),
    body: { localPart, domainId },
  })
}

function deleteAlias(session: ReturnType<typeof extractAuthenticationCookies>, addressId: string) {
  return jsonRequest(`/api/auth/personal-addresses/aliases/${addressId}`, {
    method: 'DELETE',
    headers: mutationHeaders(session),
    body: { confirmed: true },
  })
}

async function createUser(
  administrator: ReturnType<typeof extractAuthenticationCookies>,
  localPart: string,
) {
  const response = await jsonRequest('/api/auth/administrator/users', {
    method: 'POST',
    headers: mutationHeaders(administrator),
    body: {
      displayName: '普通成员',
      localPart,
      domainId: await getDomainId(),
      timezone: 'Asia/Shanghai',
    },
  })
  expect(response.status).toBe(201)
  return response
    .json<{ data: { user: { primaryAddress: string }; temporaryPassword: string } }>()
    .then((value) => ({
      primaryAddress: value.data.user.primaryAddress,
      temporaryPassword: value.data.temporaryPassword,
    }))
}

async function getDomainId(): Promise<string> {
  const domain = await env.DB.prepare(
    "SELECT id FROM mail_domains WHERE canonical_name = 'example.com'",
  ).first<{ id: string }>()
  if (!domain) throw new Error('测试域名不存在')
  return domain.id
}

function login(
  email = administratorEmail,
  password = administratorPassword,
  source = '203.0.113.190',
) {
  return jsonRequest('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': source,
      Origin: origin,
      'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
    },
    body: { email, password },
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

function mutationHeaders(session: ReturnType<typeof extractAuthenticationCookies>) {
  return {
    Cookie: session.cookie,
    Origin: origin,
    [CSRF_HEADER_NAME]: session.csrfToken,
    'CF-Connecting-IP': '203.0.113.190',
    'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
  }
}

async function countAuditEvents(actionName: string): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM audit_events WHERE action_name = ?1',
  )
    .bind(actionName)
    .first<{ count: number }>()
  return result?.count ?? 0
}

async function countClaims(address: string): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM address_claims WHERE canonical_address = ?1',
  )
    .bind(address)
    .first<{ count: number }>()
  return result?.count ?? 0
}

async function readTaskStatus(taskId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT task_status FROM background_tasks WHERE id = ?1')
    .bind(taskId)
    .first<{ task_status: string }>()
  return row?.task_status ?? null
}

async function readDeletionStatus(operationId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT operation_status FROM deletion_operations WHERE id = ?1')
    .bind(operationId)
    .first<{ operation_status: string }>()
  return row?.operation_status ?? null
}
