import { env } from 'cloudflare:workers'
import { applyD1Migrations, reset, type D1Migration } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const testEnvironment = env as Env & { TEST_MIGRATIONS: D1Migration[] }

describe('正式迁移 0004 契约', () => {
  it('建立独立的用户别名策略表与数据库额度触发器', async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_alias_policies'",
    ).all<{ name: string }>()
    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'validate_current_personal_alias_binding'",
    ).all<{ name: string }>()

    expect(tables.results).toEqual([{ name: 'user_alias_policies' }])
    expect(triggers.results).toEqual([{ name: 'validate_current_personal_alias_binding' }])
  })

  it('为迁移前已经存在的用户补齐二十个且允许自助创建的默认策略', async () => {
    await reset()
    await applyD1Migrations(testEnvironment.DB, testEnvironment.TEST_MIGRATIONS.slice(0, 3))
    await env.DB.prepare(
      `INSERT INTO users (
        id, status, display_name, timezone, invitation_policy,
        deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
       ) VALUES ('existing-user', 'active', '既有用户', 'Asia/Shanghai', 'manual',
         NULL, NULL, NULL, 100, 100)`,
    ).run()

    await applyD1Migrations(testEnvironment.DB, testEnvironment.TEST_MIGRATIONS.slice(3, 4))

    const policy = await env.DB.prepare(
      `SELECT alias_limit, self_creation_enabled, updated_by_user_id
       FROM user_alias_policies WHERE user_id = 'existing-user'`,
    ).first<{
      alias_limit: number
      self_creation_enabled: number
      updated_by_user_id: string | null
    }>()
    expect(policy).toEqual({
      alias_limit: 20,
      self_creation_enabled: 1,
      updated_by_user_id: null,
    })
  })

  it('在数据库边界拒绝超过用户额度的新个人别名绑定', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (
          id, status, display_name, timezone, invitation_policy,
          deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
         ) VALUES ('quota-user', 'active', '额度用户', 'Asia/Shanghai', 'manual',
           NULL, NULL, NULL, 100, 100)`,
      ),
      env.DB.prepare(
        `INSERT INTO user_alias_policies (
          user_id, alias_limit, self_creation_enabled, updated_by_user_id, created_at, updated_at
         ) VALUES ('quota-user', 0, 1, NULL, 100, 100)`,
      ),
      env.DB.prepare(
        `INSERT INTO mail_domains (
          id, canonical_name, display_name, status, catch_all_mode,
          paused_at, created_at, updated_at
         ) VALUES ('quota-domain', 'example.com', 'example.com', 'active', 'reject',
           NULL, 100, 100)`,
      ),
      env.DB.prepare(
        `INSERT INTO email_addresses (
          id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
         ) VALUES ('quota-address', 'quota-domain', 'alias@example.com',
           'alias@example.com', NULL, 100, NULL)`,
      ),
      env.DB.prepare(
        `INSERT INTO address_claims (
          canonical_address, address_id, status, reserved_until, created_at, updated_at
         ) VALUES ('alias@example.com', 'quota-address', 'active', NULL, 100, 100)`,
      ),
    ])

    await expect(
      env.DB.prepare(
        `INSERT INTO address_bindings (
          id, address_id, owner_type, user_id, organization_id,
          address_role, started_at, ended_at, ended_reason
         ) VALUES ('quota-binding', 'quota-address', 'user', 'quota-user', NULL,
           'alias', 100, NULL, NULL)`,
      ).run(),
    ).rejects.toThrow(/个人别名额度已用完/u)
  })

  it('应用当前正式迁移后没有外键违规', async () => {
    const result = await env.DB.prepare('PRAGMA foreign_key_check').all()
    expect(result.results).toEqual([])
  })
})
