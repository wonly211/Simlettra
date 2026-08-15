import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  LogicalStorageCapacityError,
  commitLogicalStorageReservation,
  logicalStorageAdjustmentStatement,
  releaseLogicalStorageReservation,
  reserveLogicalStorage,
} from '../../src/modules/storage-quotas/public'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type { StorageQuotaOverviewResponse } from '../../src/shared/contracts/storage-quotas'

interface TestEnvironment extends Env {
  INIT_KEY: string
}

const testEnvironment = env as TestEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'

describe('用户与组织逻辑存储配额', () => {
  it('初始化建立管理员账户，管理员可分别修改两类默认值', async () => {
    await initializeSystem()
    const administrator = extractCookies(await login())
    const overview = await request('/api/auth/admin/storage-quotas', {
      headers: { Cookie: administrator.cookie },
    })
    expect(overview.status).toBe(200)
    const payload = await overview.json<StorageQuotaOverviewResponse>()
    expect(payload.data.storageMode).toBe('r2')
    expect(payload.data.defaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerType: 'user', limitBytes: 1_000_000_000 }),
        expect.objectContaining({ ownerType: 'organization', limitBytes: 1_000_000_000 }),
      ]),
    )
    expect(payload.data.users[0]).toMatchObject({
      displayName: '系统管理员',
      committedBytes: 0,
      reservedBytes: 0,
      limitBytes: 1_000_000_000,
    })

    const saved = await jsonRequest('/api/auth/admin/storage-quotas/defaults/user', {
      method: 'PUT',
      headers: mutationHeaders(administrator),
      body: { limitBytes: 800_000_000 },
    })
    expect(saved.status).toBe(200)
    const refreshed = await (
      await request('/api/auth/admin/storage-quotas', {
        headers: { Cookie: administrator.cookie },
      })
    ).json<StorageQuotaOverviewResponse>()
    expect(refreshed.data.defaults.find((item) => item.ownerType === 'user')?.limitBytes).toBe(
      800_000_000,
    )
    expect(
      refreshed.data.defaults.find((item) => item.ownerType === 'organization')?.limitBytes,
    ).toBe(1_000_000_000)
  })

  it('预留并发准入、提交、释放、减量和调低后只阻止增长', async () => {
    await initializeSystem()
    const administrator = extractCookies(await login())
    const overview = await (
      await request('/api/auth/admin/storage-quotas', {
        headers: { Cookie: administrator.cookie },
      })
    ).json<StorageQuotaOverviewResponse>()
    const ownerId = overview.data.users[0]!.ownerId
    await jsonRequest(`/api/auth/admin/storage-quotas/user/${ownerId}`, {
      method: 'PUT',
      headers: mutationHeaders(administrator),
      body: { limitBytes: 10_000_000 },
    })

    const first = await reserveLogicalStorage({
      database: env.DB,
      storageMode: 'r2',
      owner: { ownerType: 'user', ownerId },
      operationKind: 'draft',
      operationReference: 'first',
      bytes: 8_000_000,
    })
    await expect(
      reserveLogicalStorage({
        database: env.DB,
        storageMode: 'r2',
        owner: { ownerType: 'user', ownerId },
        operationKind: 'draft',
        operationReference: 'second',
        bytes: 3_000_000,
      }),
    ).rejects.toBeInstanceOf(LogicalStorageCapacityError)
    await commitLogicalStorageReservation({
      database: env.DB,
      reservation: first,
      entryKind: 'draft',
      ownerReference: 'draft:first',
    })
    const decrease = await logicalStorageAdjustmentStatement({
      database: env.DB,
      storageMode: 'r2',
      owner: { ownerType: 'user', ownerId },
      entryKind: 'draft',
      ownerReference: 'draft:first',
      bytesDelta: -2_000_000,
      idempotencyKey: 'decrease-first',
    })
    await env.DB.batch([decrease!])
    const releasable = await reserveLogicalStorage({
      database: env.DB,
      storageMode: 'r2',
      owner: { ownerType: 'user', ownerId },
      operationKind: 'draft',
      operationReference: 'release',
      bytes: 1_000_000,
    })
    await releaseLogicalStorageReservation({ database: env.DB, reservation: releasable })
    const account = await env.DB.prepare(
      `SELECT committed_bytes, reserved_bytes FROM logical_storage_usage_accounts
       WHERE user_id = ?1 AND storage_mode = 'r2'`,
    )
      .bind(ownerId)
      .first()
    expect(account).toEqual({ committed_bytes: 6_000_000, reserved_bytes: 0 })

    await jsonRequest(`/api/auth/admin/storage-quotas/user/${ownerId}`, {
      method: 'PUT',
      headers: mutationHeaders(administrator),
      body: { limitBytes: 5_000_000 },
    })
    await expect(
      reserveLogicalStorage({
        database: env.DB,
        storageMode: 'r2',
        owner: { ownerType: 'user', ownerId },
        operationKind: 'draft',
        operationReference: 'over-limit',
        bytes: 1,
      }),
    ).rejects.toBeInstanceOf(LogicalStorageCapacityError)
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
      password,
      timezone: 'Asia/Shanghai',
    },
  })
  expect(response.status).toBe(201)
}

async function login() {
  return jsonRequest('/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin },
    body: { email: 'owner@example.com', password },
  })
}

function extractCookies(response: Response) {
  const header = response.headers.get('set-cookie') ?? ''
  const session = new RegExp(`${SESSION_COOKIE_NAME}=([^;,]+)`).exec(header)?.[1] ?? ''
  const csrf = new RegExp(`${CSRF_COOKIE_NAME}=([^;,]+)`).exec(header)?.[1] ?? ''
  return { cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`, csrf }
}

function mutationHeaders(cookies: ReturnType<typeof extractCookies>) {
  return {
    Cookie: cookies.cookie,
    Origin: origin,
    'Content-Type': 'application/json',
    [CSRF_HEADER_NAME]: cookies.csrf,
  }
}

function jsonRequest(
  path: string,
  options: { method: string; headers?: Record<string, string>; body: object },
) {
  return request(path, {
    method: options.method,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify(options.body),
  })
}

function request(path: string, init?: RequestInit) {
  return workerExports.default.fetch(new Request(`${origin}${path}`, init))
}
