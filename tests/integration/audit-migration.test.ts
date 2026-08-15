import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0003 契约', () => {
  it('建立不可变安全审计表且不提供通用详情字段', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(audit_events)').all<{ name: string }>()

    expect(columns.results.map((row) => row.name)).toEqual([
      'id',
      'occurred_at',
      'actor_type',
      'actor_user_id',
      'action_name',
      'target_type',
      'target_reference',
      'outcome',
      'reason_code',
      'request_trace_id',
      'source_ip_text',
      'browser_family',
      'created_at',
    ])
    expect(columns.results.map((row) => row.name)).not.toContain('details')
  })

  it('拒绝改写已经写入的审计事件', async () => {
    await env.DB.prepare(
      `INSERT INTO audit_events (
        id, occurred_at, actor_type, actor_user_id, action_name,
        target_type, target_reference, outcome, reason_code,
        request_trace_id, source_ip_text, browser_family, created_at
       ) VALUES ('audit-1', 1, 'system', NULL, 'test.created',
         'system', 'singleton', 'succeeded', NULL,
         'trace-1', NULL, NULL, 1)`,
    ).run()

    await expect(
      env.DB.prepare("UPDATE audit_events SET outcome = 'failed' WHERE id = 'audit-1'").run(),
    ).rejects.toThrow()
  })

  it('应用当前正式迁移后没有外键违规', async () => {
    const result = await env.DB.prepare('PRAGMA foreign_key_check').all()
    expect(result.results).toEqual([])
  })
})
