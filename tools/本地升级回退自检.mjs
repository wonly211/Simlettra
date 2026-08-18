import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsDirectory = join(projectDirectory, 'migrations')
const root = await mkdtemp(join(tmpdir(), 'simlettra-upgrade-rollback-test-'))
const previousVersion = '0023-账号邀请码注册.sql'
const targetVersions = [
  '0024-修复早期逻辑配额表兼容性.sql',
  '0025-补齐早期内部投递容量拒绝事实.sql',
  '0026-修复后台发信任务重试状态.sql',
]
const targetVersion = targetVersions.at(-1)
const rebuiltStorageTables = new Set([
  'logical_storage_quota_policies',
  'logical_storage_reservations',
  'logical_storage_usage_entries',
])
const intentionallyChangedSchema = new Set(['validate_background_task_transition'])
let source
let upgraded
let rollback

try {
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}-.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  assert.equal(migrations.at(-1), targetVersion, '正式迁移目录的最新版本与演练目标不一致')
  assert.deepEqual(migrations.slice(-targetVersions.length), targetVersions, '升级目标顺序不一致')
  assert.equal(
    migrations.at(-(targetVersions.length + 1)),
    previousVersion,
    '升级前版本必须紧邻演练目标',
  )

  const sourcePath = join(root, '升级来源.sqlite')
  const snapshotPath = join(root, '升级前快照.sqlite')
  const rollbackPath = join(root, '回退目标.sqlite')
  source = new DatabaseSync(sourcePath)
  source.exec('PRAGMA foreign_keys = ON;')
  createMigrationLedger(source)
  await applyMigrations(source, migrations.slice(0, -targetVersions.length))
  seedRepresentativeData(source)

  const before = captureEvidence(source)
  assert.equal(before.migrationVersion, previousVersion)
  assert.deepEqual(before.foreignKeyViolations, [])
  source.close()
  source = undefined
  await copyFile(sourcePath, snapshotPath)

  upgraded = new DatabaseSync(sourcePath)
  upgraded.exec('PRAGMA foreign_keys = ON;')
  await applyMigrations(upgraded, targetVersions)
  const after = captureEvidence(upgraded, before.schemaNames)
  assert.equal(after.migrationVersion, targetVersion)
  assert.deepEqual(after.foreignKeyViolations, [])
  assert.equal(after.stableSchemaSha256, before.stableSchemaSha256)
  assert.equal(after.representativeDataSha256, before.representativeDataSha256)
  assert.deepEqual(after.existingTableCounts, before.existingTableCounts)
  verifyStorageQuotaCompatibility(upgraded)
  verifyAccountRegistrationInvitations(upgraded)
  verifyExhaustedBackgroundTaskRepair(upgraded)
  upgraded.close()
  upgraded = undefined

  await copyFile(snapshotPath, rollbackPath)
  rollback = new DatabaseSync(rollbackPath)
  rollback.exec('PRAGMA foreign_keys = ON;')
  const restored = captureEvidence(rollback)
  assert.equal(restored.migrationVersion, previousVersion)
  assert.deepEqual(restored.foreignKeyViolations, [])
  assert.equal(restored.representativeDataSha256, before.representativeDataSha256)
  assert.equal(
    rollback
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE name = 'account_registration_invitations'`,
      )
      .get().count,
    1,
  )
  assert.equal(
    rollback
      .prepare(
        `SELECT COUNT(*) AS count FROM d1_migrations
         WHERE name IN (${targetVersions.map(() => '?').join(', ')})`,
      )
      .get(...targetVersions).count,
    0,
  )
  rollback.close()
  rollback = undefined

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        previousVersion,
        targetVersion,
        migrationCount: migrations.length,
        preservedTableCount: Object.keys(before.existingTableCounts).length,
        existingSchemaSha256: before.existingSchemaSha256,
        representativeDataSha256: before.representativeDataSha256,
        checks: [
          '升级前外键检查',
          '正式迁移顺序',
          '逻辑配额表之外的既有结构未改写',
          '既有表行数未变化',
          '代表性数据未变化',
          '逻辑配额策略、预留、用量与触发器完整',
          '内部投递容量拒绝事实完整',
          '账号邀请码一次性使用与域名删除约束',
          '耗尽重试次数的后台任务正确收口',
          '独立回退目标恢复',
        ],
      },
      null,
      2,
    )}\n`,
  )
} finally {
  for (const database of [rollback, upgraded, source]) {
    try {
      database?.close()
    } catch {
      // 数据库可能已经关闭；清理阶段只确保不再占用临时文件。
    }
  }
  await rm(root, { force: true, recursive: true })
}

