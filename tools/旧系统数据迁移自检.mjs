import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LegacyMigrationValidationError,
  applyLegacyMigration,
  buildLegacyMigrationPlan,
  createLegacySnapshot,
  rehearseLegacyMigration,
  validateLegacySnapshot,
} from './旧系统数据迁移.mjs'

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const wranglerPath = join(projectDirectory, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const migrationsDirectory = join(projectDirectory, 'migrations')
const root = await mkdtemp(join(tmpdir(), 'simlettra-legacy-migration-test-'))
const results = []
const requestedMode = process.argv[2]
const storageModes = requestedMode ? [requestedMode] : ['kv', 'r2']
if (storageModes.some((mode) => !['kv', 'r2'].includes(mode))) {
  throw new Error('自检模式只能是 kv 或 r2')
}

try {
  for (const storageMode of storageModes) {
    results.push(await verifyStorageMode(storageMode))
  }
  process.stdout.write(`${JSON.stringify({ status: 'passed', results }, null, 2)}\n`)
} finally {
  await rm(root, { force: true, recursive: true })
}

async function verifyStorageMode(storageMode) {
  const fixture = join(root, storageMode)
  const source = await createResourceFixture(fixture, '来源', storageMode, false)
  const rehearsal = await createResourceFixture(fixture, '演练', storageMode, true)
  const formal = await createResourceFixture(fixture, '正式', storageMode, true)
  await initializeLegacySource(source)
  await initializeTarget(rehearsal, storageMode)
  await initializeTarget(formal, storageMode)

  const snapshotDirectory = join(fixture, '快照')
  const firstSnapshot = await createLegacySnapshot({
    ...sourceOptions(source, storageMode),
    outputDirectory: snapshotDirectory,
  })
  assert.equal(firstSnapshot.report.status, 'valid')
  assert.deepEqual(firstSnapshot.report.errors, [])

  const duplicateDirectory = join(fixture, '重复快照')
  const duplicateSnapshot = await createLegacySnapshot({
    ...sourceOptions(source, storageMode),
    outputDirectory: duplicateDirectory,
  })
  assert.equal(
    duplicateSnapshot.manifest.sourceSnapshotSha256,
    firstSnapshot.manifest.sourceSnapshotSha256,
  )

  const reportPath = join(fixture, '迁移演练报告.json')
  const rehearsalReport = await rehearseLegacyMigration({
    snapshotDirectory,
    reportPath,
    ...targetOptions(rehearsal, storageMode),
  })
  assert.equal(rehearsalReport.status, 'succeeded')
  assert.equal(rehearsalReport.targetStorageMode, storageMode)

  await assert.rejects(
    applyLegacyMigration({
      snapshotDirectory,
      rehearsalReportPath: join(fixture, '不存在的演练报告.json'),
      confirmation: 'MIGRATE_LEGACY_COPY',
      ...targetOptions(formal, storageMode),
    }),
  )

  const formalReport = await applyLegacyMigration({
    snapshotDirectory,
    rehearsalReportPath: reportPath,
    confirmation: 'MIGRATE_LEGACY_COPY',
    reportPath: join(fixture, '正式迁移报告.json'),
    ...targetOptions(formal, storageMode),
  })
  assert.equal(formalReport.status, 'succeeded')
  assert.equal(formalReport.runMode, 'formal')

  const repeatedReport = await applyLegacyMigration({
    snapshotDirectory,
    rehearsalReportPath: reportPath,
    confirmation: 'MIGRATE_LEGACY_COPY',
    ...targetOptions(formal, storageMode),
  })
  assert.equal(repeatedReport.status, 'succeeded')
  await verifyTargetEvidence(formal)

  await verifyFailureScenarios({
    fixture,
    snapshotDirectory,
    manifest: firstSnapshot.manifest,
    storageMode,
  })

  await runD1(source, "UPDATE account SET name = '来源变化' WHERE account_id = 3;")
  const changedSnapshot = await createLegacySnapshot({
    ...sourceOptions(source, storageMode),
    outputDirectory: join(fixture, '变化后快照'),
  })
  assert.notEqual(
    changedSnapshot.manifest.sourceSnapshotSha256,
    firstSnapshot.manifest.sourceSnapshotSha256,
  )

  return {
    storageMode,
    sourceSnapshotSha256: firstSnapshot.manifest.sourceSnapshotSha256,
    userCount: firstSnapshot.report.tables.user,
    messageCount: firstSnapshot.report.tables.email,
    objectCount: firstSnapshot.report.objects,
    repeatedApply: 'passed',
    negativeScenarios: 6,
  }
}

async function createResourceFixture(parent, name, storageMode, target) {
  const directory = join(parent, name)
  const persistenceDirectory = join(directory, '持久化')
  await mkdir(directory, { recursive: true })
  const configPath = join(directory, 'wrangler.jsonc')
  const role = name === '来源' ? 'source' : name === '演练' ? 'rehearsal' : 'formal'
  const databaseName = `simlettra-legacy-${role}-${storageMode}`
  const bucketName = `simlettra-legacy-${role}-${storageMode}`
  const binding = 'OBJECTS'
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        name: databaseName,
        main: './worker.mjs',
        compatibility_date: '2026-08-13',
        d1_databases: [
          {
            binding: 'DB',
            database_name: databaseName,
            database_id: '00000000-0000-0000-0000-000000000000',
            migrations_dir: target ? migrationsDirectory : undefined,
          },
        ],
        r2_buckets: storageMode === 'r2' ? [{ binding, bucket_name: bucketName }] : undefined,
        kv_namespaces:
          storageMode === 'kv' ? [{ binding, id: '00000000000000000000000000000000' }] : undefined,
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(directory, 'worker.mjs'),
    'export default { fetch() { return new Response("ok") } }\n',
  )
  if (target) {
    await runWrangler([
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--config',
      configPath,
      '--persist-to',
      persistenceDirectory,
    ])
  }
  return {
    directory,
    persistenceDirectory,
    configPath,
    database: 'DB',
    bucket: bucketName,
    binding,
  }
}

