import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0016 契约', () => {
  it('建立逻辑策略、账户、预留、账本与系统内拒绝事实', async () => {
    const expected = [
      'internal_delivery_rejections',
      'logical_storage_quota_policies',
      'logical_storage_reservations',
      'logical_storage_usage_accounts',
      'logical_storage_usage_entries',
    ]
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).all<{ name: string }>()
    const names = new Set(rows.results.map((row) => row.name))
    expect(expected.filter((name) => names.has(name))).toEqual(expected)
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('KV 与 R2 分别使用 100 MB 和 1 GB 的用户及组织默认值', async () => {
    const policies = await env.DB.prepare(
      `SELECT storage_mode, default_owner_type, limit_bytes
       FROM logical_storage_quota_policies
       WHERE owner_type = 'system_default' AND policy_status = 'active'
       ORDER BY storage_mode, default_owner_type`,
    ).all<{ storage_mode: string; default_owner_type: string; limit_bytes: number }>()
    expect(policies.results).toEqual([
      { storage_mode: 'kv', default_owner_type: 'organization', limit_bytes: 100_000_000 },
      { storage_mode: 'kv', default_owner_type: 'user', limit_bytes: 100_000_000 },
      { storage_mode: 'r2', default_owner_type: 'organization', limit_bytes: 1_000_000_000 },
      { storage_mode: 'r2', default_owner_type: 'user', limit_bytes: 1_000_000_000 },
    ])
  })
})
