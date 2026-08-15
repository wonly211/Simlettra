import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'

const testEnvironment = env as Env & { INIT_KEY: string }
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'
const email = 'owner@example.com'

describe('密码登录与会话 HTTP 边界', () => {
  it('使用主邮箱登录并只在 D1 保存令牌摘要', async () => {
    await initializeSystem()

    const response = await login()
    expect(response.status).toBe(200)

    const cookies = response.headers.get('set-cookie') ?? ''
    expect(cookies).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(cookies).toContain('Path=/')
    expect(cookies).toContain('Secure')
    expect(cookies).toContain('HttpOnly')
    expect(cookies).toContain('SameSite=Lax')
    expect(cookies).toContain('Max-Age=2592000')
    expect(cookies).toContain(`${CSRF_COOKIE_NAME}=`)

    const sessionToken = cookies.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
    const csrfToken = cookies.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
    expect(sessionToken).toBeTruthy()
    expect(csrfToken).toBeTruthy()
    expect(response.headers.get('location')).toBeNull()
    expect(response.url).not.toContain(sessionToken!)
    expect(response.url).not.toContain(csrfToken!)

    const payload = await response.json()
    expect(payload).toMatchObject({
      data: {
        authenticated: true,
        user: {
          displayName: '系统管理员',
          primaryAddress: email,
        },
        session: {
          current: true,
        },
      },
    })
    expect(JSON.stringify(payload)).not.toContain(sessionToken!)
    expect(JSON.stringify(payload)).not.toContain(csrfToken!)

    const stored = await env.DB.prepare(
      `SELECT
        length(token_digest) AS token_length,
        length(csrf_token_digest) AS csrf_length,
        revoked_at
       FROM sessions`,
    ).first<{ token_length: number; csrf_length: number; revoked_at: number | null }>()
    expect(stored).toEqual({ token_length: 32, csrf_length: 32, revoked_at: null })

    const columns = await env.DB.prepare('PRAGMA table_info(sessions)').all<{ name: string }>()
    expect(columns.results.map((row) => row.name)).not.toContain('token')
    expect(columns.results.map((row) => row.name)).not.toContain('csrf_token')
  })

  it('读取、列出并退出当前会话', async () => {
    await initializeSystem()
    const loginResponse = await login()
    const session = extractAuthenticationCookies(loginResponse)

    const currentResponse = await request('/api/auth/session', { headers: session.headers })
    expect(currentResponse.status).toBe(200)

    const listResponse = await request('/api/auth/sessions', { headers: session.headers })
    expect(listResponse.status).toBe(200)
    const listPayload = await listResponse.json<{
      data: { sessions: Array<Record<string, unknown>> }
    }>()
    expect(listPayload.data.sessions).toHaveLength(1)
    expect(listPayload.data.sessions[0]).toMatchObject({ current: true })
    expect(listPayload.data.sessions[0]).not.toHaveProperty('token_digest')
    expect(listPayload.data.sessions[0]).not.toHaveProperty('csrf_token_digest')

    const missingCsrf = await request('/api/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: session.cookie,
        Origin: origin,
      },
    })
    expect(missingCsrf.status).toBe(403)

    const logoutResponse = await request('/api/auth/logout', {
      method: 'POST',
      headers: mutationHeaders(session),
    })
    expect(logoutResponse.status).toBe(200)
    expect(logoutResponse.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`)

    const rejected = await request('/api/auth/session', { headers: session.headers })
    expect(rejected.status).toBe(401)
  })

  it('只能撤销自己的会话且被撤销令牌立即失效', async () => {
    await initializeSystem()
    const first = extractAuthenticationCookies(await login('203.0.113.31', 'Firefox/140 Windows'))
    const secondResponse = await login('203.0.113.32', 'Chrome/140 Android')
    const second = extractAuthenticationCookies(secondResponse)
    const secondPayload = await secondResponse.json<{ data: { session: { id: string } } }>()

    const revokeResponse = await request(`/api/auth/sessions/${secondPayload.data.session.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(first),
    })
    expect(revokeResponse.status).toBe(200)

    expect((await request('/api/auth/session', { headers: first.headers })).status).toBe(200)
    expect((await request('/api/auth/session', { headers: second.headers })).status).toBe(401)
  })

  it('错误账号状态使用统一描述并触发账号限速', async () => {
    await initializeSystem()

    const unknown = await login('203.0.113.40', 'Chrome/140', 'missing@example.com', password)
    const wrong = await login('203.0.113.40', 'Chrome/140', email, '错误但长度足够的登录密码')
    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(await unknown.json()).toEqual(await wrong.json())

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(
        (await login('203.0.113.40', 'Chrome/140', email, '错误但长度足够的登录密码')).status,
      ).toBe(401)
    }

    const blocked = await login('203.0.113.40', 'Chrome/140', email, '错误但长度足够的登录密码')
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})

async function initializeSystem() {
  const response = await workerExports.default.fetch(
    new Request(`${origin}/api/initialization/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Simlettra-Init-Key': encodeInitializationKeyHeader(testEnvironment.INIT_KEY),
      },
      body: JSON.stringify({
        adminDisplayName: '系统管理员',
        domainName: 'example.com',
        localPart: 'owner',
        password,
        timezone: 'Asia/Shanghai',
      }),
    }),
  )
  expect(response.status).toBe(201)
}

function login(
  source = '203.0.113.30',
  userAgent = 'Mozilla/5.0 Chrome/140 Windows',
  loginEmail = email,
  loginPassword = password,
) {
  return request('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': source,
      'Content-Type': 'application/json',
      Origin: origin,
      'User-Agent': userAgent,
    },
    body: JSON.stringify({ email: loginEmail, password: loginPassword }),
  })
}

function request(path: string, init?: RequestInit) {
  return workerExports.default.fetch(new Request(`${origin}${path}`, init))
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
  }
}