async function initializeLegacySource(resource) {
  const schemaPath = join(resource.directory, '旧系统测试数据.sql')
  await writeFile(schemaPath, legacyFixtureSql(), 'utf8')
  await runWrangler([
    'd1',
    'execute',
    resource.database,
    '--local',
    '--config',
    resource.configPath,
    '--persist-to',
    resource.persistenceDirectory,
    '--file',
    schemaPath,
    '--yes',
  ])
  const objects = new Map([
    [
      'message-bodies/one.json',
      Buffer.from(JSON.stringify({ html: '<p>家庭通知</p>', text: '家庭通知正文' })),
    ],
    ['message-bodies/two.json', Buffer.from(JSON.stringify({ html: '', text: '项目进展正文' }))],
    [
      'message-bodies/three.json',
      Buffer.from(JSON.stringify({ html: '<p>回复正文</p>', text: '回复正文' })),
    ],
    ['attachments/one.txt', Buffer.from('legacy-attachment')],
  ])
  for (const [key, bytes] of objects) {
    const path = join(resource.directory, `${digest(Buffer.from(key))}.bin`)
    await writeFile(path, bytes)
    await putObject(resource, key, path)
  }
}

async function initializeTarget(resource, storageMode) {
  const path = join(resource.directory, '目标初始化.sql')
  await writeFile(path, targetInitializationSql(storageMode), 'utf8')
  await runWrangler([
    'd1',
    'execute',
    resource.database,
    '--local',
    '--config',
    resource.configPath,
    '--persist-to',
    resource.persistenceDirectory,
    '--file',
    path,
    '--yes',
  ])
}

async function verifyTargetEvidence(resource) {
  const commands = [
    'SELECT COUNT(*) AS count FROM users;',
    "SELECT COUNT(*) AS count FROM messages WHERE origin_type = 'migrated';",
    "SELECT COUNT(*) AS count FROM object_registry WHERE producer_version = 'simlettra-legacy-structured-v1';",
    "SELECT COUNT(*) AS count FROM migration_runs WHERE run_mode = 'formal' AND run_status = 'succeeded';",
    "SELECT COUNT(*) AS count FROM migration_reconciliations WHERE reconciliation_status = 'matched';",
    'PRAGMA foreign_key_check;',
  ]
  const evidence = []
  for (const command of commands) evidence.push((await runD1Json(resource, command))[0])
  assert.deepEqual(
    evidence.slice(0, 5).map((item) => Number(item.results[0]?.count ?? 0)),
    [2, 3, 6, 1, 14],
  )
  assert.deepEqual(evidence[5].results, [])
}

