import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

describe('正式迁移 0020 契约', () => {
  beforeEach(async () => {
    await env.DB.batch([
      userStatement('lifecycle-admin', '原管理员'),
      userStatement('lifecycle-successor', '继任管理员'),
      userStatement('lifecycle-member', '普通用户'),
      env.DB.prepare(
        `INSERT INTO system_instances (
          singleton_id, storage_mode, current_admin_user_id,
          initialized_at, created_at, updated_at
         ) VALUES (1, 'r2', 'lifecycle-admin', 100, 100, 100)`,
      ),
    ])
  })

  it('建立恢复会话、清理检查点和生命周期触发器', async () => {
    const result = await env.DB.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name IN (
         'account_recovery_sessions',
         'account_deletion_membership_snapshots',
         'lifecycle_cleanup_children',
         'lifecycle_cleanup_checkpoints',
         'prevent_current_administrator_deletion',
         'validate_system_administrator_transfer',
         'validate_user_lifecycle_transition',
         'validate_organization_lifecycle_transition'
       ) ORDER BY type, name`,
    ).all<{ type: string; name: string }>()

    expect(result.results).toEqual([
      { type: 'table', name: 'account_deletion_membership_snapshots' },
      { type: 'table', name: 'account_recovery_sessions' },
      { type: 'table', name: 'lifecycle_cleanup_checkpoints' },
      { type: 'table', name: 'lifecycle_cleanup_children' },
      { type: 'trigger', name: 'prevent_current_administrator_deletion' },
      { type: 'trigger', name: 'validate_organization_lifecycle_transition' },
      { type: 'trigger', name: 'validate_system_administrator_transfer' },
      { type: 'trigger', name: 'validate_user_lifecycle_transition' },
    ])
  })

  it('当前管理员必须先转让给已启用用户才能进入注销冷静期', async () => {
    await expect(
      env.DB.prepare(
        `UPDATE users SET status = 'deletion_pending',
          deletion_requested_at = 200, deletion_due_at = 300, updated_at = 200
         WHERE id = 'lifecycle-admin'`,
      ).run(),
    ).rejects.toThrow(/唯一系统管理员必须先转让管理员身份/u)

    await env.DB.prepare(
      `UPDATE users SET status = 'disabled', updated_at = 150
       WHERE id = 'lifecycle-successor'`,
    ).run()
    await expect(
      env.DB.prepare(
        `UPDATE system_instances SET current_admin_user_id = 'lifecycle-successor', updated_at = 200
         WHERE singleton_id = 1`,
      ).run(),
    ).rejects.toThrow(/新系统管理员必须是当前已启用用户/u)

    await env.DB.prepare(
      `UPDATE users SET status = 'active', updated_at = 201
       WHERE id = 'lifecycle-successor'`,
    ).run()
    await env.DB.prepare(
      `UPDATE system_instances SET current_admin_user_id = 'lifecycle-successor', updated_at = 202
       WHERE singleton_id = 1`,
    ).run()
    await expect(
      env.DB.prepare(
        `UPDATE users SET status = 'deletion_pending',
          deletion_requested_at = 203, deletion_due_at = 303, updated_at = 203
         WHERE id = 'lifecycle-admin'`,
      ).run(),
    ).resolves.toMatchObject({ meta: { changes: 1 } })
  })

  it('恢复会话只允许属于冷静期内的非管理员用户', async () => {
    await expect(recoverySessionStatement('lifecycle-member', 'recovery-before')).rejects.toThrow(
      /注销恢复会话只能为冷静期内的非管理员用户/u,
    )

    await env.DB.prepare(
      `UPDATE users SET status = 'deletion_pending',
        deletion_requested_at = 200, deletion_due_at = 400, updated_at = 200
       WHERE id = 'lifecycle-member'`,
    ).run()
    await expect(
      recoverySessionStatement('lifecycle-member', 'recovery-valid'),
    ).resolves.toMatchObject({ meta: { changes: 1 } })

    await expect(recoverySessionStatement('lifecycle-admin', 'recovery-admin')).rejects.toThrow(
      /注销恢复会话只能为冷静期内的非管理员用户/u,
    )
  })

  it('用户和组织状态必须按照已确认生命周期流转', async () => {
    await expect(
      env.DB.prepare(
        `UPDATE users SET status = 'deleted', deleted_at = 200, updated_at = 200
         WHERE id = 'lifecycle-member'`,
      ).run(),
    ).rejects.toThrow(/用户生命周期(?:状态变化无效|时间字段与状态不匹配)/u)

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_organization_policies (
          user_id, organization_limit, updated_by_user_id, created_at, updated_at
         ) VALUES ('lifecycle-member', 5, NULL, 100, 100)`,
      ),
      env.DB.prepare(
        `INSERT INTO organizations (
          id, name, creator_user_id, status, members_can_send,
          deletion_requested_at, deletion_due_at, created_at, updated_at
         ) VALUES ('lifecycle-organization', '生命周期组织', 'lifecycle-member',
           'active', 0, NULL, NULL, 100, 100)`,
      ),
    ])
    await expect(
      env.DB.prepare(
        `UPDATE organizations SET status = 'deleting',
          deletion_requested_at = 200, deletion_due_at = 300, updated_at = 200
         WHERE id = 'lifecycle-organization'`,
      ).run(),
    ).rejects.toThrow(/组织生命周期状态变化无效/u)
  })
})

function userStatement(userId: string, displayName: string) {
  return env.DB.prepare(
    `INSERT INTO users (
      id, status, display_name, timezone, invitation_policy,
      deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
     ) VALUES (?1, 'active', ?2, 'Asia/Shanghai', 'manual',
       NULL, NULL, NULL, 100, 100)`,
  ).bind(userId, displayName)
}

function recoverySessionStatement(userId: string, sessionId: string) {
  return env.DB.prepare(
    `INSERT INTO account_recovery_sessions (
      id, user_id, token_digest, csrf_token_digest, client_label,
      created_at, expires_at, last_activity_at, consumed_at,
      revoked_at, revoked_reason
     ) VALUES (?1, ?2, randomblob(32), randomblob(32), '测试浏览器',
       210, 310, 210, NULL, NULL, NULL)`,
  )
    .bind(sessionId, userId)
    .run()
}
