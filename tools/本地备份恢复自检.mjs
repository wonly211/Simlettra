import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  applyRestorePlan,
  buildRestorePlan,
  decryptBackupDirectory,
  encryptBackupDirectory,
  finalizeRestore,
  validateBackupDirectory,
} from './本地备份恢复.mjs'

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)))

const root = await mkdtemp(join(tmpdir(), 'simlettra-backup-restore-test-'))

try {
  const partsDirectory = join(root, '分卷')
  const outputDirectory = join(root, '恢复计划')
  await mkdir(partsDirectory)
  const objectBytes = Buffer.from('simlettra-object')
  const objectSha256 = digest(objectBytes)
  const pages = [
    {
      logicalKey: 'object_registry/0000000000',
      rows: [
        {
          id: 'object-1',
          object_key: 'mail/object-1',
          object_status: 'active',
          expected_size_bytes: objectBytes.byteLength,
          expected_sha256: { __binary_hex: objectSha256 },
        },
      ],
    },
    {
      logicalKey: 'object_registry/0000000128',
      rows: [
        {
          id: 'object-deleted',
          object_key: 'mail/object-deleted',
          object_status: 'deleted',
          expected_size_bytes: 1,
          expected_sha256: { __binary_hex: digest(Buffer.from('x')) },
        },
      ],
    },
    {
      logicalKey: 'users/0000000000',
      rows: [{ id: 'user-1', status: 'active', display_name: '管理员' }],
    },
  ]
  const entries = []
  for (const [index, page] of pages.entries()) {
    const bytes = Buffer.from(page.rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const id = `entry-${index + 1}`
    await writePart(partsDirectory, 'backup-1', page.logicalKey, bytes)
    entries.push({
      id,
      kind: 'd1_table',
      logicalKey: page.logicalKey,
      rowCount: page.rows.length,
      sizeBytes: bytes.byteLength,
      sha256: digest(bytes),
    })
  }
  await writePart(partsDirectory, 'backup-1', 'object-1', objectBytes)
  entries.push({
    id: 'entry-object-1',
    kind: 'object',
    logicalKey: 'object-1',
    rowCount: null,
    sizeBytes: objectBytes.byteLength,
    sha256: objectSha256,
  })
  const manifest = {
    product: '澄笺 | Simlettra',
    formatVersion: 1,
    backupReference: 'backup-1',
    migrationVersion: '0018-管理员备份与恢复.sql',
    storageMode: 'r2',
    encryption: { mode: 'authenticated', format: 'test', kdf: 'test' },
    requiredConfigurationKeyVersions: [],
    tableCount: 2,
    objectCount: 1,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    createdAt: 1,
    completedAt: 2,
    entries,
  }
  const manifestPath = join(root, '清单.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const manifestDigest = digest(await readFile(manifestPath))
  const result = await buildRestorePlan({
    manifestPath,
    partsDirectory,
    outputDirectory,
    expectedManifestSha256: manifestDigest,
  })
  assert.equal(result.report.status, 'validated')
  assert.deepEqual(result.report.errors, [])
  assert.equal(result.tableRows.get('object_registry').length, 2)
  assert.equal(result.objectPlan.length, 1)
  const generated = await readdir(outputDirectory)
  assert.deepEqual(generated.sort(), [
    'd1-import.sql',
    '对象上传清单.json',
    '恢复报告.json',
    '恢复检查.sql',
    '恢复说明.md',
    '搜索重建.sql',
  ])
  const importSql = await readFile(join(outputDirectory, 'd1-import.sql'), 'utf8')
  assert.match(importSql, /INSERT INTO "users"/u)
  assert.doesNotMatch(importSql, /INSERT OR IGNORE INTO "(?:users|object_registry)"/u)
  assert.match(importSql, new RegExp(`X'${objectSha256}'`, 'u'))
  assert.doesNotMatch(importSql, /^\s*(?:BEGIN|COMMIT)\s*;\s*$/imu)
  assert.doesNotMatch(importSql, /foreign_keys\s*=\s*OFF/iu)

  const rejected = await validateBackupDirectory({
    manifestPath,
    partsDirectory,
    expectedManifestSha256: '0'.repeat(64),
  })
  assert.equal(rejected.report.checks[0].status, 'failed')
  assert.equal(rejected.report.errors[0].code, 'manifest_hash_mismatch')

  const encryptedDirectory = join(root, '加密备份')
  const decryptedDirectory = join(root, '解密备份')
  const password = 'local-backup-password-2026'
  const encrypted = await encryptBackupDirectory({
    manifestPath,
    partsDirectory,
    outputDirectory: encryptedDirectory,
    password,
  })
  assert.equal(encrypted.fileCount, entries.length + 1)
  const decrypted = await decryptBackupDirectory({
    containerDirectory: encryptedDirectory,
    outputDirectory: decryptedDirectory,
    password,
  })
  assert.equal(decrypted.fileCount, entries.length + 1)
  assert.deepEqual(
    await readFile(join(decryptedDirectory, '清单.json')),
    await readFile(manifestPath),
  )
  await assert.rejects(
    decryptBackupDirectory({
      containerDirectory: encryptedDirectory,
      outputDirectory: join(root, '错误密码输出'),
      password: 'wrong-backup-password',
    }),
    /密码错误/u,
  )

  await verifyForeignKeyPlanning(root)
  await verifyLocalRestoreExecution(root, 'r2')
  await verifyLocalRestoreExecution(root, 'kv')

  process.stdout.write('本地备份加密、校验与恢复计划自检通过。\n')
} finally {
  await rm(root, { force: true, recursive: true })
}

async function writePart(directory, backupReference, logicalKey, bytes) {
  const safeName = logicalKey.replaceAll(/[^\p{L}\p{N}._-]+/gu, '_')
  await writeFile(join(directory, `simlettra-备份-${backupReference}-${safeName}.bin`), bytes)
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function verifyForeignKeyPlanning(root) {
  const fixture = join(root, '外键恢复')
  const migrationsDirectory = join(fixture, 'migrations')
  const partsDirectory = join(fixture, '分卷')
  const outputDirectory = join(fixture, '计划')
  await mkdir(migrationsDirectory, { recursive: true })
  await mkdir(partsDirectory, { recursive: true })
  const migrationVersion = '0018-管理员备份与恢复.sql'
  const migrationSql = `
PRAGMA foreign_keys = ON;
CREATE TABLE parents (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE children (
  id TEXT PRIMARY KEY NOT NULL,
  parent_id TEXT NOT NULL REFERENCES parents(id)
);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY NOT NULL,
  parent_id TEXT REFERENCES nodes(id)
);
CREATE TRIGGER validate_child_insert BEFORE INSERT ON children
WHEN NOT EXISTS (SELECT 1 FROM parents WHERE id = NEW.parent_id)
BEGIN SELECT RAISE(ABORT, '父记录不存在'); END;
`
  await writeFile(join(migrationsDirectory, migrationVersion), migrationSql)
  const tableRows = new Map([
    ['children', [{ id: 'child-1', parent_id: 'parent-1' }]],
    [
      'nodes',
      [
        { id: 'node-child', parent_id: 'node-parent' },
        { id: 'node-parent', parent_id: null },
      ],
    ],
    ['parents', [{ id: 'parent-1' }]],
  ])
  const manifest = await writeTableBackup({
    directory: fixture,
    partsDirectory,
    backupReference: 'foreign-key-backup',
    migrationVersion,
    storageMode: 'r2',
    tableRows,
  })
  const plan = await buildRestorePlan({
    manifestPath: manifest.path,
    partsDirectory,
    outputDirectory,
    expectedManifestSha256: manifest.sha256,
    migrationsDirectory,
  })
  assert.ok(
    plan.report.importOrder.indexOf('parents') < plan.report.importOrder.indexOf('children'),
  )
  assert.deepEqual(plan.report.deferredForeignKeys, [
    { table: 'nodes', column: 'parent_id', targetTable: 'nodes' },
  ])
  const sql = await readFile(join(outputDirectory, 'd1-import.sql'), 'utf8')
  assert.match(sql, /INSERT INTO "nodes" .*'node-child', NULL/u)
  assert.match(sql, /UPDATE "nodes" SET "parent_id" = 'node-parent'/u)
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(migrationSql)
    database.exec(sql)
    assert.equal(
      database.prepare('SELECT parent_id FROM nodes WHERE id = ?').get('node-child').parent_id,
      'node-parent',
    )
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    database.close()
  }

  const impossibleMigration = '0019-不可空循环.sql'
  await writeFile(
    join(migrationsDirectory, impossibleMigration),
    `CREATE TABLE impossible_nodes (
       id TEXT PRIMARY KEY NOT NULL,
       parent_id TEXT NOT NULL REFERENCES impossible_nodes(id)
     );`,
  )
  const impossibleRows = new Map([['impossible_nodes', [{ id: 'node-1', parent_id: 'node-1' }]]])
  const impossibleBackup = await writeTableBackup({
    directory: join(fixture, '不可空'),
    partsDirectory: join(fixture, '不可空', '分卷'),
    backupReference: 'impossible-backup',
    migrationVersion: impossibleMigration,
    storageMode: 'r2',
    tableRows: impossibleRows,
  })
  await assert.rejects(
    buildRestorePlan({
      manifestPath: impossibleBackup.path,
      partsDirectory: impossibleBackup.partsDirectory,
      outputDirectory: join(fixture, '不可空', '计划'),
      expectedManifestSha256: impossibleBackup.sha256,
      migrationsDirectory,
    }),
    /非空循环外键/u,
  )
}

async function verifyLocalRestoreExecution(root, storageMode) {
  const fixture = join(root, `本地执行-${storageMode}`)
  const migrationsDirectory = join(fixture, 'migrations')
  const partsDirectory = join(fixture, '分卷')
  const outputDirectory = join(fixture, '计划')
  const persistenceDirectory = join(fixture, '持久化')
  await mkdir(migrationsDirectory, { recursive: true })
  await mkdir(partsDirectory, { recursive: true })
  const migrationVersion = '0018-管理员备份与恢复.sql'
  await writeFile(join(migrationsDirectory, migrationVersion), localRestoreMigration())
  const objectBytes = Buffer.from('verified-r2-object')
  const objectSha256 = digest(objectBytes)
  const tableRows = new Map([
    ['parents', [{ id: 'parent-1' }]],
    ['children', [{ id: 'child-1', parent_id: 'parent-1' }]],
    ['messages', [{ id: 'message-1' }]],
    [
      'message_integrity_states',
      [{ message_id: 'message-1', object_set_version: 1, integrity_status: 'ready' }],
    ],
    [
      'object_registry',
      [
        {
          id: 'object-1',
          object_key: 'mail/object-1',
          object_status: 'active',
          expected_size_bytes: objectBytes.byteLength,
          expected_sha256: { __binary_hex: objectSha256 },
        },
      ],
    ],
  ])
  const backup = await writeTableBackup({
    directory: fixture,
    partsDirectory,
    backupReference: `restore-execution-backup-${storageMode}`,
    migrationVersion,
    storageMode,
    tableRows,
    objects: new Map([['object-1', objectBytes]]),
  })
  const configPath = join(fixture, 'wrangler.jsonc')
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        name: 'simlettra-restore-self-test',
        main: './worker.mjs',
        compatibility_date: '2026-08-12',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'simlettra-restore-self-test',
            database_id: '00000000-0000-0000-0000-000000000000',
            migrations_dir: migrationsDirectory,
          },
        ],
        r2_buckets:
          storageMode === 'r2'
            ? [{ binding: 'OBJECTS', bucket_name: 'simlettra-restore-self-test' }]
            : undefined,
        kv_namespaces:
          storageMode === 'kv'
            ? [{ binding: 'OBJECTS', id: '00000000000000000000000000000000' }]
            : undefined,
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(fixture, 'worker.mjs'),
    'export default { fetch() { return new Response("ok") } }\n',
  )
  await runWranglerForSelfTest(
    [
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--config',
      configPath,
      '--persist-to',
      persistenceDirectory,
    ],
    fixture,
  )
  const report = await applyRestorePlan({
    manifestPath: backup.path,
    partsDirectory,
    outputDirectory,
    expectedManifestSha256: backup.sha256,
    migrationsDirectory,
    configPath,
    database: 'DB',
    storageMode,
    bucket: storageMode === 'r2' ? 'simlettra-restore-self-test' : undefined,
    binding: storageMode === 'kv' ? 'OBJECTS' : undefined,
    persistTo: persistenceDirectory,
    remote: false,
    confirmation: 'RESTORE_EMPTY_TARGET',
  })
  assert.equal(report.status, 'search_rebuild_pending')
  assert.equal(report.checks.checks.foreign_keys, 'passed')
  assert.equal(report.checks.checks.object_hashes, 'passed')
  await runWranglerForSelfTest(
    [
      'd1',
      'execute',
      'DB',
      '--local',
      '--config',
      configPath,
      '--persist-to',
      persistenceDirectory,
      '--command',
      `UPDATE message_search_states SET index_status = 'ready', chunk_count = 1, indexed_at = 1;`,
    ],
    fixture,
  )
  const finalized = await finalizeRestore({
    manifestPath: backup.path,
    partsDirectory,
    outputDirectory,
    expectedManifestSha256: backup.sha256,
    migrationsDirectory,
    configPath,
    database: 'DB',
    storageMode,
    bucket: storageMode === 'r2' ? 'simlettra-restore-self-test' : undefined,
    binding: storageMode === 'kv' ? 'OBJECTS' : undefined,
    persistTo: persistenceDirectory,
    remote: false,
    restoreRunId: report.restoreRunId,
  })
  assert.equal(finalized.status, 'restored')
  const evidence = JSON.parse(
    await runWranglerForSelfTest(
      [
        'd1',
        'execute',
        'DB',
        '--local',
        '--config',
        configPath,
        '--persist-to',
        persistenceDirectory,
        '--command',
        `SELECT restore_status, current_stage FROM restore_runs;
         SELECT check_kind, check_status FROM restore_checks ORDER BY check_kind;`,
        '--json',
      ],
      fixture,
    ),
  )
  assert.deepEqual(evidence[0].results, [
    { restore_status: 'succeeded', current_stage: 'completed' },
  ])
  assert.equal(evidence[1].results.length, 6)
  assert.ok(evidence[1].results.every((row) => row.check_status === 'passed'))
}

