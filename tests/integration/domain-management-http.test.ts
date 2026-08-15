import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import type {
  CreateMailDomainResponse,
  DomainManagementOverviewResponse,
} from '../../src/shared/contracts/domain-management'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type { CreateManagedUserResponse } from '../../src/shared/contracts/user-management'

const testEnvironment = env as Env & { INIT_KEY: string }
const origin = 'https://simlettra.test'
const administratorEmail = 'owner@example.com'
const administratorPassword = '长河-Glass-47-Quiet'

describe('邮件域名管理 HTTP 边界', { timeout: 45_000 }, () => {
  it('管理员无需 DNS 验证即可添加域名并查看规范化结果', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())

    const createdResponse = await createDomain(administrator, '例子.测试')
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json<CreateMailDomainResponse>()
    expect(created.data.domain).toMatchObject({
      displayName: '例子.测试',
      canonicalName: 'xn--fsqu00a.xn--0zwm56d',
      status: 'active',
      catchAllMode: 'reject',
      addressCount: 0,
    })

    const overview = await request('/api/auth/administrator/domains', {
      headers: administrator.headers,
    })
    expect(overview.status).toBe(200)
    await expect(overview.json<DomainManagementOverviewResponse>()).resolves.toMatchObject({
      data: {
        domains: [
          { canonicalName: 'example.com', addressCount: 1 },
          { canonicalName: 'xn--fsqu00a.xn--0zwm56d', addressCount: 0 },
        ],
      },
    })
    expect(await countAuditEvents('mail_domain.created')).toBe(1)
  })

  it('重复域名和无效域名不会建立记录', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())

    const duplicate = await createDomain(administrator, 'EXAMPLE.COM.')
    expect(duplicate.status).toBe(409)
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: 'domain_conflict', field: 'domainName' },
    })

    const invalid = await createDomain(administrator, 'not a domain')
    expect(invalid.status).toBe(422)
    expect(await countDomains()).toBe(1)
  })

  it('暂停和恢复域名会同步限制新地址分配并写入审计', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const domainId = await getDomainId('example.com')

    const paused = await request(`/api/auth/administrator/domains/${domainId}/pause`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
    })
    expect(paused.status).toBe(200)
    await expect(paused.json()).resolves.toMatchObject({
      data: { domain: { status: 'paused' }, changed: true },
    })
    expect((await listUserCreationDomains(administrator)).length).toBe(0)

    const resumed = await request(`/api/auth/administrator/domains/${domainId}/resume`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
    })
    expect(resumed.status).toBe(200)
    await expect(resumed.json()).resolves.toMatchObject({
      data: { domain: { status: 'active' }, changed: true },
    })
    expect((await listUserCreationDomains(administrator)).length).toBe(1)
    expect(await countAuditEvents('mail_domain.paused')).toBe(1)
    expect(await countAuditEvents('mail_domain.resumed')).toBe(1)
  })

  it('域名删除要求明确确认且有关联地址时始终拒绝', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const domainId = await getDomainId('example.com')

    const missingConfirmation = await deleteDomain(administrator, domainId, false)
    expect(missingConfirmation.status).toBe(422)
    await expect(missingConfirmation.json()).resolves.toMatchObject({
      error: { code: 'confirmation_required' },
    })

    const blocked = await deleteDomain(administrator, domainId, true)
    expect(blocked.status).toBe(409)
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: 'delete_blocked' },
    })
    expect(await countDomains()).toBe(1)
  })

  it('空域名可以永久删除，审计失败时删除会整体回滚', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const firstCreated = await createDomain(administrator, 'empty.example')
    const firstDomain = (await firstCreated.json<CreateMailDomainResponse>()).data.domain

    const deleted = await deleteDomain(administrator, firstDomain.id, true)
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toMatchObject({
      data: { deletedDomainId: firstDomain.id, canonicalName: 'empty.example' },
    })
    expect(await countAuditEvents('mail_domain.deleted')).toBe(1)

    const secondCreated = await createDomain(administrator, 'rollback.example')
    const secondDomain = (await secondCreated.json<CreateMailDomainResponse>()).data.domain
    await env.DB.prepare(
      `CREATE TRIGGER reject_domain_deletion_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action_name = 'mail_domain.deleted'
       BEGIN
         SELECT RAISE(ABORT, '测试拒绝域名删除审计');
       END;`,
    ).run()

    const auditFailure = await deleteDomain(administrator, secondDomain.id, true)
    expect(auditFailure.status).toBe(500)
    expect(await getDomainId('rollback.example')).toBe(secondDomain.id)
  })

  it('普通用户不能管理域名且修改操作必须通过 CSRF 验证', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const memberResponse = await createUser(administrator)
    const member = await memberResponse.json<CreateManagedUserResponse>()
    const memberSession = extractAuthenticationCookies(
      await login(member.data.user.primaryAddress, member.data.temporaryPassword, '203.0.113.151'),
    )
    const changedPassword = await jsonRequest('/api/auth/password/complete-required-change', {
      method: 'POST',
      headers: mutationHeaders(memberSession),
      body: { newPassword: '远山-Window-58-Clear' },
    })
    expect(changedPassword.status).toBe(200)

    expect(
      (await request('/api/auth/administrator/domains', { headers: memberSession.headers })).status,
    ).toBe(403)
    expect((await createDomain(memberSession, 'forbidden.example')).status).toBe(403)

    const noCsrf = await jsonRequest('/api/auth/administrator/domains', {
      method: 'POST',
      headers: administrator.headers,
      body: { domainName: 'no-csrf.example' },
    })
    expect(noCsrf.status).toBe(403)
    expect(await countDomains()).toBe(1)
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

function createDomain(
  administrator: ReturnType<typeof extractAuthenticationCookies>,
  domainName: string,
) {
  return jsonRequest('/api/auth/administrator/domains', {
    method: 'POST',
    headers: mutationHeaders(administrator),
    body: { domainName },
  })
}

function deleteDomain(
  administrator: ReturnType<typeof extractAuthenticationCookies>,
  domainId: string,
  confirmed: boolean,
) {
  return jsonRequest(`/api/auth/administrator/domains/${domainId}`, {
    method: 'DELETE',
    headers: mutationHeaders(administrator),
    body: { confirmed },
  })
}

async function createUser(administrator: ReturnType<typeof extractAuthenticationCookies>) {
  return jsonRequest('/api/auth/administrator/users', {
    method: 'POST',
    headers: mutationHeaders(administrator),
    body: {
      displayName: '普通成员',
      localPart: 'member',
      domainId: await getDomainId('example.com'),
      timezone: 'Asia/Shanghai',
    },
  })
}

async function listUserCreationDomains(
  administrator: ReturnType<typeof extractAuthenticationCookies>,
) {
  const response = await request('/api/auth/administrator/users', {
    headers: administrator.headers,
  })
  const payload = await response.json<{ data: { domains: unknown[] } }>()
  return payload.data.domains
}

async function getDomainId(canonicalName: string): Promise<string> {
  const domain = await env.DB.prepare(
    'SELECT id FROM mail_domains WHERE canonical_name = ?1 COLLATE NOCASE',
  )
    .bind(canonicalName)
    .first<{ id: string }>()
  if (!domain) throw new Error(`测试域名不存在：${canonicalName}`)
  return domain.id
}

function login(
  email = administratorEmail,
  password = administratorPassword,
  source = '203.0.113.150',
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
    'CF-Connecting-IP': '203.0.113.150',
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

async function countDomains(): Promise<number> {
  const result = await env.DB.prepare('SELECT COUNT(*) AS count FROM mail_domains').first<{
    count: number
  }>()
  return result?.count ?? 0
}
