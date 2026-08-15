import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type {
  CreateManagedUserResponse,
  UserManagementOverviewResponse,
} from '../../src/shared/contracts/user-management'

const testEnvironment = env as Env & { INIT_KEY: string }
const origin = 'https://simlettra.test'
const administratorEmail = 'owner@example.com'
const administratorPassword = '长河-Glass-47-Quiet'

describe('用户创建与状态管理 HTTP 边界', { timeout: 45_000 }, () => {
  it('管理员可以查看用户和当前已启用域名', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())

    const response = await request('/api/auth/administrator/users', {
      headers: administrator.headers,
    })
    expect(response.status).toBe(200)
    await expect(response.json<UserManagementOverviewResponse>()).resolves.toMatchObject({
      data: {
        users: [
          {
            displayName: '系统管理员',
            primaryAddress: administratorEmail,
            status: 'active',
            role: 'administrator',
          },
        ],
        domains: [{ canonicalName: 'example.com' }],
      },
    })
  })

  it('创建用户会原子建立主地址和临时密码', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const domainId = await getDomainId()

    const response = await createUser(administrator, domainId, 'member')
    expect(response.status).toBe(201)
    const payload = await response.json<CreateManagedUserResponse>()
    expect(payload.data.user).toMatchObject({
      displayName: '新成员',
      primaryAddress: 'member@example.com',
      status: 'active',
      role: 'user',
    })
    expect(payload.data.temporaryPassword).toMatch(
      /^[A-HJ-NP-Za-km-z2-9]{5}(?:-[A-HJ-NP-Za-km-z2-9]{5}){3}$/u,
    )

    const counts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE id = ?1) AS users_count,
        (SELECT COUNT(*) FROM password_credentials WHERE user_id = ?1 AND must_change = 1)
          AS passwords_count,
        (SELECT COUNT(*) FROM address_bindings WHERE user_id = ?1 AND address_role = 'primary'
          AND ended_at IS NULL) AS bindings_count,
        (SELECT COUNT(*) FROM user_address_preferences WHERE user_id = ?1
          AND is_default_sender = 1) AS preferences_count`,
    )
      .bind(payload.data.user.id)
      .first<{
        users_count: number
        passwords_count: number
        bindings_count: number
        preferences_count: number
      }>()
    expect(counts).toEqual({
      users_count: 1,
      passwords_count: 1,
      bindings_count: 1,
      preferences_count: 1,
    })

    const temporaryLogin = await login(
      payload.data.user.primaryAddress,
      payload.data.temporaryPassword,
      '203.0.113.121',
    )
    expect(temporaryLogin.status).toBe(200)
    await expect(temporaryLogin.json()).resolves.toMatchObject({
      data: { user: { passwordChangeRequired: true } },
    })
    expect(await countAuditEvents('user.created')).toBe(1)
  })

  it('地址冲突和审计失败都不会留下半个用户', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const domainId = await getDomainId()

    const addressConflict = await createUser(administrator, domainId, 'owner')
    expect(addressConflict.status).toBe(409)
    expect(await countUsers()).toBe(1)

    await env.DB.prepare(
      `CREATE TRIGGER reject_user_creation_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action_name = 'user.created'
       BEGIN
         SELECT RAISE(ABORT, '测试拒绝用户创建审计');
       END;`,
    ).run()
    const auditFailure = await createUser(administrator, domainId, 'rollback')
    expect(auditFailure.status).toBe(500)
    expect(await countUsers()).toBe(1)
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM address_claims WHERE canonical_address = 'rollback@example.com'",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 })
  })

  it('禁用会撤销会话，重新启用后账号可以再次登录', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const createdResponse = await createUser(administrator, await getDomainId(), 'member')
    const created = await createdResponse.json<CreateManagedUserResponse>()
    const member = extractAuthenticationCookies(
      await login(
        created.data.user.primaryAddress,
        created.data.temporaryPassword,
        '203.0.113.131',
      ),
    )

    const disabled = await request(
      `/api/auth/administrator/users/${created.data.user.id}/disable`,
      { method: 'POST', headers: mutationHeaders(administrator) },
    )
    expect(disabled.status).toBe(200)
    await expect(disabled.json()).resolves.toMatchObject({
      data: { user: { status: 'disabled' }, changed: true, revokedSessions: 1 },
    })
    expect((await request('/api/auth/session', { headers: member.headers })).status).toBe(401)
    expect(
      (
        await login(
          created.data.user.primaryAddress,
          created.data.temporaryPassword,
          '203.0.113.132',
        )
      ).status,
    ).toBe(401)

    const enabled = await request(`/api/auth/administrator/users/${created.data.user.id}/enable`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
    })
    expect(enabled.status).toBe(200)
    await expect(enabled.json()).resolves.toMatchObject({
      data: { user: { status: 'active' }, changed: true, revokedSessions: 0 },
    })
    expect(
      (
        await login(
          created.data.user.primaryAddress,
          created.data.temporaryPassword,
          '203.0.113.133',
        )
      ).status,
    ).toBe(200)
    expect(await countAuditEvents('user.disabled')).toBe(1)
    expect(await countAuditEvents('user.enabled')).toBe(1)
  })

  it('普通用户不能管理用户且唯一管理员不能禁用自己', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const createdResponse = await createUser(administrator, await getDomainId(), 'member')
    const created = await createdResponse.json<CreateManagedUserResponse>()
    const member = extractAuthenticationCookies(
      await login(created.data.user.primaryAddress, created.data.temporaryPassword),
    )

    expect(
      (await request('/api/auth/administrator/users', { headers: member.headers })).status,
    ).toBe(403)

    const administratorId = await env.DB.prepare(
      'SELECT current_admin_user_id AS id FROM system_instances WHERE singleton_id = 1',
    ).first<{ id: string }>()
    const protectedResponse = await request(
      `/api/auth/administrator/users/${administratorId?.id ?? ''}/disable`,
      { method: 'POST', headers: mutationHeaders(administrator) },
    )
    expect(protectedResponse.status).toBe(409)
    await expect(protectedResponse.json()).resolves.toMatchObject({
      error: { code: 'administrator_protected' },
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
      password: administratorPassword,
      timezone: 'Asia/Shanghai',
    },
  })
  expect(response.status).toBe(201)
}

async function createUser(
  administrator: ReturnType<typeof extractAuthenticationCookies>,
  domainId: string,
  localPart: string,
) {
  return jsonRequest('/api/auth/administrator/users', {
    method: 'POST',
    headers: mutationHeaders(administrator),
    body: {
      displayName: '新成员',
      localPart,
      domainId,
      timezone: 'Asia/Shanghai',
    },
  })
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
  source = '203.0.113.120',
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
    'CF-Connecting-IP': '203.0.113.120',
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

async function countUsers(): Promise<number> {
  const result = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{
    count: number
  }>()
  return result?.count ?? 0
}
