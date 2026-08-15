import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  commitPlatformCapacityReservation,
  PlatformCapacityUnavailableError,
  releasePlatformCapacityReservation,
  reservePlatformCapacity,
} from '../../src/modules/platform-resources/public'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type { PlatformResourceOverviewResponse } from '../../src/shared/contracts/platform-resources'
import type { CreateManagedUserResponse } from '../../src/shared/contracts/user-management'

interface PlatformResourceTestEnvironment extends Env {
  INIT_KEY: string
}

const testEnvironment = env as PlatformResourceTestEnvironment
const origin = 'https://simlettra.test'
const administratorPassword = '长河-Glass-47-Quiet'
const memberPassword = '成员-Glass-59-Quiet'
const accountId = '11111111111111111111111111111111'
const databaseId = '22222222-2222-4222-8222-222222222222'
const apiToken = 'simlettra-test-read-token-1234567890'

describe('Cloudflare 免费资源 HTTP 与容量准入', { timeout: 45_000 }, () => {
  it('普通用户不能读取资源配置，管理员未配置时看到明确的本地估算', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const member = await createReadyMember(administrator)

    expect(
      (
        await request('/api/auth/admin/platform-resources', {
          headers: { Cookie: member.cookie },
        })
      ).status,
    ).toBe(403)

    const response = await request('/api/auth/admin/platform-resources', {
      headers: { Cookie: administrator.cookie },
    })
    expect(response.status).toBe(200)
    const payload = await response.json<PlatformResourceOverviewResponse>()
    expect(payload.data.configuration.configured).toBe(false)
    expect(payload.data.resources).toHaveLength(2)
    expect(payload.data.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKind: 'd1',
          freeLimitBytes: 500_000_000,
          currentResourceLimitBytes: 500_000_000,
          dataSource: 'local_estimate',
          scopeKind: 'local_only',
          effectiveStopPercent: 80,
        }),
        expect.objectContaining({
          resourceKind: 'r2',
          freeLimitBytes: 10_000_000_000,
          dataSource: 'local_estimate',
          effectiveStopPercent: 80,
        }),
      ]),
    )
  })

  it('保存配置要求 CSRF，并加密保存同时向管理员回显明文 Token', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const missingCsrf = await request('/api/auth/admin/platform-resources/configuration', {
      method: 'PUT',
      headers: {
        Cookie: administrator.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(configurationInput()),
    })
    expect(missingCsrf.status).toBe(403)

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(cloudflareUsageResponse)
    try {
      const response = await jsonRequest('/api/auth/admin/platform-resources/configuration', {
        method: 'PUT',
        headers: mutationHeaders(administrator),
        body: configurationInput(),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        data: {
          configuration: {
            configured: true,
            accountId,
            d1DatabaseId: databaseId,
            storageResourceReference: 'simlettra-test-mail',
            apiToken,
          },
        },
      })

      const stored = await env.DB.prepare(
        `SELECT hex(api_token_ciphertext) AS ciphertext FROM cloudflare_resource_configurations`,
      ).first<{ ciphertext: string }>()
      expect(stored?.ciphertext).not.toBe(bytesToHex(new TextEncoder().encode(apiToken)))
      expect(JSON.stringify(stored)).not.toContain(apiToken)

      const overview = await request('/api/auth/admin/platform-resources', {
        headers: { Cookie: administrator.cookie },
      })
      const payload = await overview.json<PlatformResourceOverviewResponse>()
      expect(payload.data.configuration.apiToken).toBe(apiToken)
      expect(payload.data.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resourceKind: 'd1',
            freeLimitBytes: 5_000_000_000,
            currentResourceLimitBytes: 500_000_000,
            accountUsedBytes: 300_000_000,
            simlettraUsedBytes: 120_000_000,
            remainingBytes: 4_700_000_000,
            currentResourceRemainingBytes: 380_000_000,
            dataSource: 'cloudflare_api',
          }),
          expect.objectContaining({
            resourceKind: 'r2',
            accountUsedBytes: 350_000_030,
            simlettraUsedBytes: 150_000_010,
            itemCount: 2,
            dataSource: 'cloudflare_api',
          }),
        ]),
      )
      expect(fetchMock).toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('阈值使用版本替换并拒绝预警比例高于停止比例', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())

    const invalid = await jsonRequest('/api/auth/admin/platform-resources/d1/threshold', {
      method: 'PUT',
      headers: mutationHeaders(administrator),
      body: { warningPercent: 96, stopPercent: 95 },
    })
    expect(invalid.status).toBe(422)

    const saved = await jsonRequest('/api/auth/admin/platform-resources/d1/threshold', {
      method: 'PUT',
      headers: mutationHeaders(administrator),
      body: { warningPercent: 70, stopPercent: 85 },
    })
    expect(saved.status).toBe(200)
    await expect(saved.json()).resolves.toMatchObject({
      data: { resource: { warningPercent: 70, stopPercent: 85, effectiveStopPercent: 80 } },
    })
    expect(
      await env.DB.prepare(
        `SELECT threshold_version, threshold_status FROM platform_resource_thresholds
         WHERE resource_kind = 'd1' ORDER BY threshold_version`,
      ).all(),
    ).toMatchObject({
      results: [
        { threshold_version: 1, threshold_status: 'retired' },
        { threshold_version: 2, threshold_status: 'active' },
      ],
    })
  })

  it('并发容量预留不能越过停止线，提交、释放和过期状态可追踪', async () => {
    await initializeSystem()
    await request('/api/auth/admin/platform-resources', {
      headers: { Cookie: extractAuthenticationCookies(await login()).cookie },
    })
    const now = Date.now()
    const first = await reservePlatformCapacity({
      database: env.DB,
      storageMode: 'r2',
      operationKind: 'draft_attachment',
      operationReference: 'capacity-first',
      d1EstimatedBytes: 100_000_000,
      objectEstimatedBytes: 1_000_000_000,
      now,
    })
    await commitPlatformCapacityReservation({ database: env.DB, reservation: first, now })

    await expect(
      Promise.all([
        reservePlatformCapacity({
          database: env.DB,
          storageMode: 'r2',
          operationKind: 'sent_copy',
          operationReference: 'capacity-second',
          d1EstimatedBytes: 200_000_000,
          objectEstimatedBytes: 1_000_000_000,
          now: now + 1,
        }),
        reservePlatformCapacity({
          database: env.DB,
          storageMode: 'r2',
          operationKind: 'receive',
          operationReference: 'capacity-third',
          d1EstimatedBytes: 200_000_000,
          objectEstimatedBytes: 1_000_000_000,
          now: now + 1,
        }),
      ]),
    ).rejects.toBeInstanceOf(PlatformCapacityUnavailableError)

    const released = await reservePlatformCapacity({
      database: env.DB,
      storageMode: 'r2',
      operationKind: 'draft_attachment',
      operationReference: 'capacity-release',
      d1EstimatedBytes: 10_000,
      objectEstimatedBytes: 10_000,
      now: now + 2,
    })
    await releasePlatformCapacityReservation({ database: env.DB, reservation: released, now })
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM platform_capacity_reservations
         WHERE reservation_status = 'released'`,
      ).first(),
    ).toEqual({ count: 2 })
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

function configurationInput() {
  return {
    accountId,
    d1DatabaseId: databaseId,
    storageResourceReference: 'simlettra-test-mail',
    apiToken,
  }
}

async function cloudflareUsageResponse(input: RequestInfo | URL): Promise<Response> {
  const request = new Request(input)
  if (request.url.includes('/d1/database/22222222-')) {
    return jsonResponse({ success: true, result: { file_size: 120_000_000 } })
  }
  if (request.url.includes('/d1/database?')) {
    return jsonResponse({
      success: true,
      result: [
        { uuid: databaseId, file_size: 120_000_000 },
        { uuid: '33333333-3333-4333-8333-333333333333', file_size: 180_000_000 },
      ],
      result_info: { page: 1, total_pages: 1 },
    })
  }
  return jsonResponse({
    data: {
      viewer: {
        accounts: [
          {
            r2StorageAdaptiveGroups: [
              {
                max: { payloadSize: 150_000_000, metadataSize: 10, objectCount: 2 },
                dimensions: { bucketName: 'simlettra-test-mail' },
              },
              {
                max: { payloadSize: 200_000_000, metadataSize: 20, objectCount: 3 },
                dimensions: { bucketName: 'other-project' },
              },
            ],
          },
        ],
      },
    },
  })
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function login(
  email = 'owner@example.com',
  password = administratorPassword,
  source = '203.0.113.180',
) {
  return jsonRequest('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': source,
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
    'CF-Connecting-IP': '203.0.113.180',
    'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}
