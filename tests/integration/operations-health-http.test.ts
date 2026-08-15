import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type { OperationsHealthOverviewResponse } from '../../src/shared/contracts/operations-health'
import type { CreateManagedUserResponse } from '../../src/shared/contracts/user-management'

interface OperationsHealthTestEnvironment extends Env {
  INIT_KEY: string
}

const testEnvironment = env as OperationsHealthTestEnvironment
const origin = 'https://simlettra.test'
const administratorPassword = '长河-Glass-47-Quiet'
const memberPassword = '成员-Glass-59-Quiet'

describe('运行健康状态 HTTP 边界', { timeout: 30_000 }, () => {
  it('唯一系统管理员可以读取四类健康摘要', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())

    const response = await request('/api/auth/admin/operations-health', {
      headers: { Cookie: administrator.cookie },
    })
    expect(response.status).toBe(200)
    const payload = await response.json<OperationsHealthOverviewResponse>()
    expect(payload.data).toMatchObject({
      overallStatus: 'unknown',
      inbound: { status: 'unknown' },
      outbound: { status: 'not_configured' },
      scheduled: { status: 'unknown' },
    })
    expect(payload.data.storage.status).toMatch(/healthy|unknown/u)
  })

  it('普通用户不能读取系统运行健康摘要', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const member = await createReadyMember(administrator)

    const response = await request('/api/auth/admin/operations-health', {
      headers: { Cookie: member.cookie },
    })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'administrator_required',
        message: '只有系统管理员可以查看运行健康状态',
      },
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

async function createReadyMember(
  administrator: ReturnType<typeof extractAuthenticationCookies>,
): Promise<ReturnType<typeof extractAuthenticationCookies>> {
  const domain = await env.DB.prepare(
    `SELECT id FROM mail_domains WHERE canonical_name = 'example.com'`,
  ).first<{ id: string }>()
  const createdResponse = await jsonRequest('/api/auth/administrator/users', {
    method: 'POST',
    headers: mutationHeaders(administrator),
    body: {
      displayName: '普通成员',
      localPart: 'member',
      domainId: domain?.id ?? '',
      timezone: 'Asia/Shanghai',
    },
  })
  const created = await createdResponse.json<CreateManagedUserResponse>()
  const member = extractAuthenticationCookies(
    await login(created.data.user.primaryAddress, created.data.temporaryPassword),
  )
  const changed = await jsonRequest('/api/auth/password/complete-required-change', {
    method: 'POST',
    headers: mutationHeaders(member),
    body: { newPassword: memberPassword },
  })
  expect(changed.status).toBe(200)
  return member
}

function login(email = 'owner@example.com', password = administratorPassword) {
  return jsonRequest('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': '203.0.113.190',
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
  return {
    cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
    csrfToken,
  }
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
