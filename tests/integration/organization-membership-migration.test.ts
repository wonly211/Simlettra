import { env } from 'cloudflare:workers'
import { applyD1Migrations, reset, type D1Migration } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const testEnvironment = env as Env & { TEST_MIGRATIONS: D1Migration[] }

describe('正式迁移 0006 契约', () => {
  it('建立用户组织策略、成员关系和邀请记录', async () => {
    const result = await env.DB.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name IN (
         'user_organization_policies',
         'organization_memberships',
         'organization_invitations',
         'validate_organization_creation',
         'validate_organization_creator_transfer'
       )
       ORDER BY type, name`,
    ).all<{ type: string; name: string }>()

    expect(result.results).toEqual([
      { type: 'table', name: 'organization_invitations' },
      { type: 'table', name: 'organization_memberships' },
      { type: 'table', name: 'user_organization_policies' },
      { type: 'trigger', name: 'validate_organization_creation' },
      { type: 'trigger', name: 'validate_organization_creator_transfer' },
    ])
  })

  it('为迁移前已有用户补齐五个组织的默认额度', async () => {
    await reset()
    await applyD1Migrations(testEnvironment.DB, testEnvironment.TEST_MIGRATIONS.slice(0, 5))
    await insertUser('existing-user', '既有用户')

    await applyD1Migrations(testEnvironment.DB, testEnvironment.TEST_MIGRATIONS.slice(5, 6))

    const policy = await env.DB.prepare(
      `SELECT organization_limit, updated_by_user_id
       FROM user_organization_policies WHERE user_id = 'existing-user'`,
    ).first<{ organization_limit: number; updated_by_user_id: string | null }>()
    expect(policy).toEqual({ organization_limit: 5, updated_by_user_id: null })
  })

  it('在数据库边界阻止创建者超过组织额度', async () => {
    await insertUser('quota-user', '额度用户')
    await env.DB.prepare(
      `INSERT INTO user_organization_policies (
        user_id, organization_limit, updated_by_user_id, created_at, updated_at
       ) VALUES ('quota-user', 5, NULL, 100, 100)`,
    ).run()

    for (let index = 1; index <= 5; index += 1) {
      await insertOrganization(`organization-${index}`, `组织 ${index}`, 'quota-user')
    }

    await expect(insertOrganization('organization-6', '组织 6', 'quota-user')).rejects.toThrow(
      /组织创建额度已用完/u,
    )
  })

  it('只允许当前有效成员继承创建者身份', async () => {
    await Promise.all([
      insertUserWithPolicy('creator-user', '原创建者'),
      insertUserWithPolicy('member-user', '成员'),
      insertUserWithPolicy('outsider-user', '外部用户'),
    ])
    await insertOrganization('transfer-organization', '继承测试', 'creator-user')
    await env.DB.batch([
      membershipStatement('creator-membership', 'transfer-organization', 'creator-user'),
      membershipStatement('member-membership', 'transfer-organization', 'member-user'),
    ])

    await expect(
      env.DB.prepare(
        `UPDATE organizations SET creator_user_id = 'outsider-user', updated_at = 200
         WHERE id = 'transfer-organization'`,
      ).run(),
    ).rejects.toThrow(/继承者必须是当前有效组织成员/u)

    await expect(
      env.DB.prepare(
        `UPDATE organizations SET creator_user_id = 'member-user', updated_at = 200
         WHERE id = 'transfer-organization'`,
      ).run(),
    ).resolves.toMatchObject({ meta: { changes: 1 } })
  })

  it('应用当前全部正式迁移后没有外键违规', async () => {
    const result = await env.DB.prepare('PRAGMA foreign_key_check').all()
    expect(result.results).toEqual([])
  })
})

function insertUser(userId: string, displayName: string) {
  return env.DB.prepare(
    `INSERT INTO users (
      id, status, display_name, timezone, invitation_policy,
      deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
     ) VALUES (?1, 'active', ?2, 'Asia/Shanghai', 'manual',
       NULL, NULL, NULL, 100, 100)`,
  )
    .bind(userId, displayName)
    .run()
}

async function insertUserWithPolicy(userId: string, displayName: string) {
  await insertUser(userId, displayName)
  await env.DB.prepare(
    `INSERT INTO user_organization_policies (
      user_id, organization_limit, updated_by_user_id, created_at, updated_at
     ) VALUES (?1, 5, NULL, 100, 100)`,
  )
    .bind(userId)
    .run()
}

function insertOrganization(organizationId: string, name: string, creatorUserId: string) {
  return env.DB.prepare(
    `INSERT INTO organizations (
      id, name, creator_user_id, status, members_can_send,
      deletion_requested_at, deletion_due_at, created_at, updated_at
     ) VALUES (?1, ?2, ?3, 'active', 0, NULL, NULL, 100, 100)`,
  )
    .bind(organizationId, name, creatorUserId)
    .run()
}

function membershipStatement(id: string, organizationId: string, userId: string) {
  return env.DB.prepare(
    `INSERT INTO organization_memberships (
      id, organization_id, user_id, joined_at, left_at, left_reason
     ) VALUES (?1, ?2, ?3, 100, NULL, NULL)`,
  ).bind(id, organizationId, userId)
}
