import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0015 契约', () => {
  it('建立资源配置、阈值、快照和容量预留四张表', async () => {
    const expected = [
      'cloudflare_resource_configurations',
      'platform_capacity_reservations',
      'platform_resource_snapshots',
      'platform_resource_thresholds',
    ]
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).all<{ name: string }>()
    const names = new Set(rows.results.map((row) => row.name))
    expect(expected.filter((name) => names.has(name))).toEqual(expected)
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('默认使用百分之八十预警和百分之九十五停止并保护快照不可改写', async () => {
    const thresholds = await env.DB.prepare(
      `SELECT resource_kind, warning_ratio_bps, stop_ratio_bps
       FROM platform_resource_thresholds WHERE threshold_status = 'active'
       ORDER BY resource_kind`,
    ).all<{ resource_kind: string; warning_ratio_bps: number; stop_ratio_bps: number }>()
    expect(thresholds.results).toEqual([
      { resource_kind: 'd1', warning_ratio_bps: 8000, stop_ratio_bps: 9500 },
      { resource_kind: 'kv', warning_ratio_bps: 8000, stop_ratio_bps: 9500 },
      { resource_kind: 'r2', warning_ratio_bps: 8000, stop_ratio_bps: 9500 },
    ])
    const trigger = await env.DB.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'prevent_platform_resource_snapshot_update'`,
    ).first<{ sql: string }>()
    expect(trigger?.sql).toContain('平台资源快照不可修改')
    const columns = await env.DB.prepare(`PRAGMA table_info(platform_resource_snapshots)`).all<{
      name: string
    }>()
    expect(columns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(['current_resource_limit_bytes', 'current_resource_remaining_bytes']),
    )
  })
})