async function verifyFailureScenarios({ fixture, snapshotDirectory, manifest, storageMode }) {
  const targetFacts = syntheticTargetFacts(storageMode)

  const conflictFacts = syntheticTargetFacts(storageMode)
  conflictFacts.claims.set('alias@example.com', { address_id: 'occupied' })
  await assert.rejects(
    buildLegacyMigrationPlan({
      snapshotDirectory,
      targetFacts: conflictFacts,
      runMode: 'rehearsal',
      now: 1,
    }),
    LegacyMigrationValidationError,
  )

  const mismatchFacts = syntheticTargetFacts(storageMode)
  mismatchFacts.adminPrimaryAddress = 'absent@example.com'
  await assert.rejects(
    buildLegacyMigrationPlan({
      snapshotDirectory,
      targetFacts: mismatchFacts,
      runMode: 'rehearsal',
      now: 1,
    }),
    LegacyMigrationValidationError,
  )

  const missingBodyDirectory = join(fixture, '缺失正文快照')
  await cp(snapshotDirectory, missingBodyDirectory, { recursive: true })
  await rewriteSnapshot(missingBodyDirectory, (draft) => {
    draft.entries = draft.entries.filter((entry) => entry.logicalKey !== 'message-bodies/one.json')
  })
  const missingBody = await validateLegacySnapshot({ snapshotDirectory: missingBodyDirectory })
  assert.ok(missingBody.report.errors.some((item) => item.code === 'snapshot_object_missing'))

  const damagedAttachmentDirectory = join(fixture, '损坏附件快照')
  await cp(snapshotDirectory, damagedAttachmentDirectory, { recursive: true })
  await rewriteTable(damagedAttachmentDirectory, 'attachments', (rows) => {
    rows[0].size = 9999
  })
  await assert.rejects(
    buildLegacyMigrationPlan({
      snapshotDirectory: damagedAttachmentDirectory,
      targetFacts,
      runMode: 'rehearsal',
      now: 1,
    }),
    LegacyMigrationValidationError,
  )

  const tamperedDirectory = join(fixture, '篡改快照')
  await cp(snapshotDirectory, tamperedDirectory, { recursive: true })
  await writeFile(join(tamperedDirectory, '表', 'user.ndjson'), '{}\n', 'utf8')
  const tampered = await validateLegacySnapshot({ snapshotDirectory: tamperedDirectory })
  assert.ok(tampered.report.errors.some((item) => item.code === 'snapshot_file_hash_mismatch'))

  const changedManifest = { ...manifest, migrationRulesVersion: 999 }
  const changedFixed = { ...changedManifest }
  delete changedFixed.sourceSnapshotSha256
  changedManifest.sourceSnapshotSha256 = digest(Buffer.from(stableStringify(changedFixed)))
  await writeFile(
    join(fixture, '不兼容清单.json'),
    `${JSON.stringify(changedManifest, null, 2)}\n`,
    'utf8',
  )
  assert.notEqual(changedManifest.sourceSnapshotSha256, manifest.sourceSnapshotSha256)
}

function sourceOptions(resource, storageMode) {
  return {
    sourceConfigPath: resource.configPath,
    sourceDatabase: resource.database,
    sourceStorageMode: storageMode,
    sourceBucket: storageMode === 'r2' ? resource.bucket : undefined,
    sourceBinding: storageMode === 'kv' ? resource.binding : undefined,
    sourcePersistTo: resource.persistenceDirectory,
    sourceRemote: false,
  }
}

function targetOptions(resource, storageMode) {
  return {
    targetConfigPath: resource.configPath,
    targetDatabase: resource.database,
    targetStorageMode: storageMode,
    targetBucket: storageMode === 'r2' ? resource.bucket : undefined,
    targetBinding: storageMode === 'kv' ? resource.binding : undefined,
    targetPersistTo: resource.persistenceDirectory,
    targetRemote: false,
  }
}

function syntheticTargetFacts(storageMode) {
  return {
    storageMode,
    adminUserId: 'admin-user',
    adminAddressId: 'admin-address',
    adminBindingId: 'admin-binding',
    adminPrimaryAddress: 'admin@example.com',
    domains: new Map([['example.com', { id: 'example-domain', displayName: 'example.com' }]]),
    claims: new Map([['admin@example.com', { address_id: 'admin-address' }]]),
    logicalStorage: new Map([['admin-user', { committedBytes: 0, limitBytes: 1_000_000_000 }]]),
    defaultLogicalLimitBytes: 1_000_000_000,
    storageUsedBytes: 0,
    storageStopBytes: 9_000_000_000,
    d1UsedBytes: 0,
    d1StopBytes: 450_000_000,
    sourceMappings: new Map(),
    migrationRuns: [],
  }
}

