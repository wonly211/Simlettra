import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0010 契约', () => {
  it('建立邮件关系和邮箱范围会话三张表', async () => {
    const rows = await env.DB.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name IN (
         'message_relations',
         'mailbox_conversations',
         'mailbox_conversation_entries'
       )
       ORDER BY name`,
    ).all<{ type: string; name: string }>()

    expect(rows.results).toEqual([
      { type: 'table', name: 'mailbox_conversation_entries' },
      { type: 'table', name: 'mailbox_conversations' },
      { type: 'table', name: 'message_relations' },
    ])
  })

  it('正式迁移完成后没有外键违规', async () => {
    await expect(env.DB.prepare('PRAGMA foreign_key_check').all()).resolves.toMatchObject({
      results: [],
    })
  })
})