async function writeTableBackup(options) {
  await mkdir(options.directory, { recursive: true })
  await mkdir(options.partsDirectory, { recursive: true })
  const entries = []
  let index = 0
  for (const [table, rows] of options.tableRows) {
    const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const logicalKey = `${table}/0000000000`
    await writePart(options.partsDirectory, options.backupReference, logicalKey, bytes)
    entries.push({
      id: `table-${++index}`,
      kind: 'd1_table',
      logicalKey,
      rowCount: rows.length,
      sizeBytes: bytes.byteLength,
      sha256: digest(bytes),
    })
  }
  for (const [objectId, bytes] of options.objects ?? []) {
    await writePart(options.partsDirectory, options.backupReference, objectId, bytes)
    entries.push({
      id: `object-${++index}`,
      kind: 'object',
      logicalKey: objectId,
      rowCount: null,
      sizeBytes: bytes.byteLength,
      sha256: digest(bytes),
    })
  }
  const manifest = {
    product: '澄笺 | Simlettra',
    formatVersion: 1,
    backupReference: options.backupReference,
    migrationVersion: options.migrationVersion,
    storageMode: options.storageMode,
    encryption: { mode: 'authenticated', format: 'test', kdf: 'test' },
    requiredConfigurationKeyVersions: [],
    tableCount: options.tableRows.size,
    objectCount: options.objects?.size ?? 0,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    createdAt: 1,
    completedAt: 2,
    entries,
  }
  const path = join(options.directory, '清单.json')
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return {
    path,
    partsDirectory: options.partsDirectory,
    sha256: digest(await readFile(path)),
  }
}

