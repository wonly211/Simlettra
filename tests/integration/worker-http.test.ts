import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'

const testEnvironment = env as Env & { INIT_KEY: string }

describe('Worker HTTP 边界', () => {
  it('通过正式 Worker 入口返回系统状态', async () => {
    const response = await workerExports.default.fetch(
      new Request('https://simlettra.test/api/system/status'),
    )
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(payload).toMatchObject({
      data: {
        application: 'Simlettra',
        displayName: '澄笺',
        health: 'ok',
        initialization: 'not_initialized',
        storageMode: 'r2',
      },
    })
  })

  it('未知接口返回稳定的中文错误结构', async () => {
    const response = await workerExports.default.fetch(
      new Request('https://simlettra.test/api/not-found'),
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'not_found',
        message: '请求的接口不存在',
      },
    })
  })

  it('使用 init_key 原子建立管理员、域名和主邮箱', async () => {
    const response = await workerExports.default.fetch(
      new Request('https://simlettra.test/api/initialization/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Simlettra-Init-Key': encodeInitializationKeyHeader(testEnvironment.INIT_KEY),
        },
        body: JSON.stringify({
          adminDisplayName: '系统管理员',
          domainName: '例子.中国',
          localPart: 'Owner',
          password: '长河-Glass-47-Quiet',
          timezone: 'Asia/Shanghai',
        }),
      }),
    )

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        initialization: 'initialized',
        administrator: {
          displayName: '系统管理员',
          primaryAddress: 'owner@xn--fsqu00a.xn--fiqs8s',
        },
        domain: {
          canonicalName: 'xn--fsqu00a.xn--fiqs8s',
        },
        storageMode: 'r2',
      },
    })

    const counts = await Promise.all(
      [
        'users',
        'password_credentials',
        'mail_domains',
        'email_addresses',
        'address_claims',
        'address_bindings',
        'user_address_preferences',
        'system_instances',
      ].map(async (table) => {
        const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
          count: number
        }>()
        return row?.count
      }),
    )

    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1])

    const password = await env.DB.prepare(
      'SELECT format_version, algorithm, iterations, length(salt) AS salt_length, length(derived_key) AS key_length FROM password_credentials',
    ).first<{
      format_version: number
      algorithm: string
      iterations: number
      salt_length: number
      key_length: number
    }>()
    expect(password).toEqual({
      format_version: 2,
      algorithm: 'PBKDF2-HMAC-SHA-256-CHAINED',
      iterations: 900000,
      salt_length: 16,
      key_length: 32,
    })
  })

  it('拒绝重复初始化且不增加数据', async () => {
    const request = () =>
      workerExports.default.fetch(
        new Request('https://simlettra.test/api/initialization/complete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Simlettra-Init-Key': encodeInitializationKeyHeader(testEnvironment.INIT_KEY),
          },
          body: JSON.stringify({
            adminDisplayName: '系统管理员',
            domainName: 'example.com',
            localPart: 'owner',
            password: '长河-Glass-47-Quiet',
            timezone: 'Asia/Shanghai',
          }),
        }),
      )

    expect((await request()).status).toBe(201)
    expect((await request()).status).toBe(409)

    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{
      count: number
    }>()
    expect(row?.count).toBe(1)
  })

  it('错误 init_key 不会建立部分数据并会触发限速', async () => {
    const request = () =>
      workerExports.default.fetch(
        new Request('https://simlettra.test/api/initialization/authorize', {
          method: 'POST',
          headers: {
            'CF-Connecting-IP': '203.0.113.20',
            'X-Simlettra-Init-Key': encodeInitializationKeyHeader('错误的初始化密钥'),
          },
        }),
      )

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request()).status).toBe(401)
    }

    const blocked = await request()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()

    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{
      count: number
    }>()
    expect(row?.count).toBe(0)
  })
})
