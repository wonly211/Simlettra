import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0014 契约', () => {
  it('建立外部邮箱验证、规则、操作和尝试七张表', async () => {
    const expected = [
      'external_email_targets',
      'external_email_verification_attempts',
      'external_email_verifications',
      'mail_forward_attempts',
      'mail_forward_operations',
      'mail_forwarding_rule_addresses',
      'mail_forwarding_rules',
    ]
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).all<{ name: string }>()
    const names = new Set(rows.results.map((row) => row.name))
    expect(expected.filter((name) => names.has(name))).toEqual(expected)
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('保留结果未知终态并阻止未知结果自动切换备用服务', async () => {
    const operation = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_forward_operations'`,
    ).first<{ sql: string }>()
    const forwardTrigger = await env.DB.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'prevent_mail_forward_fallback_after_unknown'`,
    ).first<{ sql: string }>()
    const verificationTrigger = await env.DB.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'prevent_external_email_verification_fallback_after_unknown'`,
    ).first<{ sql: string }>()
    expect(operation?.sql).toContain("'unknown'")
    expect(forwardTrigger?.sql).toContain("attempt_status = 'unknown'")
    expect(verificationTrigger?.sql).toContain("attempt_status = 'unknown'")
  })
})