function localRestoreMigration() {
  return `
PRAGMA foreign_keys = ON;
CREATE TABLE system_instances (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE parents (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE children (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT NOT NULL REFERENCES parents(id));
CREATE TABLE object_registry (
  id TEXT PRIMARY KEY NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  object_status TEXT NOT NULL,
  expected_size_bytes INTEGER NOT NULL,
  expected_sha256 BLOB NOT NULL
);
CREATE TABLE message_integrity_states (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id),
  object_set_version INTEGER NOT NULL,
  integrity_status TEXT NOT NULL
);
CREATE TABLE message_search_states (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id),
  object_set_version INTEGER NOT NULL,
  index_generation INTEGER NOT NULL,
  index_status TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  last_error_code TEXT,
  indexed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE background_tasks (
  id TEXT PRIMARY KEY NOT NULL, task_type TEXT NOT NULL, target_type TEXT NOT NULL,
  target_reference TEXT NOT NULL, input_version INTEGER NOT NULL, task_key_digest BLOB NOT NULL,
  task_status TEXT NOT NULL, priority INTEGER NOT NULL, attempt_count INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
  lease_owner_reference TEXT, lease_token INTEGER NOT NULL, lease_expires_at INTEGER,
  last_error_code TEXT, last_error_summary TEXT, last_error_at INTEGER, completed_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE restore_runs (
  id TEXT PRIMARY KEY NOT NULL, source_backup_reference TEXT NOT NULL,
  source_manifest_sha256 BLOB NOT NULL, target_mode TEXT NOT NULL,
  maintenance_mode_enabled INTEGER NOT NULL, pre_restore_backup_reference TEXT,
  overwrite_confirmation_digest BLOB, restore_status TEXT NOT NULL,
  current_stage TEXT NOT NULL, last_error_code TEXT, started_at INTEGER,
  completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE restore_checkpoints (
  id TEXT PRIMARY KEY NOT NULL, restore_run_id TEXT NOT NULL REFERENCES restore_runs(id),
  stage_kind TEXT NOT NULL, cursor_value TEXT, processed_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL, checkpoint_status TEXT NOT NULL, last_error_code TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (restore_run_id, stage_kind)
);
CREATE TABLE restore_checks (
  id TEXT PRIMARY KEY NOT NULL, restore_run_id TEXT NOT NULL REFERENCES restore_runs(id),
  check_kind TEXT NOT NULL, check_status TEXT NOT NULL, expected_count INTEGER,
  actual_count INTEGER, failure_code TEXT, checked_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (restore_run_id, check_kind)
);
CREATE TRIGGER require_restore_checks_before_success
BEFORE UPDATE OF restore_status ON restore_runs
WHEN NEW.restore_status = 'succeeded' AND (
  SELECT COUNT(*) FROM restore_checks
  WHERE restore_run_id = NEW.id AND check_status = 'passed'
) <> 6
BEGIN SELECT RAISE(ABORT, '恢复检查未全部通过'); END;
`
}

async function runWranglerForSelfTest(args, cwd) {
  const { spawn } = await import('node:child_process')
  const wranglerPath = join(projectDirectory, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [wranglerPath, ...args], {
      cwd,
      env: process.env,
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
      if (code !== 0) {
        rejectPromise(new Error(Buffer.concat(stderr).toString('utf8')))
        return
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8'))
    })
  })
}