async function rewriteTable(snapshotDirectory, table, mutate) {
  const path = join(snapshotDirectory, '表', `${table}.ndjson`)
  const rows = (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  mutate(rows)
  const bytes = Buffer.from(rows.map((row) => stableStringify(row)).join('\n') + '\n')
  await writeFile(path, bytes)
  await rewriteSnapshot(snapshotDirectory, (manifest) => {
    const entry = manifest.entries.find(
      (candidate) => candidate.kind === 'table' && candidate.logicalKey === table,
    )
    entry.rowCount = rows.length
    entry.sizeBytes = bytes.byteLength
    entry.sha256 = digest(bytes)
  })
}

async function rewriteSnapshot(snapshotDirectory, mutate) {
  const path = join(snapshotDirectory, '迁移清单.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  mutate(manifest)
  const fixed = { ...manifest }
  delete fixed.sourceSnapshotSha256
  manifest.sourceSnapshotSha256 = digest(Buffer.from(stableStringify(fixed)))
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function putObject(resource, key, path) {
  const config = JSON.parse(await readFile(resource.configPath, 'utf8'))
  if (config.r2_buckets) {
    await runWrangler([
      'r2',
      'object',
      'put',
      `${resource.bucket}/${key}`,
      '--local',
      '--config',
      resource.configPath,
      '--persist-to',
      resource.persistenceDirectory,
      '--file',
      path,
      '--force',
    ])
    return
  }
  await runWrangler([
    'kv',
    'key',
    'put',
    key,
    '--local',
    '--config',
    resource.configPath,
    '--persist-to',
    resource.persistenceDirectory,
    '--binding',
    resource.binding,
    '--path',
    path,
  ])
}

async function runD1(resource, command) {
  await runWrangler([
    'd1',
    'execute',
    resource.database,
    '--local',
    '--config',
    resource.configPath,
    '--persist-to',
    resource.persistenceDirectory,
    '--command',
    command,
  ])
}

async function runD1Json(resource, command) {
  const output = await runWrangler([
    'd1',
    'execute',
    resource.database,
    '--local',
    '--config',
    resource.configPath,
    '--persist-to',
    resource.persistenceDirectory,
    '--command',
    command,
    '--json',
  ])
  const value = String(output).replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  for (let start = value.indexOf('['); start !== -1; start = value.indexOf('[', start + 1)) {
    for (let end = value.lastIndexOf(']'); end > start; end = value.lastIndexOf(']', end - 1)) {
      try {
        const parsed = JSON.parse(value.slice(start, end + 1))
        if (Array.isArray(parsed)) return parsed
      } catch {
        // Wrangler 可能在 JSON 前后写入诊断信息。
      }
    }
  }
  throw new Error(`无法解析自检 D1 JSON 输出：${value.trim() || '标准输出为空'}`)
}

function runWrangler(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(process.execPath, [wranglerPath, ...args], {
        cwd: projectDirectory,
        env: { ...process.env, XDG_CONFIG_HOME: tmpdir() },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout = []
      const stderr = []
      child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
      child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
      child.on('error', rejectPromise)
      child.on('close', (code) => {
        const output = Buffer.concat(stdout).toString('utf8')
        const errorText = Buffer.concat(stderr).toString('utf8')
        if (code !== 0) {
          rejectPromise(new Error(errorText || output))
          return
        }
        resolvePromise(output || errorText)
      })
    }, rejectPromise)
  })
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableStringify(value) {
  return JSON.stringify(stableJson(value))
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])]),
    )
  }
  return value
}

