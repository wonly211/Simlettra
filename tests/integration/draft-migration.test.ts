import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0011 契约', () => {
  it('建立草稿表并扩展统一对象登记', async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'drafts', 'draft_contents', 'draft_recipients',
         'draft_attachments', 'draft_mutation_keys'
       ) ORDER BY name`,
    ).all<{ name: string }>()
    expect(tables.results.map((row) => row.name)).toEqual([
      'draft_attachments',
      'draft_contents',
      'draft_mutation_keys',
      'draft_recipients',
      'drafts',
    ])

    const objectSql = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'object_registry'`,
    ).first<{ sql: string }>()
    expect(objectSql?.sql).toContain("owner_kind IN ('message', 'draft')")
    expect(objectSql?.sql).toContain("'draft_body'")
    expect(objectSql?.sql).toContain("'draft_attachment'")

    const receiveSql = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'receive_operations'`,
    ).first<{ sql: string }>()
    expect(receiveSql?.sql).toContain('REFERENCES object_registry')
    expect(receiveSql?.sql).not.toContain('before_drafts')

    const migrationArtifacts = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE name LIKE '%before_drafts%'`,
    ).all<{ name: string }>()
    expect(migrationArtifacts.results).toEqual([])

    const restoredTriggers = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name IN (
         'validate_receive_raw_object_update',
         'validate_visible_receive_has_search_task',
         'validate_visible_receive_has_conversation_task'
       ) ORDER BY name`,
    ).all<{ name: string }>()
    expect(restoredTriggers.results.map((row) => row.name)).toEqual([
      'validate_receive_raw_object_update',
      'validate_visible_receive_has_conversation_task',
      'validate_visible_receive_has_search_task',
    ])
  })

  it('正式迁移完成后没有外键违规', async () => {
    const result = await env.DB.prepare('PRAGMA foreign_key_check').all()
    expect(result.results).toEqual([])
  })
})
