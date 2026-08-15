import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/modules/identity/domain/password'
import {
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'

const testEnvironment = env as Env & { INIT_KEY: string }
const origin = 'https://simlettra.test'
const administratorEmail = 'owner@example.com'
const administratorPassword = '长河-Glass-47-Quiet'
const userEmail = 'member@example.com'
const userPassword = '微风-Silver-63-Field'

describe('密码管理与管理员恢复 HTTP 边界', { timeout: 30_000 }, () => {
  it('自行改密可以分别保留或撤销其他设备', async () => {
    await initializeSystem()
    const current = extractAuthenticationCookies(await login())
    const other = extractAuthenticationCookies(
      await login(administratorEmail, administratorPassword, '203.0.113.51'),
    )
    const firstNewPassword = '星海-Maple-58-Calm'

    const keepResponse = await jsonRequest('/api/auth/password/change', {
      method: 'POST',
      headers: mutationHeaders(current),
      body: {
        currentPassword: administratorPassword,
        newPassword: firstNewPassword,
        revokeOtherSessions: false,
      },
    })
    expect(keepResponse.status).toBe(200)
    await expect(keepResponse.json()).resolves.toMatchObject({
      data: { passwordChanged: true, revokedOtherSessions: 0 },
    })
    expect((await request('/api/auth/session', { headers: other.headers })).status).toBe(200)
    expect((await login(administratorEmail, administratorPassword, '203.0.113.52')).status).toBe(
      401,
    )

    const extra = extractAuthenticationCookies(
      await login(administratorEmail, firstNewPassword, '203.0.113.53'),
    )
    const secondNewPassword = '远山-Cedar-62-Bright'
    const revokeResponse = await jsonRequest('/api/auth/password/change', {
      method: 'POST',
      headers: mutationHeaders(current),
      body: {
        currentPassword: firstNewPassword,
        newPassword: secondNewPassword,
        revokeOtherSessions: true,
      },
    })
    expect(revokeResponse.status).toBe(200)
    await expect(revokeResponse.json()).resolves.toMatchObject({
      data: { passwordChanged: true, revokedOtherSessions: 2 },
    })
    expect((await request('/api/auth/session', { headers: current.headers })).status).toBe(200)
    expect((await request('/api/auth/session', { headers: other.headers })).status).toBe(401)
    expect((await request('/api/auth/session', { headers: extra.headers })).status).toBe(401)

    const auditCount = await countAuditEvents('password.changed')
    expect(auditCount).toBe(2)
  })

  it('自行改密要求 CSRF 和正确的当前密码', async () => {
    await initializeSystem()
    const current = extractAuthenticationCookies(await login())

    const missingCsrf = await jsonRequest('/api/auth/password/change', {
      method: 'POST',
      headers: { Cookie: current.cookie, Origin: origin },
      body: {
        currentPassword: administratorPassword,
        newPassword: '山岚-Violet-42-Quiet',
        revokeOtherSessions: true,
      },
    })
    expect(missingCsrf.status).toBe(403)

    const wrongCurrent = await jsonRequest('/api/auth/password/change', {
      method: 'POST',
      headers: mutationHeaders(current),
      body: {
        currentPassword: '错误但长度足够的当前密码',
        newPassword: '山岚-Violet-42-Quiet',
        revokeOtherSessions: true,
      },
    })
    expect(wrongCurrent.status).toBe(401)
    expect((await login()).status).toBe(200)
    expect(await countAuditEvents('password.changed')).toBe(0)
  })

  it('管理员重置生成临时密码并强制用户先改密', async () => {
    await initializeSystem()
    await seedOrdinaryUser()
    const firstUserSession = extractAuthenticationCookies(await login(userEmail, userPassword))
    const secondUserSession = extractAuthenticationCookies(
      await login(userEmail, userPassword, '203.0.113.61'),
    )
    const administrator = extractAuthenticationCookies(await login())

    const resetResponse = await jsonRequest('/api/auth/administrator/users/password-reset', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { primaryAddress: userEmail },
    })
    expect(resetResponse.status).toBe(200)
    const resetPayload = await resetResponse.json<{
      data: { temporaryPassword: string; expiresAt: string }
    }>()
    expect(resetPayload.data.temporaryPassword).toMatch(
      /^[A-HJ-NP-Za-km-z2-9]{5}(?:-[A-HJ-NP-Za-km-z2-9]{5}){3}$/u,
    )
    expect(new Date(resetPayload.data.expiresAt).valueOf()).toBeGreaterThan(Date.now())
    expect((await request('/api/auth/session', { headers: firstUserSession.headers })).status).toBe(
      401,
    )
    expect(
      (await request('/api/auth/session', { headers: secondUserSession.headers })).status,
    ).toBe(401)

    const firstTemporaryLogin = await login(userEmail, resetPayload.data.temporaryPassword)
    expect(firstTemporaryLogin.status).toBe(200)
    await expect(firstTemporaryLogin.clone().json()).resolves.toMatchObject({
      data: { user: { passwordChangeRequired: true } },
    })
    const firstTemporarySession = extractAuthenticationCookies(firstTemporaryLogin)
    const secondTemporarySession = extractAuthenticationCookies(
      await login(userEmail, resetPayload.data.temporaryPassword, '203.0.113.62'),
    )

    const restricted = await request('/api/auth/sessions', {
      headers: firstTemporarySession.headers,
    })
    expect(restricted.status).toBe(403)
    await expect(restricted.json()).resolves.toMatchObject({
      error: { code: 'password_change_required' },
    })

    const formalPassword = '晨光-Cobalt-82-Open'
    const completeResponse = await jsonRequest('/api/auth/password/complete-required-change', {
      method: 'POST',
      headers: mutationHeaders(firstTemporarySession),
      body: { newPassword: formalPassword },
    })
    expect(completeResponse.status).toBe(200)
    await expect(completeResponse.json()).resolves.toMatchObject({
      data: {
        passwordChanged: true,
        revokedOtherSessions: 1,
        user: { passwordChangeRequired: false },
      },
    })
    expect(
      (await request('/api/auth/session', { headers: secondTemporarySession.headers })).status,
    ).toBe(401)
    expect((await login(userEmail, resetPayload.data.temporaryPassword)).status).toBe(401)
    expect((await login(userEmail, formalPassword, '203.0.113.63')).status).toBe(200)
    expect(await countAuditEvents('password.temporary_reset')).toBe(1)
    expect(await countAuditEvents('password.changed')).toBe(1)

    const auditText = JSON.stringify(
      (
        await env.DB.prepare(
          'SELECT action_name, target_reference, reason_code FROM audit_events ORDER BY occurred_at',
        ).all()
      ).results,
    )
    expect(auditText).not.toContain(resetPayload.data.temporaryPassword)
  })

  it('临时密码到期后登录和已经建立的受限会话都失效', async () => {
    await initializeSystem()
    const userId = await seedOrdinaryUser()
    const administrator = extractAuthenticationCookies(await login())
    const resetResponse = await jsonRequest('/api/auth/administrator/users/password-reset', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { primaryAddress: userEmail },
    })
    const temporaryPassword = (await resetResponse.json<{ data: { temporaryPassword: string } }>())
      .data.temporaryPassword
    const temporarySession = extractAuthenticationCookies(await login(userEmail, temporaryPassword))

    await env.DB.prepare(
      'UPDATE password_credentials SET temporary_expires_at = ?1 WHERE user_id = ?2',
    )
      .bind(Date.now() - 1, userId)
      .run()

    expect((await request('/api/auth/session', { headers: temporarySession.headers })).status).toBe(
      401,
    )
    expect((await login(userEmail, temporaryPassword, '203.0.113.71')).status).toBe(401)
  })

  it('普通用户不能重置他人且管理员不能用普通接口重置自己', async () => {
    await initializeSystem()
    await seedOrdinaryUser()
    const user = extractAuthenticationCookies(await login(userEmail, userPassword))
    const administrator = extractAuthenticationCookies(await login())

    const denied = await jsonRequest('/api/auth/administrator/users/password-reset', {
      method: 'POST',
      headers: mutationHeaders(user),
      body: { primaryAddress: administratorEmail },
    })
    expect(denied.status).toBe(403)

    const selfReset = await jsonRequest('/api/auth/administrator/users/password-reset', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { primaryAddress: administratorEmail },
    })
    expect(selfReset.status).toBe(409)
    await expect(selfReset.json()).resolves.toMatchObject({
      error: { code: 'administrator_self_reset' },
    })
  })

  it('init_key 恢复管理员不建立会话并撤销全部旧会话', async () => {
    await initializeSystem()
    const first = extractAuthenticationCookies(await login())
    const second = extractAuthenticationCookies(
      await login(administratorEmail, administratorPassword, '203.0.113.81'),
    )

    const wrongAuthorization = await request('/api/auth/administrator-recovery/authorize', {
      method: 'POST',
      headers: {
        Origin: origin,
        'X-Simlettra-Init-Key': encodeInitializationKeyHeader('错误-init-key-足够长度'),
      },
    })
    expect(wrongAuthorization.status).toBe(401)

    const authorization = await request('/api/auth/administrator-recovery/authorize', {
      method: 'POST',
      headers: recoveryHeaders(),
    })
    expect(authorization.status).toBe(200)
    await expect(authorization.json()).resolves.toMatchObject({
      data: { authorized: true, administrator: { primaryAddress: administratorEmail } },
    })

    const recoveredPassword = '归航-Marble-73-Steady'
    const recovery = await jsonRequest('/api/auth/administrator-recovery/complete', {
      method: 'POST',
      headers: recoveryHeaders(),
      body: { newPassword: recoveredPassword },
    })
    expect(recovery.status).toBe(200)
    await expect(recovery.json()).resolves.toMatchObject({
      data: { recovered: true, administrator: { primaryAddress: administratorEmail } },
    })
    expect(recovery.headers.get('set-cookie')).not.toContain('authenticated=true')
    expect((await request('/api/auth/session', { headers: first.headers })).status).toBe(401)
    expect((await request('/api/auth/session', { headers: second.headers })).status).toBe(401)
    expect((await login()).status).toBe(401)
    expect((await login(administratorEmail, recoveredPassword, '203.0.113.82')).status).toBe(200)
    expect(await countAuditEvents('password.administrator_recovered')).toBe(1)
  })

  it('审计写入失败时密码和会话撤销一起回滚', async () => {
    await initializeSystem()
    const current = extractAuthenticationCookies(await login())
    const other = extractAuthenticationCookies(
      await login(administratorEmail, administratorPassword, '203.0.113.91'),
    )
    await env.DB.prepare(
      `CREATE TRIGGER reject_audit_insert
       BEFORE INSERT ON audit_events
       BEGIN
         SELECT RAISE(ABORT, '测试审计写入失败');
       END;`,
    ).run()

    const response = await jsonRequest('/api/auth/password/change', {
      method: 'POST',
      headers: mutationHeaders(current),
      body: {
        currentPassword: administratorPassword,
        newPassword: '云帆-Indigo-69-Clear',
        revokeOtherSessions: true,
      },
    })
    expect(response.status).toBe(500)
    expect((await request('/api/auth/session', { headers: other.headers })).status).toBe(200)
    expect((await login(administratorEmail, administratorPassword, '203.0.113.92')).status).toBe(
      500,
    )

    await env.DB.exec('DROP TRIGGER reject_audit_insert;')
    expect((await login(administratorEmail, administratorPassword, '203.0.113.93')).status).toBe(
      200,
    )
  })

  it('基于同一旧密码的并发修改最多一个成功', async () => {
    await initializeSystem()
    const current = extractAuthenticationCookies(await login())
    const responses = await Promise.all([
      jsonRequest('/api/auth/password/change', {
        method: 'POST',
        headers: mutationHeaders(current),
        body: {
          currentPassword: administratorPassword,
          newPassword: '北辰-Willow-76-Gentle',
          revokeOtherSessions: false,
        },
      }),
      jsonRequest('/api/auth/password/change', {
        method: 'POST',
        headers: mutationHeaders(current),
        body: {
          currentPassword: administratorPassword,
          newPassword: '雨岸-Copper-84-Kind',
          revokeOtherSessions: false,
        },
      }),
    ])

    const statuses = responses.map((response) => response.status)
    expect(statuses.filter((status) => status === 200)).toHaveLength(1)
    expect(statuses.filter((status) => status === 401 || status === 409)).toHaveLength(1)
    expect(await countAuditEvents('password.changed')).toBe(1)
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

async function seedOrdinaryUser(): Promise<string> {
  const userId = crypto.randomUUID()
  const addressId = crypto.randomUUID()
  const now = Date.now()
  const domain = await env.DB.prepare(
    "SELECT id FROM mail_domains WHERE canonical_name = 'example.com'",
  ).first<{ id: string }>()
  if (!domain) throw new Error('测试域名不存在')
  const passwordRecord = await hashPassword(userPassword)

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
        id, status, display_name, timezone, invitation_policy, created_at, updated_at
       ) VALUES (?1, 'active', '普通用户', 'Asia/Shanghai', 'manual', ?2, ?2)`,
    ).bind(userId, now),
    env.DB.prepare(
      `INSERT INTO password_credentials (
        user_id, format_version, algorithm, iterations, salt, derived_key,
        must_change, temporary_expires_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7)`,
    ).bind(
      userId,
      passwordRecord.formatVersion,
      passwordRecord.algorithm,
      passwordRecord.iterations,
      passwordRecord.salt,
      passwordRecord.derivedKey,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO email_addresses (
        id, domain_id, display_address, canonical_address, created_at
       ) VALUES (?1, ?2, ?3, ?3, ?4)`,
    ).bind(addressId, domain.id, userEmail, now),
    env.DB.prepare(
      `INSERT INTO address_claims (
        canonical_address, address_id, status, reserved_until, created_at, updated_at
       ) VALUES (?1, ?2, 'active', NULL, ?3, ?3)`,
    ).bind(userEmail, addressId, now),
    env.DB.prepare(
      `INSERT INTO address_bindings (
        id, address_id, owner_type, user_id, organization_id,
        address_role, started_at, ended_at, ended_reason
       ) VALUES (?1, ?2, 'user', ?3, NULL, 'primary', ?4, NULL, NULL)`,
    ).bind(crypto.randomUUID(), addressId, userId, now),
  ])
  return userId
}

function login(
  email = administratorEmail,
  password = administratorPassword,
  source = '203.0.113.50',
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
  return {
    cookie,
    csrfToken,
    headers: { Cookie: cookie },
  }
}

function mutationHeaders(session: ReturnType<typeof extractAuthenticationCookies>) {
  return {
    Cookie: session.cookie,
    Origin: origin,
    [CSRF_HEADER_NAME]: session.csrfToken,
    'CF-Connecting-IP': '203.0.113.50',
    'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
  }
}

function recoveryHeaders() {
  return {
    Origin: origin,
    'X-Simlettra-Init-Key': encodeInitializationKeyHeader(testEnvironment.INIT_KEY),
    'CF-Connecting-IP': '203.0.113.80',
    'User-Agent': 'Mozilla/5.0 Firefox/140 Windows',
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
