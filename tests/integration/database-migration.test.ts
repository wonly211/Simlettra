import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'

const testEnvironment = env as Env & { INIT_KEY: string }

const businessTables = [
  'address_bindings',
  'address_claims',
  'email_addresses',
  'initialization_rate_limits',
  'mail_domains',
  'organizations',
  'password_credentials',
  'system_instances',
  'user_address_preferences',
  'users',
]

describe('正式迁移 0001 契约', () => {
  it('建立全部十张基础业务表', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>()
    const existingNames = new Set(result.results.map((row) => row.name))

    expect(businessTables.filter((name) => existingNames.has(name))).toEqual(businessTables)
  })

  it('域名表不保存应用内所有权验证状态', async () => {
    const result = await env.DB.prepare('PRAGMA table_info(mail_domains)').all<{ name: string }>()
    const columns = result.results.map((row) => row.name)

    expect(columns).toEqual([
      'id',
      'canonical_name',
      'display_name',
      'status',
      'catch_all_mode',
      'paused_at',
      'created_at',
      'updated_at',
    ])
    expect(columns).not.toContain('verification_pending')
    expect(columns).not.toContain('verified_at')
  })

  it('迁移完成后没有外键违规', async () => {
    const result = await env.DB.prepare('PRAGMA foreign_key_check').all()

    expect(result.results).toEqual([])
  })

  it('初始化域名冲突时整批回滚前置写入', async () => {
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO mail_domains (
        id, canonical_name, display_name, status, catch_all_mode, created_at, updated_at
       ) VALUES ('existing-domain', 'example.com', 'example.com', 'active', 'reject', ?1, ?1)`,
    )
      .bind(now)
      .run()

    const response = await workerExports.default.fetch(
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

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'initialization_conflict',
        message: '初始化数据发生冲突，没有保存任何部分数据',
      },
    })

    const counts = await Promise.all(
      businessTables.map(async (table) => {
        const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
          count: number
        }>()
        return [table, row?.count ?? 0] as const
      }),
    )

    expect(Object.fromEntries(counts)).toEqual({
      address_bindings: 0,
      address_claims: 0,
      email_addresses: 0,
      initialization_rate_limits: 0,
      mail_domains: 1,
      organizations: 0,
      password_credentials: 0,
      system_instances: 0,
      user_address_preferences: 0,
      users: 0,
    })
  })
})
