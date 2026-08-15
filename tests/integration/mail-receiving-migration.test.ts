import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0007 契约', () => {
  it('建立邮件、对象、收信操作和冻结路由结构', async () => {
    const result = await env.DB.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name IN (
         'messages', 'message_header_addresses', 'message_deliveries',
         'mailbox_entries', 'mailbox_entry_deliveries', 'object_registry',
         'message_integrity_states', 'receive_operations',
         'receive_operation_routes', 'message_deduplication_keys',
         'validate_message_ready_insert', 'validate_receive_route_commit'
       )
       ORDER BY type, name`,
    ).all<{ type: string; name: string }>()

    expect(result.results).toHaveLength(12)
    expect(result.results).toContainEqual({ type: 'table', name: 'object_registry' })
    expect(result.results).toContainEqual({ type: 'table', name: 'receive_operations' })
    expect(result.results).toContainEqual({
      type: 'trigger',
      name: 'validate_message_ready_insert',
    })
  })

  it('应用当前全部正式迁移后没有外键违规', async () => {
    const result = await env.DB.prepare('PRAGMA foreign_key_check').all()
    expect(result.results).toEqual([])
  })
})