function createMigrationLedger(database) {
  database.exec(`
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

async function applyMigrations(database, names) {
  for (const name of names) {
    const sql = await readFile(join(migrationsDirectory, name), 'utf8')
    database.exec('BEGIN IMMEDIATE;')
    try {
      database.exec(sql)
      database.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name)
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw new Error(`正式迁移执行失败：${name}`, { cause: error })
    }
  }
}

function seedRepresentativeData(database) {
  const now = 1_800_000_000_000
  database.exec('BEGIN IMMEDIATE;')
  try {
    database
      .prepare(
        `INSERT INTO users (
           id, status, display_name, timezone, invitation_policy,
           deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
         ) VALUES (?, 'active', '升级演练管理员', 'Asia/Shanghai', 'manual',
                   NULL, NULL, NULL, ?, ?)`,
      )
      .run('upgrade-admin', now, now)
    database
      .prepare(
        `INSERT INTO system_instances (
           singleton_id, storage_mode, current_admin_user_id,
           initialized_at, created_at, updated_at
         ) VALUES (1, 'r2', ?, ?, ?, ?)`,
      )
      .run('upgrade-admin', now, now, now)
    database
      .prepare(
        `INSERT INTO user_alias_policies (
           user_id, alias_limit, self_creation_enabled,
           updated_by_user_id, created_at, updated_at
         ) VALUES (?, 20, 1, ?, ?, ?)`,
      )
      .run('upgrade-admin', 'upgrade-admin', now, now)
    database
      .prepare(
        `INSERT INTO user_organization_policies (
           user_id, organization_limit, updated_by_user_id, created_at, updated_at
         ) VALUES (?, 5, ?, ?, ?)`,
      )
      .run('upgrade-admin', 'upgrade-admin', now, now)
    database
      .prepare(
        `INSERT INTO logical_storage_reservations (
           id, storage_usage_account_id, quota_policy_id,
           operation_kind, operation_reference, reserved_bytes,
           limit_bytes_snapshot, reservation_key_digest, reservation_status,
           expires_at, committed_at, released_at, created_at, updated_at
         ) VALUES (
           'upgrade-reservation', 'storage-user-upgrade-admin-r2',
           'logical-storage-r2-user-v1', 'migration', 'upgrade:selfcheck', 64,
           1000000000, ?, 'reserved', ?, NULL, NULL, ?, ?
         )`,
      )
      .run(Buffer.alloc(32, 21), now + 60_000, now, now)
    database
      .prepare(
        `UPDATE logical_storage_reservations
         SET reservation_status = 'committed', committed_at = ?, updated_at = ?
         WHERE id = 'upgrade-reservation'`,
      )
      .run(now + 1, now + 1)
    database
      .prepare(
        `INSERT INTO logical_storage_usage_entries (
           id, storage_usage_account_id, storage_reservation_id,
           entry_kind, owner_reference, bytes_delta,
           idempotency_key_digest, committed_at, created_at
         ) VALUES (
           'upgrade-usage-entry', 'storage-user-upgrade-admin-r2',
           'upgrade-reservation', 'migration', 'upgrade:selfcheck', 64,
           ?, ?, ?
         )`,
      )
      .run(Buffer.alloc(32, 22), now + 1, now + 1)
    database
      .prepare(
        `INSERT INTO mail_domains (
           id, canonical_name, display_name, status, catch_all_mode,
           paused_at, created_at, updated_at
         ) VALUES ('upgrade-domain', 'example.com', 'example.com', 'active', 'reject',
                   NULL, ?, ?)`,
      )
      .run(now, now)
    seedExhaustedBackgroundTask(database, now)
    database.exec('COMMIT;')
  } catch (error) {
    database.exec('ROLLBACK;')
    throw error
  }
}

function seedExhaustedBackgroundTask(database, now) {
  const taskId = 'upgrade-exhausted-background-task'
  database
    .prepare(
      `INSERT INTO background_tasks (
         id, task_type, target_type, target_reference, input_version,
         task_key_digest, task_status, priority, attempt_count, max_attempts,
         next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
         last_error_code, last_error_summary, last_error_at, completed_at,
         created_at, updated_at
       ) VALUES (
         ?, 'submit_outbound_send', 'send_operation', 'upgrade-send-operation', 1,
         ?, 'pending', 1, 0, 5,
         ?, NULL, 0, NULL,
         NULL, NULL, NULL, NULL,
         ?, ?
       )`,
    )
    .run(taskId, Buffer.alloc(32, 23), now, now, now)

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const runningAt = now + attempt * 10
    database
      .prepare(
        `UPDATE background_tasks
         SET task_status = 'running', attempt_count = ?,
             next_attempt_at = NULL, lease_owner_reference = ?,
             lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(attempt, `upgrade-worker-${attempt}`, attempt, runningAt + 5, runningAt, taskId)
    database
      .prepare(
        `UPDATE background_tasks
         SET task_status = 'retry_wait', next_attempt_at = ?,
             lease_owner_reference = NULL, lease_expires_at = NULL,
             last_error_code = 'temporary_dependency_unavailable',
             last_error_summary = '升级前任务等待重试',
             last_error_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(runningAt + 1, runningAt + 1, runningAt + 1, taskId)
  }
}

function captureEvidence(database, existingSchemaNames) {
  const schemaRows = database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'message_search_index_%'
         AND name <> 'd1_migrations'
       ORDER BY type, name`,
    )
    .all()
  const selectedSchema = existingSchemaNames
    ? schemaRows.filter((row) => existingSchemaNames.includes(row.name))
    : schemaRows
  const tableNames = schemaRows
    .filter(
      (row) =>
        row.type === 'table' &&
        !row.name.startsWith('scheduled_maintenance_') &&
        (!existingSchemaNames || existingSchemaNames.includes(row.name)),
    )
    .map((row) => row.name)
  const existingTableCounts = Object.fromEntries(
    tableNames.map((name) => [
      name,
      database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count,
    ]),
  )
  const representative = {
    users: database.prepare(`SELECT * FROM users ORDER BY id`).all(),
    systemInstances: database.prepare(`SELECT * FROM system_instances ORDER BY singleton_id`).all(),
    mailDomains: database.prepare(`SELECT * FROM mail_domains ORDER BY id`).all(),
    aliasPolicies: database.prepare(`SELECT * FROM user_alias_policies ORDER BY user_id`).all(),
    organizationPolicies: database
      .prepare(`SELECT * FROM user_organization_policies ORDER BY user_id`)
      .all(),
    storageAccounts: database
      .prepare(`SELECT * FROM logical_storage_usage_accounts ORDER BY id`)
      .all(),
    storagePolicies: database
      .prepare(`SELECT * FROM logical_storage_quota_policies ORDER BY id`)
      .all(),
    storageReservations: database
      .prepare(`SELECT * FROM logical_storage_reservations ORDER BY id`)
      .all(),
    storageUsageEntries: database
      .prepare(`SELECT * FROM logical_storage_usage_entries ORDER BY id`)
      .all(),
  }
  const stableSchema = selectedSchema.filter(
    (row) => !rebuiltStorageTables.has(row.tbl_name) && !intentionallyChangedSchema.has(row.name),
  )
  return {
    migrationVersion: database
      .prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
      .get().name,
    schemaNames: schemaRows.map((row) => row.name),
    existingSchemaSha256: digest(selectedSchema),
    stableSchemaSha256: digest(stableSchema),
    representativeDataSha256: digest(representative),
    existingTableCounts,
    foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all(),
  }
}

function verifyExhaustedBackgroundTaskRepair(database) {
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT task_status, attempt_count, max_attempts, next_attempt_at,
                  lease_owner_reference, lease_expires_at, last_error_code
           FROM background_tasks
           WHERE id = 'upgrade-exhausted-background-task'`,
        )
        .get(),
    },
    {
      task_status: 'needs_attention',
      attempt_count: 5,
      max_attempts: 5,
      next_attempt_at: null,
      lease_owner_reference: null,
      lease_expires_at: null,
      last_error_code: 'temporary_dependency_unavailable',
    },
  )
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'trigger' AND name = 'validate_background_task_transition'`,
      )
      .get().count,
    1,
  )
}

