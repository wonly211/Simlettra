import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0002 契约', () => {
  it('建立会话与双维度登录限速表', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'login_rate_limits') ORDER BY name",
    ).all<{ name: string }>()

    expect(result.results.map((row) => row.name)).toEqual(['login_rate_limits', 'sessions'])
  })

  it('会话表只保存令牌摘要和有效期元数据', async () => {
    const result = await env.DB.prepare('PRAGMA table_info(sessions)').all<{ name: string }>()

    expect(result.results.map((row) => row.name)).toEqual([
      'id',
      'user_id',
      'token_digest',
      'csrf_token_digest',
      'client_label',
      'created_at',
      'last_activity_at',
      'idle_expires_at',
      'absolute_expires_at',
      'revoked_at',
      'revoked_reason',
    ])
  })

  it('应用当前正式迁移后没有外键违规', async () => {
    const result = await env.DB.prepare('PRAGMA foreign_key_check').all()
    expect(result.results).toEqual([])
  })
})
