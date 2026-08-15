import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type {
  CreatePersonalAliasResponse,
  PersonalAddressOverviewResponse,
} from '../../src/shared/contracts/personal-address-management'
import type { CreateManagedUserResponse } from '../../src/shared/contracts/user-management'

const testEnvironment = env as Env & { INIT_KEY: string }
const origin = 'https://simlettra.test'
const administratorEmail = 'owner@example.com'
const administratorPassword = '长河-Glass-47-Quiet'

describe('个人地址与别名管理 HTTP 边界', { timeout: 60_000 }, () => {
  it('初始化用户默认获得二十个别名额度并能查看主地址', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())

    const policy = await env.DB.prepare(
      'SELECT alias_limit, self_creation_enabled FROM user_alias_policies',
    ).first<{ alias_limit: number; self_creation_enabled: number }>()
    expect(policy).toEqual({ alias_limit: 20, self_creation_enabled: 1 })

    const response = await request('/api/auth/personal-addresses', {
      headers: administrator.headers,
    })
    expect(response.status).toBe(200)
    await expect(response.json<PersonalAddressOverviewResponse>()).resolves.toMatchObject({
      data: {
        policy: {
          aliasLimit: 20,
          aliasUsed: 0,
          selfCreationEnabled: true,
          overLimit: false,
        },
        addresses: [
          { address: administratorEmail, role: 'primary', isPinned: true, isDefaultSender: true },
        ],
        activeDomains: [{ canonicalName: 'example.com' }],
      },
    })
  })

  it('用户可以在启用域名和额度内创建别名，冲突与暂停域名会被拒绝', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const domainId = await getDomainId()

    const created = await createSelfAlias(administrator, 'letters', domainId)
    expect(created.status).toBe(201)
    await expect(created.json<CreatePersonalAliasResponse>()).resolves.toMatchObject({
      data: {
        address: { address: 'letters@example.com', role: 'alias', isDefaultSender: false },
        policy: { aliasUsed: 1, aliasLimit: 20 },
      },
    })
    expect((await createSelfAlias(administrator, 'LETTERS', domainId)).status).toBe(409)

    await request(`/api/auth/administrator/domains/${domainId}/pause`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
    })
    const paused = await createSelfAlias(administrator, 'paused', domainId)
    expect(paused.status).toBe(422)
    await expect(paused.json()).resolves.toMatchObject({
      error: { code: 'domain_unavailable', field: 'domainId' },
    })
    expect(await countCurrentAliases()).toBe(1)
    expect(await countAuditEvents('personal_alias.created')).toBe(1)
  })

  it('管理员可以修改策略，自助开关不妨碍管理员在额度内分配', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const administratorId = await getAdministratorId()
    const domainId = await getDomainId()

    const updated = await updatePolicy(administrator, administratorId, 1, false)
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      data: { user: { policy: { aliasLimit: 1, aliasUsed: 0, selfCreationEnabled: false } } },
    })

    const deniedSelfCreation = await createSelfAlias(administrator, 'self-denied', domainId)
    expect(deniedSelfCreation.status).toBe(422)
    await expect(deniedSelfCreation.json()).resolves.toMatchObject({
      error: { code: 'self_creation_disabled' },
    })

    const assigned = await createAdministratorAlias(
      administrator,
      administratorId,
      'admin-assigned',
      domainId,
    )
    expect(assigned.status).toBe(201)
    const overQuota = await createAdministratorAlias(
      administrator,
      administratorId,
      'over-quota',
      domainId,
    )
    expect(overQuota.status).toBe(422)
    await expect(overQuota.json()).resolves.toMatchObject({
      error: { code: 'alias_quota_exceeded' },
    })

    const lowered = await updatePolicy(administrator, administratorId, 0, true)
    expect(lowered.status).toBe(200)
    await expect(lowered.json()).resolves.toMatchObject({
      data: { user: { policy: { aliasLimit: 0, aliasUsed: 1, overLimit: true } } },
    })
    expect(await countCurrentAliases()).toBe(1)
    expect(await countAuditEvents('personal_alias.policy_updated')).toBe(2)
  })

  it('用户可以修改显示名称、置顶、顺序和默认发件地址', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const domainId = await getDomainId()
    const first = await createSelfAlias(administrator, 'first', domainId).then((response) =>
      response.json<CreatePersonalAliasResponse>(),
    )
    const second = await createSelfAlias(administrator, 'second', domainId).then((response) =>
      response.json<CreatePersonalAliasResponse>(),
    )

    const moved = await jsonRequest(`/api/auth/personal-addresses/${second.data.address.id}/move`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { direction: 'up' },
    })
    expect(moved.status).toBe(200)
    await expect(moved.json()).resolves.toMatchObject({ data: { changed: true } })

    const preference = await jsonRequest(
      `/api/auth/personal-addresses/${first.data.address.id}/preferences`,
      {
        method: 'PATCH',
        headers: mutationHeaders(administrator),
        body: { customLabel: '往来地址', isPinned: true },
      },
    )
    expect(preference.status).toBe(200)
    await expect(preference.json()).resolves.toMatchObject({
      data: { address: { customLabel: '往来地址', isPinned: true } },
    })

    const defaultSender = await request(
      `/api/auth/personal-addresses/${second.data.address.id}/default-sender`,
      { method: 'POST', headers: mutationHeaders(administrator) },
    )
    expect(defaultSender.status).toBe(200)
    const overview = await request('/api/auth/personal-addresses', {
      headers: administrator.headers,
    }).then((response) => response.json<PersonalAddressOverviewResponse>())
    expect(
      overview.data.addresses.find((address) => address.id === second.data.address.id),
    ).toMatchObject({ isDefaultSender: true })
    expect(overview.data.addresses.filter((address) => address.isDefaultSender)).toHaveLength(1)
  })

  it('删除别名立即释放地址，删除默认别名时自动回退主地址', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const domainId = await getDomainId()
    const created = await createSelfAlias(administrator, 'reusable', domainId).then((response) =>
      response.json<CreatePersonalAliasResponse>(),
    )
    await request(`/api/auth/personal-addresses/${created.data.address.id}/default-sender`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
    })

    const missingConfirmation = await deleteSelfAlias(administrator, created.data.address.id, false)
    expect(missingConfirmation.status).toBe(422)
    const deleted = await deleteSelfAlias(administrator, created.data.address.id, true)
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toMatchObject({
      data: {
        deletedAddressId: created.data.address.id,
        canonicalAddress: 'reusable@example.com',
        releasedImmediately: true,
        policy: { aliasUsed: 0 },
      },
    })
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM address_claims WHERE canonical_address = 'reusable@example.com'",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 })

    const recreated = await createSelfAlias(administrator, 'reusable', domainId)
    expect(recreated.status).toBe(201)
    const recreatedPayload = await recreated.json<CreatePersonalAliasResponse>()
    expect(recreatedPayload.data.address.id).not.toBe(created.data.address.id)

    const primaryId = await getPrimaryAddressId()
    const protectedPrimary = await deleteSelfAlias(administrator, primaryId, true)
    expect(protectedPrimary.status).toBe(409)
    await expect(protectedPrimary.json()).resolves.toMatchObject({
      error: { code: 'primary_protected' },
    })
  })

  it('普通用户不能修改他人策略，修改接口必须通过 CSRF 验证', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const memberResponse = await createUser(administrator)
    const member = await memberResponse.json<CreateManagedUserResponse>()
    const memberSession = extractAuthenticationCookies(
      await login(member.data.user.primaryAddress, member.data.temporaryPassword, '203.0.113.171'),
    )
    await jsonRequest('/api/auth/password/complete-required-change', {
      method: 'POST',
      headers: mutationHeaders(memberSession),
      body: { newPassword: '星海-Window-82-Clear' },
    })

    expect(
      (await request('/api/auth/administrator/alias-policies', { headers: memberSession.headers }))
        .status,
    ).toBe(403)
    expect((await updatePolicy(memberSession, await getAdministratorId(), 8, true)).status).toBe(
      403,
    )

    const noCsrf = await jsonRequest('/api/auth/personal-addresses/aliases', {
      method: 'POST',
      headers: administrator.headers,
      body: { localPart: 'no-csrf', domainId: await getDomainId() },
    })
    expect(noCsrf.status).toBe(403)
    expect(await countCurrentAliases()).toBe(0)
  })

  it('审计失败会回滚整项别名创建', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    await env.DB.prepare(
      `CREATE TRIGGER reject_personal_alias_creation_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action_name = 'personal_alias.created'
       BEGIN
         SELECT RAISE(ABORT, '测试拒绝个人别名创建审计');
       END;`,
    ).run()

    const response = await createSelfAlias(administrator, 'rollback', await getDomainId())
    expect(response.status).toBe(500)
    expect(await countCurrentAliases()).toBe(0)
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM email_addresses WHERE canonical_address = 'rollback@example.com'",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 })
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

function createSelfAlias(
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

function createAdministratorAlias(
  session: ReturnType<typeof extractAuthenticationCookies>,
  userId: string,
  localPart: string,
  domainId: string,
) {
  return jsonRequest(`/api/auth/administrator/users/${userId}/aliases`, {
    method: 'POST',
    headers: mutationHeaders(session),
    body: { localPart, domainId },
  })
}

function updatePolicy(
  session: ReturnType<typeof extractAuthenticationCookies>,
  userId: string,
  aliasLimit: number,
  selfCreationEnabled: boolean,
) {
  return jsonRequest(`/api/auth/administrator/users/${userId}/alias-policy`, {
    method: 'PATCH',
    headers: mutationHeaders(session),
    body: { aliasLimit, selfCreationEnabled },
  })
}

function deleteSelfAlias(
  session: ReturnType<typeof extractAuthenticationCookies>,
  addressId: string,
  confirmed: boolean,
) {
  return jsonRequest(`/api/auth/personal-addresses/aliases/${addressId}`, {
    method: 'DELETE',
    headers: mutationHeaders(session),
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
      domainId: await getDomainId(),
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

async function getAdministratorId(): Promise<string> {
  const result = await env.DB.prepare(
    'SELECT current_admin_user_id AS id FROM system_instances WHERE singleton_id = 1',
  ).first<{ id: string }>()
  if (!result) throw new Error('测试管理员不存在')
  return result.id
}

async function getPrimaryAddressId(): Promise<string> {
  const result = await env.DB.prepare(
    "SELECT address_id AS id FROM address_bindings WHERE address_role = 'primary' AND ended_at IS NULL",
  ).first<{ id: string }>()
  if (!result) throw new Error('测试主地址不存在')
  return result.id
}

function login(
  email = administratorEmail,
  password = administratorPassword,
  source = '203.0.113.170',
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
    'CF-Connecting-IP': '203.0.113.170',
    'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
  }
}

async function countCurrentAliases(): Promise<number> {
  const result = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM address_bindings WHERE address_role = 'alias' AND ended_at IS NULL",
  ).first<{ count: number }>()
  return result?.count ?? 0
}

async function countAuditEvents(actionName: string): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM audit_events WHERE action_name = ?1',
  )
    .bind(actionName)
    .first<{ count: number }>()
  return result?.count ?? 0
}
