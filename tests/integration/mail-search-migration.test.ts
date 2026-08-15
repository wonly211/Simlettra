import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0009 契约', () => {
  it('建立搜索状态、分块和内容空 FTS5 索引', async () => {
    const rows = await env.DB.prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name IN ('message_search_states', 'message_search_chunks', 'message_search_index')
       ORDER BY name`,
    ).all<{ type: string; name: string; sql: string }>()
    expect(rows.results).toHaveLength(3)
    expect(rows.results).toContainEqual(
      expect.objectContaining({ type: 'table', name: 'message_search_states' }),
    )
    expect(rows.results).toContainEqual(
      expect.objectContaining({ type: 'table', name: 'message_search_chunks' }),
    )
    expect(rows.results.find((row) => row.name === 'message_search_index')?.sql).toContain(
      'contentless_delete=1',
    )
  })

  it('当前 D1 运行时允许直接删除内容空索引行', async () => {
    await env.DB.prepare(
      `INSERT INTO message_search_index (rowid, body_tokens, scopes)
       VALUES (9001, '预算 算调 调整', 'usrtest')`,
    ).run()
    await expect(
      env.DB.prepare(`SELECT rowid FROM message_search_index WHERE message_search_index MATCH ?1`)
        .bind('"预算 算调 调整"')
        .first(),
    ).resolves.toEqual({ rowid: 9001 })
    await env.DB.prepare('DELETE FROM message_search_index WHERE rowid = 9001').run()
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS count FROM message_search_index').first(),
    ).resolves.toEqual({ count: 0 })
  })
})
