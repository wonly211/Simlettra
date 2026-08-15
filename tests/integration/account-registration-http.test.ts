import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import type {
  AccountRegistrationInvitationOverviewResponse,
  CreateAccountRegistrationInvitationResponse,
} from '../../src/shared/contracts/account-registration'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'

const testEnvironment = env as Env & { INIT_KEY: string; CONFIG_KEY: string }
const origin = 'https://simlettra.test'
const administratorEmail = 'owner@example.com'
const administratorPassword = '长河-Glass-47-Quiet'
const memberPassword = 'Aurora-Lattice-93-Pine'

describe('账号邀请码注册 HTTP 边界', { timeout: 60_000 }, () => {
  it('单域名邀请码可以反复查看，并且注册后一次性失效', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const createdResponse = await createInvitation(administrator)
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json<CreateAccountRegistrationInvitationResponse>()
    expect(created.data.invitation).toMatchObject({
      status: 'available',
      domainName: 'example.com',
    })
    expect(created.data.invitation.code).toMatch(/^[A-HJ-NP-Z2-9]{5}(?:-[A-HJ-NP-Z2-9]{5}){4}$/u)

    const overview = await request('/api/auth/administrator/account-registration-invitations', {
      headers: administrator.headers,
    })
    expect(overview.status).toBe(200)
    await expect(
      overview.json<AccountRegistrationInvitationOverviewResponse>(),
    ).resolves.toMatchObject({
      data: {
        invitations: [
          {
            id: created.data.invitation.id,
            code: created.data.invitation.code,
            status: 'available',
          },
        ],
      },
    })

    const verified = await jsonRequest('/api/auth/account-registration/invitation/verify', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.210' },
      body: { code: created.data.invitation.code.toLowerCase().replaceAll('-', ' ') },
    })
    expect(verified.status).toBe(200)
    await expect(verified.json()).resolves.toEqual({
      data: { valid: true, domainName: 'example.com' },
    })

    const registered = await register(created.data.invitation.code, 'member', '203.0.113.210')
    expect(registered.status).toBe(201)
    await expect(registered.clone().json()).resolves.toMatchObject({
      data: {
        authenticated: true,
        user: {
          primaryAddress: 'member@example.com',
          role: 'user',
          passwordChangeRequired: false,
        },
      },
    })
    const member = extractAuthenticationCookies(registered)
    expect((await request('/api/auth/session', { headers: member.headers })).status).toBe(200)

    const reused = await register(created.data.invitation.code, 'other', '203.0.113.211')
    expect(reused.status).toBe(409)
    await expect(reused.json()).resolves.toMatchObject({ error: { code: 'not_available' } })

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users_count,
         (SELECT COUNT(*) FROM account_registration_invitation_consumptions) AS uses_count,
         (SELECT COUNT(*) FROM user_alias_policies WHERE alias_limit = 20) AS alias_policies_count,
         (SELECT COUNT(*) FROM user_organization_policies WHERE organization_limit = 5)
           AS organization_policies_count,
         (SELECT COUNT(*) FROM sessions WHERE user_id = (
           SELECT user_id FROM account_registration_invitation_consumptions LIMIT 1
         )) AS sessions_count`,
    ).first<{
      users_count: number
      uses_count: number
      alias_policies_count: number
      organization_policies_count: number
      sessions_count: number
    }>()
    expect(counts).toEqual({
      users_count: 2,
      uses_count: 1,
      alias_policies_count: 2,
      organization_policies_count: 2,
      sessions_count: 1,
    })
    expect(await countAuditEvents('account_registration.completed')).toBe(1)

    const stored = await env.DB.prepare(
      `SELECT hex(code_ciphertext) AS ciphertext, hex(code_digest) AS digest
       FROM account_registration_invitations WHERE id = ?1`,
    )
      .bind(created.data.invitation.id)
      .first<{ ciphertext: string; digest: string }>()
    expect(stored?.ciphertext).not.toContain(created.data.invitation.code.replaceAll('-', ''))
    expect(stored?.digest).toHaveLength(64)
  })

  it('多个域名时管理员必须指定域名，受邀人只能填写邮箱前缀', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    expect(
      (
        await jsonRequest('/api/auth/administrator/domains', {
          method: 'POST',
          headers: mutationHeaders(administrator),
          body: { domainName: 'family.example' },
        })
      ).status,
    ).toBe(201)

    const missingDomain = await createInvitation(administrator)
    expect(missingDomain.status).toBe(422)
    await expect(missingDomain.json()).resolves.toMatchObject({
      error: { code: 'invalid_input', field: 'domainId' },
    })
    const domain = await env.DB.prepare(
      "SELECT id FROM mail_domains WHERE canonical_name = 'family.example'",
    ).first<{ id: string }>()
    if (!domain) throw new Error('测试域名不存在')
    const createdResponse = await createInvitation(administrator, domain.id)
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json<CreateAccountRegistrationInvitationResponse>()
    expect(created.data.invitation.domainName).toBe('family.example')

    const registered = await register(
      created.data.invitation.code,
      'family-member',
      '203.0.113.212',
    )
    expect(registered.status).toBe(201)
    await expect(registered.json()).resolves.toMatchObject({
      data: { user: { primaryAddress: 'family-member@family.example' } },
    })
  })

  it('管理员可以撤销邀请码，普通用户不能管理，连续失败会触发限速', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const memberInvitation = await createInvitation(administrator).then((response) =>
      response.json<CreateAccountRegistrationInvitationResponse>(),
    )
    const member = extractAuthenticationCookies(
      await register(memberInvitation.data.invitation.code, 'member', '203.0.113.213'),
    )
    expect(
      (
        await request('/api/auth/administrator/account-registration-invitations', {
          headers: member.headers,
        })
      ).status,
    ).toBe(403)

    const invitation = await createInvitation(administrator).then((response) =>
      response.json<CreateAccountRegistrationInvitationResponse>(),
    )
    const revoked = await request(
      `/api/auth/administrator/account-registration-invitations/${invitation.data.invitation.id}/revoke`,
      { method: 'POST', headers: mutationHeaders(administrator) },
    )
    expect(revoked.status).toBe(200)
    await expect(revoked.json()).resolves.toMatchObject({
      data: { invitation: { status: 'revoked', code: invitation.data.invitation.code } },
    })
    expect(
      (
        await jsonRequest('/api/auth/account-registration/invitation/verify', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': '203.0.113.214' },
          body: { code: invitation.data.invitation.code },
        })
      ).status,
    ).toBe(409)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await jsonRequest('/api/auth/account-registration/invitation/verify', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.215' },
        body: { code: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA' },
      })
      expect(failure.status).toBe(attempt < 5 ? 409 : 429)
    }
    const limited = await jsonRequest('/api/auth/account-registration/invitation/verify', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.215' },
      body: { code: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA' },
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBeTruthy()
    expect(await countAuditEvents('account_registration.invitation_revoked')).toBe(1)
  })

  it('注册审计失败会回滚数据且不泄露邀请码', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const invitation = await createInvitation(administrator).then((response) =>
      response.json<CreateAccountRegistrationInvitationResponse>(),
    )
    await env.DB.prepare(
      `CREATE TRIGGER reject_account_registration_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action_name = 'account_registration.completed'
       BEGIN
         SELECT RAISE(ABORT, '测试拒绝账号注册审计');
       END;`,
    ).run()

    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]
    let failedRegistration: Response
    let consoleOutput: string
    try {
      failedRegistration = await register(
        invitation.data.invitation.code,
        'rollback',
        '203.0.113.216',
      )
    } finally {
      consoleOutput = consoleSpies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .join(' ')
      for (const spy of consoleSpies) spy.mockRestore()
    }

    expect(failedRegistration.status).toBe(500)
    const failedResponseBody = await failedRegistration.text()
    expect(failedResponseBody).not.toContain(invitation.data.invitation.code)
    expect(failedResponseBody).not.toContain(invitation.data.invitation.code.replaceAll('-', ''))
    expect(consoleOutput).not.toContain(invitation.data.invitation.code)
    expect(consoleOutput).not.toContain(invitation.data.invitation.code.replaceAll('-', ''))

    expect(await countUsers()).toBe(1)
    expect(await countInvitationConsumptions()).toBe(0)
    const auditRows = await env.DB.prepare(
      `SELECT action_name, target_type, target_reference, reason_code, request_trace_id
       FROM audit_events ORDER BY occurred_at, id`,
    ).all<Record<string, string | null>>()
    const auditText = JSON.stringify(auditRows.results)
    expect(auditText).not.toContain(invitation.data.invitation.code)
    expect(auditText).not.toContain(invitation.data.invitation.code.replaceAll('-', ''))

    await env.DB.prepare('DROP TRIGGER reject_account_registration_audit').run()
    expect(
      (await register(invitation.data.invitation.code, 'rollback', '203.0.113.216')).status,
    ).toBe(201)
    expect(await countUsers()).toBe(2)
    expect(await countInvitationConsumptions()).toBe(1)
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

function createInvitation(
  administrator: ReturnType<typeof extractAuthenticationCookies>,
  domainId?: string,
) {
  return jsonRequest('/api/auth/administrator/account-registration-invitations', {
    method: 'POST',
    headers: mutationHeaders(administrator),
    body: domainId ? { domainId } : {},
  })
}

function register(code: string, localPart: string, source: string) {
  return jsonRequest('/api/auth/account-registration/register', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': source,
      'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
    },
    body: {
      code,
      displayName: '受邀成员',
      localPart,
      password: memberPassword,
      timezone: 'Asia/Shanghai',
    },
  })
}

function login() {
  return jsonRequest('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': '203.0.113.209',
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
  if (!sessionToken || !csrfToken) throw new Error('响应缺少认证 Cookie')
  const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`
  return { cookie, csrfToken, headers: { Cookie: cookie } }
}

function mutationHeaders(session: ReturnType<typeof extractAuthenticationCookies>) {
  return {
    Cookie: session.cookie,
    Origin: origin,
    [CSRF_HEADER_NAME]: session.csrfToken,
    'CF-Connecting-IP': '203.0.113.209',
    'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
  }
}

async function countAuditEvents(actionName: string): Promise<number> {
  return (
    (
      await env.DB.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE action_name = ?1')
        .bind(actionName)
        .first<{ count: number }>()
    )?.count ?? 0
  )
}

async function countUsers(): Promise<number> {
  return (
    (await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>())
      ?.count ?? 0
  )
}

async function countInvitationConsumptions(): Promise<number> {
  return (
    (
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM account_registration_invitation_consumptions',
      ).first<{ count: number }>()
    )?.count ?? 0
  )
}
