import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import type {
  CreateInboundRejectionRuleResponse,
  InboundControlOverviewResponse,
} from '../../src/shared/contracts/inbound-control'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type { CreateManagedUserResponse } from '../../src/shared/contracts/user-management'

const testEnvironment = env as Env & { INIT_KEY: string }
const origin = 'https://simlettra.test'
const administratorEmail = 'owner@example.com'
const administratorPassword = '长河-Glass-47-Quiet'

describe('管理员收信控制 HTTP 边界', { timeout: 45_000 }, () => {
  it('管理员可以独立暂停和恢复域名、地址与用户收信', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const overview = await getOverview(administrator)
    const scopeIds = {
      domain: overview.data.domains[0]!.id,
      address: overview.data.addresses[0]!.id,
      user: overview.data.users[0]!.id,
    }

    for (const [scopeType, scopeId] of Object.entries(scopeIds)) {
      const paused = await jsonRequest(
        `/api/auth/administrator/inbound/scopes/${scopeType}/${scopeId}`,
        {
          method: 'PUT',
          headers: mutationHeaders(administrator),
          body: { status: 'paused' },
        },
      )
      expect(paused.status).toBe(200)
      await expect(paused.json()).resolves.toMatchObject({
        data: { scopeType, scopeId, status: 'paused', changed: true },
      })

      const resumed = await jsonRequest(
        `/api/auth/administrator/inbound/scopes/${scopeType}/${scopeId}`,
        {
          method: 'PUT',
          headers: mutationHeaders(administrator),
          body: { status: 'accepting' },
        },
      )
      expect(resumed.status).toBe(200)
      await expect(resumed.json()).resolves.toMatchObject({
        data: { scopeType, scopeId, status: 'accepting', changed: true },
      })
    }

    expect(await countAuditEvents('inbound_receive.paused')).toBe(3)
    expect(await countAuditEvents('inbound_receive.resumed')).toBe(3)
  })

  it('管理员可以建立、暂停、恢复和删除四类拒收规则', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const inputs = [
      { ruleType: 'sender_address', matchValue: 'Sender@Outside.Test' },
      { ruleType: 'sender_domain', matchValue: 'Outside.Test.' },
      { ruleType: 'subject_keyword', matchValue: '  重要通知  ' },
      { ruleType: 'body_keyword', matchValue: '  完整正文  ' },
    ]
    const rules: CreateInboundRejectionRuleResponse['data']['rule'][] = []
    for (const input of inputs) {
      const response = await jsonRequest('/api/auth/administrator/inbound/rules', {
        method: 'POST',
        headers: mutationHeaders(administrator),
        body: input,
      })
      expect(response.status).toBe(201)
      rules.push((await response.json<CreateInboundRejectionRuleResponse>()).data.rule)
    }
    expect(rules.map((rule) => rule.matchValue)).toEqual([
      'sender@outside.test',
      'outside.test',
      '重要通知',
      '完整正文',
    ])

    const rule = rules[0]!
    for (const status of ['paused', 'active']) {
      const response = await jsonRequest(
        `/api/auth/administrator/inbound/rules/${rule.id}/status`,
        {
          method: 'PUT',
          headers: mutationHeaders(administrator),
          body: { status },
        },
      )
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ data: { rule: { status } } })
    }
    const deleted = await request(`/api/auth/administrator/inbound/rules/${rule.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(administrator),
    })
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toEqual({ data: { deletedRuleId: rule.id } })
    expect(await countAuditEvents('inbound_rejection_rule.created')).toBe(4)
    expect(await countAuditEvents('inbound_rejection_rule.deleted')).toBe(1)
  })

  it('重复规则、普通用户、缺少 CSRF 和审计失败都不会产生部分修改', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const created = await jsonRequest('/api/auth/administrator/inbound/rules', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { ruleType: 'sender_domain', matchValue: 'outside.test' },
    })
    expect(created.status).toBe(201)
    const duplicate = await jsonRequest('/api/auth/administrator/inbound/rules', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { ruleType: 'sender_domain', matchValue: 'OUTSIDE.TEST' },
    })
    expect(duplicate.status).toBe(409)

    const noCsrf = await jsonRequest('/api/auth/administrator/inbound/rules', {
      method: 'POST',
      headers: administrator.headers,
      body: { ruleType: 'subject_keyword', matchValue: '不能建立' },
    })
    expect(noCsrf.status).toBe(403)

    const member = await createUser(administrator)
    const memberPayload = await member.json<CreateManagedUserResponse>()
    const memberSession = extractAuthenticationCookies(
      await login(memberPayload.data.user.primaryAddress, memberPayload.data.temporaryPassword),
    )
    await jsonRequest('/api/auth/password/complete-required-change', {
      method: 'POST',
      headers: mutationHeaders(memberSession),
      body: { newPassword: '远山-Window-58-Clear' },
    })
    expect(
      (await request('/api/auth/administrator/inbound', { headers: memberSession.headers })).status,
    ).toBe(403)

    await env.DB.prepare(
      `CREATE TRIGGER reject_inbound_rule_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action_name = 'inbound_rejection_rule.created'
       BEGIN SELECT RAISE(ABORT, '测试拒绝收信规则审计'); END`,
    ).run()
    const auditFailure = await jsonRequest('/api/auth/administrator/inbound/rules', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { ruleType: 'subject_keyword', matchValue: '审计回滚' },
    })
    expect(auditFailure.status).toBe(500)
    expect(await countRules()).toBe(1)
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

async function getOverview(session: ReturnType<typeof extractAuthenticationCookies>) {
  const response = await request('/api/auth/administrator/inbound', { headers: session.headers })
  expect(response.status).toBe(200)
  return response.json<InboundControlOverviewResponse>()
}

async function createUser(administrator: ReturnType<typeof extractAuthenticationCookies>) {
  const domainId = (await getOverview(administrator)).data.domains[0]!.id
  return jsonRequest('/api/auth/administrator/users', {
    method: 'POST',
    headers: mutationHeaders(administrator),
    body: {
      displayName: '普通成员',
      localPart: 'member',
      domainId,
      timezone: 'Asia/Shanghai',
    },
  })
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

async function countAuditEvents(actionName: string): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM audit_events WHERE action_name = ?1',
  )
    .bind(actionName)
    .first<{ count: number }>()
  return result?.count ?? 0
}

async function countRules(): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM inbound_rejection_rules',
  ).first<{ count: number }>()
  return result?.count ?? 0
}
