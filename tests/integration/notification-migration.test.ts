import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0013 契约', () => {
  it('建立通知订阅、来源范围、加密凭据、操作与尝试五张表', async () => {
    const expected = [
      'notification_attempts',
      'notification_operations',
      'notification_subscription_scopes',
      'notification_subscription_secrets',
      'notification_subscriptions',
    ]
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).all<{ name: string }>()
    const names = new Set(rows.results.map((row) => row.name))
    expect(expected.filter((name) => names.has(name))).toEqual(expected)
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('通知操作与尝试的身份不可修改，并保留结果未知终态', async () => {
    const operationSql = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_operations'`,
    ).first<{ sql: string }>()
    const operationTrigger = await env.DB.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'prevent_notification_operation_identity_change'`,
    ).first<{ sql: string }>()
    const attemptTrigger = await env.DB.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'validate_notification_attempt_transition'`,
    ).first<{ sql: string }>()
    expect(operationSql?.sql).toContain("'unknown'")
    expect(operationTrigger?.sql).toContain('payload_sha256')
    expect(attemptTrigger?.sql).toContain("'unknown'")
  })
})
