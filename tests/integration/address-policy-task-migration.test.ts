import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('正式迁移 0005 契约', () => {
  it('建立全局地址策略、删除操作与后台任务结构', async () => {
    const objects = await env.DB.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name IN (
         'address_policy_settings', 'address_policy_terms',
         'deletion_operations', 'deletion_operation_steps',
         'background_tasks', 'background_task_attempts',
         'validate_new_email_address_policy',
         'validate_background_task_transition'
       ) ORDER BY type, name`,
    ).all<{ type: string; name: string }>()

    expect(objects.results).toHaveLength(8)
    expect(objects.results.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        'address_policy_settings',
        'address_policy_terms',
        'deletion_operations',
        'deletion_operation_steps',
        'background_tasks',
        'background_task_attempts',
        'validate_new_email_address_policy',
        'validate_background_task_transition',
      ]),
    )
  })

  it('默认最短长度为一且个人别名删除后立即释放', async () => {
    const settings = await env.DB.prepare(
      `SELECT minimum_local_part_length, alias_retention_days, policy_version
       FROM address_policy_settings WHERE singleton_id = 1`,
    ).first<{
      minimum_local_part_length: number
      alias_retention_days: number
      policy_version: number
    }>()

    expect(settings).toEqual({
      minimum_local_part_length: 1,
      alias_retention_days: 0,
      policy_version: 1,
    })
  })

  it('数据库边界拒绝短前缀、禁止文字和保留名称', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mail_domains (
          id, canonical_name, display_name, status, catch_all_mode,
          paused_at, created_at, updated_at
         ) VALUES ('policy-domain', 'example.com', 'example.com', 'active', 'reject',
           NULL, 100, 100)`,
      ),
      env.DB.prepare(
        `UPDATE address_policy_settings
         SET minimum_local_part_length = 4, policy_version = 2, updated_at = 100
         WHERE singleton_id = 1`,
      ),
      env.DB.prepare(
        `INSERT INTO address_policy_terms (
          id, term_kind, normalized_value, created_by_user_id, created_at
         ) VALUES ('blocked-term', 'blocked_substring', 'spam', NULL, 100)`,
      ),
      env.DB.prepare(
        `INSERT INTO address_policy_terms (
          id, term_kind, normalized_value, created_by_user_id, created_at
         ) VALUES ('reserved-term', 'reserved_name', 'admin', NULL, 100)`,
      ),
    ])

    await expect(insertAddress('short-address', 'abc@example.com')).rejects.toThrow(/最短长度/u)
    await expect(insertAddress('blocked-address', 'myspam@example.com')).rejects.toThrow(
      /禁止文字/u,
    )
    await expect(insertAddress('reserved-address', 'admin@example.com')).rejects.toThrow(
      /保留名称/u,
    )
    await expect(insertAddress('accepted-address', 'letters@example.com')).resolves.toBeDefined()
  })

  it('应用当前正式迁移后没有外键违规', async () => {
    const result = await env.DB.prepare('PRAGMA foreign_key_check').all()
    expect(result.results).toEqual([])
  })
})

function insertAddress(id: string, address: string) {
  return env.DB.prepare(
    `INSERT INTO email_addresses (
      id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
     ) VALUES (?1, 'policy-domain', ?2, ?2, NULL, 100, NULL)`,
  )
    .bind(id, address)
    .run()
}
