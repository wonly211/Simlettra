import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0012 契约', () => {
  it('建立正式发信、逐收件人状态、Provider 路线和配额结构', async () => {
    const expected = [
      'domain_monthly_usage_periods',
      'domain_monthly_usage_reservations',
      'domain_outbound_route_entries',
      'domain_outbound_routes',
      'outbound_provider_configs',
      'outbound_provider_events',
      'outbound_route_snapshot_entries',
      'outbound_route_snapshots',
      'outbound_submission_attempt_recipients',
      'outbound_submission_attempts',
      'quota_policies',
      'send_idempotency_keys',
      'send_operations',
      'send_recipient_route_progress',
      'send_recipient_status_history',
      'send_recipients',
    ]
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).all<{ name: string }>()
    const names = new Set(tables.results.map((table) => table.name))
    expect(expected.filter((name) => names.has(name))).toEqual(expected)

    const policies = await env.DB.prepare(
      `SELECT quota_kind, limit_value FROM quota_policies ORDER BY quota_kind`,
    ).all<{ quota_kind: string; limit_value: number | null }>()
    expect(policies.results).toEqual([
      { quota_kind: 'daily_send_recipients', limit_value: 500 },
      { quota_kind: 'domain_monthly_send_recipients', limit_value: null },
    ])
  })

  it('就绪规则同时支持原始 MIME 和最终 MIME，且无外键违规', async () => {
    const trigger = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'validate_message_ready_insert'`,
    ).first<{ sql: string }>()
    expect(trigger?.sql).toContain("'raw_mime'")
    expect(trigger?.sql).toContain("'final_mime'")
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })
})