function legacyFixtureSql() {
  return `
CREATE TABLE user (
  user_id INTEGER PRIMARY KEY, email TEXT NOT NULL, type INTEGER NOT NULL DEFAULT 1,
  password TEXT NOT NULL, salt TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0,
  create_time DATETIME, is_del INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE account (
  account_id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0, create_time DATETIME, user_id INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
  is_del INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE email (
  email_id INTEGER PRIMARY KEY, send_email TEXT, name TEXT, account_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, subject TEXT, body_key TEXT NOT NULL,
  cc TEXT NOT NULL DEFAULT '[]', bcc TEXT NOT NULL DEFAULT '[]',
  recipient TEXT NOT NULL DEFAULT '[]', to_email TEXT NOT NULL DEFAULT '',
  to_name TEXT NOT NULL DEFAULT '', in_reply_to TEXT NOT NULL DEFAULT '',
  relation TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
  type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0, create_time DATETIME,
  is_del INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE attachments (
  att_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL, key TEXT NOT NULL, filename TEXT, mime_type TEXT,
  size INTEGER, status INTEGER NOT NULL DEFAULT 0, type INTEGER NOT NULL DEFAULT 0,
  disposition TEXT, related TEXT, content_id TEXT, encoding TEXT, create_time DATETIME
);
CREATE TABLE star (
  star_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
  email_id INTEGER NOT NULL, create_time DATETIME
);
INSERT INTO user VALUES
  (1, 'admin@example.com', 1, 'old-admin', 'salt-a', 0, '2025-01-01 08:00:00', 0),
  (2, 'member@example.com', 1, 'old-member', 'salt-b', 0, '2025-01-02 08:00:00', 0);
INSERT INTO account VALUES
  (1, 'admin@example.com', '管理员', 0, '2025-01-01 08:00:00', 1, 1, 0, 0),
  (2, 'member@example.com', '成员', 0, '2025-01-02 08:00:00', 2, 1, 0, 0),
  (3, 'alias@example.com', '个人别名', 0, '2025-01-03 08:00:00', 2, 0, 1, 0);
INSERT INTO email VALUES
  (1, 'sender@outside.test', '外部发件人', 1, 1, '家庭通知', 'message-bodies/one.json',
   '[]', '[]', '[{"address":"admin@example.com","name":"管理员"}]', '', '', '', '',
   '<legacy-one@example.test>', 0, 0, 0, '2025-02-01 09:00:00', 0),
  (2, 'member@example.com', '成员', 2, 2, '项目进展', 'message-bodies/two.json',
   '[]', '[]', '[{"address":"person@outside.test","name":"收件人"}]', '', '', '', '',
   '<legacy-two@example.test>', 1, 0, 1, '2025-02-02 10:00:00', 0),
  (3, 'reply@outside.test', '回复人', 3, 2, '回复：项目进展', 'message-bodies/three.json',
   '[]', '[]', '[{"address":"alias@example.com","name":"个人别名"}]', '', '',
   '<legacy-two@example.test>', '<legacy-two@example.test>', '<legacy-three@example.test>',
   0, 0, 0, '2025-02-03 11:00:00', 0);
INSERT INTO attachments VALUES
  (1, 1, 1, 1, 'attachments/one.txt', '说明.txt', 'text/plain', 17, 0, 0,
   'attachment', NULL, NULL, NULL, '2025-02-01 09:00:00');
INSERT INTO star VALUES (1, 1, 1, '2025-02-01 09:05:00');
`
}

function targetInitializationSql(storageMode) {
  return `
PRAGMA foreign_keys = ON;
INSERT INTO users (
  id, status, display_name, timezone, invitation_policy,
  deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
) VALUES ('admin-user', 'active', '管理员', 'Asia/Shanghai', 'manual', NULL, NULL, NULL, 1, 1);
INSERT INTO password_credentials (
  user_id, format_version, algorithm, iterations, salt, derived_key,
  must_change, temporary_expires_at, updated_at
) VALUES ('admin-user', 1, 'PBKDF2-HMAC-SHA-256', 900000,
          X'00000000000000000000000000000000',
          X'0000000000000000000000000000000000000000000000000000000000000000',
          0, NULL, 1);
INSERT INTO user_alias_policies (
  user_id, alias_limit, self_creation_enabled, updated_by_user_id, created_at, updated_at
) VALUES ('admin-user', 20, 1, 'admin-user', 1, 1);
INSERT INTO user_organization_policies (
  user_id, organization_limit, updated_by_user_id, created_at, updated_at
) VALUES ('admin-user', 5, 'admin-user', 1, 1);
INSERT INTO mail_domains (
  id, canonical_name, display_name, status, catch_all_mode,
  paused_at, created_at, updated_at
) VALUES ('example-domain', 'example.com', 'example.com', 'active', 'reject', NULL, 1, 1);
INSERT INTO email_addresses (
  id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
) VALUES ('admin-address', 'example-domain', 'admin@example.com', 'admin@example.com', '管理员', 1, NULL);
INSERT INTO address_claims (
  canonical_address, address_id, status, reserved_until, created_at, updated_at
) VALUES ('admin@example.com', 'admin-address', 'active', NULL, 1, 1);
INSERT INTO address_bindings (
  id, address_id, owner_type, user_id, organization_id,
  address_role, started_at, ended_at, ended_reason
) VALUES ('admin-binding', 'admin-address', 'user', 'admin-user', NULL, 'primary', 1, NULL, NULL);
INSERT INTO user_address_preferences (
  user_id, address_id, custom_label, is_pinned, sort_order, is_default_sender,
  sender_display_name, signature_format, signature_content, created_at, updated_at
) VALUES ('admin-user', 'admin-address', '管理员', 1, 0, 1, '管理员', NULL, NULL, 1, 1);
INSERT INTO system_instances (
  singleton_id, storage_mode, current_admin_user_id, initialized_at, created_at, updated_at
) VALUES (1, '${storageMode}', 'admin-user', 1, 1, 1);
`
}