function verifyStorageQuotaCompatibility(database) {
  assert.deepEqual(
    database
      .prepare(
        `SELECT storage_mode, default_owner_type, limit_bytes
         FROM logical_storage_quota_policies
         WHERE owner_type = 'system_default' AND policy_status = 'active'
         ORDER BY storage_mode, default_owner_type`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { storage_mode: 'kv', default_owner_type: 'organization', limit_bytes: 100000000 },
      { storage_mode: 'kv', default_owner_type: 'user', limit_bytes: 100000000 },
      { storage_mode: 'r2', default_owner_type: 'organization', limit_bytes: 1000000000 },
      { storage_mode: 'r2', default_owner_type: 'user', limit_bytes: 1000000000 },
    ],
  )
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM logical_storage_reservations
         WHERE id = 'upgrade-reservation' AND quota_policy_id = 'logical-storage-r2-user-v1'
           AND reservation_status = 'committed'`,
      )
      .get().count,
    1,
  )
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM logical_storage_usage_entries
         WHERE id = 'upgrade-usage-entry' AND storage_reservation_id = 'upgrade-reservation'
           AND bytes_delta = 64`,
      )
      .get().count,
    1,
  )
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'trigger'
           AND tbl_name IN (
             'logical_storage_quota_policies',
             'logical_storage_reservations',
             'logical_storage_usage_entries'
           )`,
      )
      .get().count,
    9,
  )
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'table' AND name = 'internal_delivery_rejections'`,
      )
      .get().count,
    1,
  )
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'trigger' AND name = 'prevent_internal_delivery_rejection_change'`,
      )
      .get().count,
    1,
  )
}

function verifyAccountRegistrationInvitations(database) {
  database
    .prepare(
      `INSERT INTO account_registration_invitations (
         id, code_digest, code_ciphertext, code_nonce,
         encryption_algorithm, encryption_key_version,
         domain_id, domain_name_snapshot, created_by_user_id, created_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'AES-GCM-256', 1,
                 'upgrade-domain', 'example.com', 'upgrade-admin', 1, NULL)`,
    )
    .run('upgrade-invitation-used', Buffer.alloc(32, 1), Buffer.alloc(17, 2), Buffer.alloc(12, 3))
  database
    .prepare(
      `INSERT INTO account_registration_invitation_consumptions (
         id, invitation_id, user_id, user_display_name_snapshot,
         primary_address_snapshot, consumed_at
       ) VALUES ('upgrade-consumption', 'upgrade-invitation-used', 'upgrade-admin',
                 '升级管理员', 'owner@example.com', 2)`,
    )
    .run()
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO account_registration_invitation_consumptions (
             id, invitation_id, user_id, user_display_name_snapshot,
             primary_address_snapshot, consumed_at
           ) VALUES ('upgrade-consumption-repeat', 'upgrade-invitation-used', 'upgrade-admin',
                     '升级管理员', 'owner@example.com', 3)`,
        )
        .run(),
    /账号邀请码不可用/u,
  )

  database
    .prepare(
      `INSERT INTO account_registration_invitations (
         id, code_digest, code_ciphertext, code_nonce,
         encryption_algorithm, encryption_key_version,
         domain_id, domain_name_snapshot, created_by_user_id, created_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'AES-GCM-256', 1,
                 'upgrade-domain', 'example.com', 'upgrade-admin', 1, NULL)`,
    )
    .run(
      'upgrade-invitation-revoked',
      Buffer.alloc(32, 4),
      Buffer.alloc(17, 5),
      Buffer.alloc(12, 6),
    )
  database.prepare(`DELETE FROM mail_domains WHERE id = 'upgrade-domain'`).run()
  const revoked = database
    .prepare(
      `SELECT domain_id AS domainId, revoked_at AS revokedAt
       FROM account_registration_invitations
       WHERE id = 'upgrade-invitation-revoked'`,
    )
    .get()
  assert.equal(revoked.domainId, null)
  assert.equal(typeof revoked.revokedAt, 'number')
  assert.ok(revoked.revokedAt >= 1)
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
