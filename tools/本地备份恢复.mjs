import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const TOOL_VERSION = 1
const PRODUCT_NAME = '\u6f84\u7b3a | Simlettra'
const ENCRYPTED_CONTAINER_VERSION = 1
const ENCRYPTION_ALGORITHM = 'AES-256-GCM'
const KDF_NAME = 'PBKDF2-HMAC-SHA-256'
const KDF_ITERATIONS = 900_000
const CONTAINER_METADATA_FILE = '加密备份.json'
const RESTORE_CONFIRMATION = 'RESTORE_EMPTY_TARGET'
const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIRECTORY = resolve(TOOL_DIRECTORY, '..')
const DEFAULT_MIGRATIONS_DIRECTORY = join(PROJECT_DIRECTORY, 'migrations')
const WRANGLER_PATH = join(PROJECT_DIRECTORY, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const RESTORE_STAGE_KINDS = ['manifest', 'd1', 'objects', 'migrations', 'search', 'final_checks']
const RESTORE_CHECK_KINDS = [
  'manifest_hash',
  'table_counts',
  'object_hashes',
  'foreign_keys',
  'object_references',
  'search_rebuild',
]
const MIGRATION_SEED_TABLES = new Set([
  'address_policy_settings',
  'logical_storage_quota_policies',
  'platform_resource_thresholds',
  'quota_policies',
])

export async function validateBackupDirectory(options) {
  const manifest = await readJson(options.manifestPath)
  const manifestBytes = await readFile(options.manifestPath)
  const manifestSha256 = sha256Hex(manifestBytes)
  const entries = assertManifest(manifest)
  const partFiles = await listPartFiles(options.partsDirectory)
  const tableRows = new Map()
  const objectRows = new Map()
  const errors = []
  const warnings = []

  if (
    options.expectedManifestSha256 &&
    options.expectedManifestSha256.toLowerCase() !== manifestSha256
  ) {
    errors.push({
      code: 'manifest_hash_mismatch',
      expected: options.expectedManifestSha256.toLowerCase(),
      actual: manifestSha256,
    })
  }

  for (const entry of [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind)
    return left.logicalKey.localeCompare(right.logicalKey)
  })) {
    const partPath = locatePartFile({ backupReference: manifest.backupReference, entry, partFiles })
    if (!partPath) {
      errors.push({ code: 'part_missing', logicalKey: entry.logicalKey, entryId: entry.id })
      continue
    }

    const bytes = await readFile(partPath)
    const actualSha256 = sha256Hex(bytes)
    if (actualSha256 !== entry.sha256) {
      errors.push({
        code: 'part_hash_mismatch',
        logicalKey: entry.logicalKey,
        entryId: entry.id,
        expected: entry.sha256,
        actual: actualSha256,
      })
      continue
    }
    if (bytes.byteLength !== entry.sizeBytes) {
      errors.push({
        code: 'part_size_mismatch',
        logicalKey: entry.logicalKey,
        entryId: entry.id,
        expected: entry.sizeBytes,
        actual: bytes.byteLength,
      })
      continue
    }

    if (entry.kind === 'd1_table') {
      const rows = parseNdjson(bytes, entry.logicalKey, errors)
      const expectedRows = entry.rowCount ?? 0
      if (rows.length !== expectedRows) {
        errors.push({
          code: 'row_count_mismatch',
          logicalKey: entry.logicalKey,
          expected: expectedRows,
          actual: rows.length,
        })
      }
      const table = tableName(entry.logicalKey)
      const currentRows = tableRows.get(table) ?? []
      currentRows.push(...rows)
      tableRows.set(table, currentRows)
    } else {
      objectRows.set(entry.logicalKey, { entry, partPath, bytes })
    }
  }

  const objectRegistry = buildObjectRegistry(tableRows)
  for (const [objectId, object] of objectRows) {
    const registry = objectRegistry.get(objectId)
    if (!registry) {
      errors.push({ code: 'object_registry_missing', objectId })
      continue
    }
    if (registry.expectedSizeBytes !== object.bytes.byteLength) {
      errors.push({
        code: 'object_registry_size_mismatch',
        objectId,
        expected: registry.expectedSizeBytes,
        actual: object.bytes.byteLength,
      })
    }
    if (registry.expectedSha256 !== object.entry.sha256) {
      errors.push({
        code: 'object_registry_hash_mismatch',
        objectId,
        expected: registry.expectedSha256,
        actual: object.entry.sha256,
      })
    }
  }

  if (manifest.requiredConfigurationKeyVersions?.length) {
    warnings.push({
      code: 'configuration_key_required',
      message: '恢复目标必须提供清单要求的配置加密主密钥版本；备份本身不包含密钥。',
      versions: manifest.requiredConfigurationKeyVersions,
    })
  }

  const report = {
    toolVersion: TOOL_VERSION,
    product: manifest.product,
    backupReference: manifest.backupReference,
    migrationVersion: manifest.migrationVersion,
    manifestSha256,
    expectedManifestSha256: options.expectedManifestSha256 ?? null,
    checks: [
      {
        kind: 'manifest_hash',
        status: errors.some((error) => error.code === 'manifest_hash_mismatch')
          ? 'failed'
          : 'passed',
        actual: manifestSha256,
      },
      {
        kind: 'part_hashes_and_sizes',
        status: errors.length === 0 ? 'passed' : 'failed',
        expected: entries.length,
        actual: entries.length - errors.filter((error) => error.code === 'part_missing').length,
      },
      {
        kind: 'table_row_counts',
        status: errors.some((error) => error.code === 'row_count_mismatch') ? 'failed' : 'passed',
        expected: entries
          .filter((entry) => entry.kind === 'd1_table')
          .reduce((sum, entry) => sum + (entry.rowCount ?? 0), 0),
        actual: [...tableRows.values()].reduce((sum, rows) => sum + rows.length, 0),
      },
      {
        kind: 'object_references',
        status: errors.some((error) => error.code.startsWith('object_')) ? 'failed' : 'passed',
        expected: objectRows.size,
        actual: [...objectRows.keys()].filter((key) => objectRegistry.has(key)).length,
      },
      {
        kind: 'foreign_keys',
        status: 'pending',
        message: '导入目标后执行 PRAGMA foreign_key_check。',
      },
      { kind: 'search_rebuild', status: 'pending', message: '导入目标后重建 FTS5 搜索索引。' },
    ],
    entries: entries.length,
    tableCount: new Set(
      entries
        .filter((entry) => entry.kind === 'd1_table')
        .map((entry) => tableName(entry.logicalKey)),
    ).size,
    objectCount: objectRows.size,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    errors,
    warnings,
  }
  return { manifest, manifestBytes, report, tableRows, objectRows, objectRegistry }
}

export async function buildRestorePlan(options) {
  const validation = await validateBackupDirectory(options)
  if (validation.report.errors.length > 0) {
    throw new Error(`备份校验失败：${JSON.stringify(validation.report.errors)}`)
  }

  const outputDirectory = resolve(options.outputDirectory)
  await mkdir(outputDirectory, { recursive: true })
  const importPlan = await buildD1ImportSql(validation.tableRows, {
    migrationsDirectory: options.migrationsDirectory ?? DEFAULT_MIGRATIONS_DIRECTORY,
    migrationVersion: validation.manifest.migrationVersion,
  })
  const objectPlan = [...validation.objectRows.entries()].map(([objectId, value]) => {
    const registry = validation.objectRegistry.get(objectId)
    return {
      objectId,
      objectKey: registry.objectKey,
      sizeBytes: value.bytes.byteLength,
      sha256: value.entry.sha256,
      sourceFile: relative(outputDirectory, resolve(value.partPath)),
    }
  })
  const checkSql = buildCheckSql(validation.tableRows)
  const searchSql = buildSearchRebuildSql(validation.tableRows)
  const report = {
    ...validation.report,
    status: 'validated',
    applyMode: 'empty_target_only',
    importOrder: importPlan.tableOrder,
    deferredForeignKeys: importPlan.deferredForeignKeys,
    generatedFiles: [
      'd1-import.sql',
      '对象上传清单.json',
      '搜索重建.sql',
      '恢复检查.sql',
      '恢复报告.json',
      '恢复说明.md',
    ],
  }
  await writeFile(join(outputDirectory, 'd1-import.sql'), importPlan.sql, 'utf8')
  await writeFile(
    join(outputDirectory, '对象上传清单.json'),
    `${JSON.stringify(objectPlan, null, 2)}\n`,
    'utf8',
  )
  await writeFile(join(outputDirectory, '搜索重建.sql'), searchSql, 'utf8')
  await writeFile(join(outputDirectory, '恢复检查.sql'), checkSql, 'utf8')
  await writeFile(
    join(outputDirectory, '恢复报告.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(outputDirectory, '恢复说明.md'),
    buildInstructions(validation.manifest, outputDirectory),
    'utf8',
  )
  return { ...validation, report, outputDirectory, objectPlan }
}

export async function applyRestorePlan(options) {
  if (options.confirmation !== RESTORE_CONFIRMATION) {
    throw new Error(`必须明确传入 --confirm-empty-target ${RESTORE_CONFIRMATION}`)
  }
  if (!options.expectedManifestSha256) throw new Error('apply 必须指定 --manifest-sha256')
  const plan = await buildRestorePlan(options)
  assertStorageMode(plan.manifest.storageMode, options.storageMode)
  await assertMigrationCompatibility(options, plan.manifest.migrationVersion)
  const target = await assertEmptyD1Target(options)
  const restoreRunId = await createRestoreRun(options, plan)
  try {
    await setRestoreCheckpoint(options, restoreRunId, 'd1', 'running')
    await runWrangler([
      'd1',
      'execute',
      options.database,
      ...commonWranglerArguments(options),
      '--file',
      join(plan.outputDirectory, 'd1-import.sql'),
      '--yes',
    ])
    await setRestoreCheckpoint(
      options,
      restoreRunId,
      'd1',
      'completed',
      [...plan.tableRows.values()].reduce((sum, rows) => sum + rows.length, 0),
    )

    await setRestoreCheckpoint(options, restoreRunId, 'objects', 'running')
    const objectVerification = await verifyStoredObjects(options, plan, { upload: true })
    await setRestoreCheckpoint(
      options,
      restoreRunId,
      'objects',
      'completed',
      objectVerification.length,
    )

    await setRestoreCheckpoint(options, restoreRunId, 'search', 'running')
    const searchSql = await readFile(join(plan.outputDirectory, '搜索重建.sql'), 'utf8')
    if (searchSql.trim().length > 0) {
      await runWrangler([
        'd1',
        'execute',
        options.database,
        ...commonWranglerArguments(options),
        '--file',
        join(plan.outputDirectory, '搜索重建.sql'),
        '--yes',
      ])
    }
    await setRestoreCheckpoint(options, restoreRunId, 'final_checks', 'running')
    const checks = await runRestoreChecks({ ...options, plan, objectVerification })
    await persistRestoreChecks(options, restoreRunId, checks.items)
    assertNonSearchChecks(checks)
    if (!checks.searchPending) await completeRestoreRun(options, restoreRunId, checks)

    const report = {
      ...plan.report,
      restoreRunId,
      status: checks.searchPending ? 'search_rebuild_pending' : 'restored',
      target,
      checks,
      note: checks.searchPending
        ? '权威数据和对象已经恢复，搜索重建任务已排入；完成搜索任务后再执行 finalize。'
        : '六项恢复检查已经通过。',
    }
    await writeFile(
      join(plan.outputDirectory, '恢复执行报告.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    )
    return report
  } catch (error) {
    await markRestoreFailed(options, restoreRunId, error).catch(() => undefined)
    throw error
  }
}

export async function finalizeRestore(options) {
  if (!options.restoreRunId) throw new Error('finalize 必须指定 --restore-run-id')
  if (!options.expectedManifestSha256) throw new Error('finalize 必须指定 --manifest-sha256')
  const plan = await buildRestorePlan(options)
  assertStorageMode(plan.manifest.storageMode, options.storageMode)
  await assertRestoreRunMatches(options, plan)
  const objectVerification = await verifyStoredObjects(options, plan, { upload: false })
  const checks = await runRestoreChecks({ ...options, plan, objectVerification })
  await persistRestoreChecks(options, options.restoreRunId, checks.items)
  assertNonSearchChecks(checks)
  if (checks.searchPending) {
    return { status: 'search_rebuild_pending', pendingCount: checks.pendingSearchCount }
  }
  await completeRestoreRun(options, options.restoreRunId, checks)
  return {
    status: 'restored',
    pendingCount: 0,
    restoreRunId: options.restoreRunId,
    message: '搜索重建和六项恢复检查已完成。',
  }
}

async function runRestoreChecks(options) {
  const expectedCounts = [...options.plan.tableRows.entries()].map(([table, rows]) => ({
    table,
    count: rows.length,
  }))
  const countQuery = expectedCounts
    .map(
      ({ table }) =>
        `SELECT ${sqlLiteral(table)} AS table_name, COUNT(*) AS row_count FROM ${quoteIdentifier(table)}`,
    )
    .join(' UNION ALL ')
  const result = countQuery
    ? await runD1Json(d1CommandArguments(options, countQuery))
    : [{ results: [] }]
  const counts = new Map(
    result
      .flatMap((item) => item.results ?? [])
      .map((row) => [row.table_name, Number(row.row_count)]),
  )
  const foreignKeyResult = await runD1Json(d1CommandArguments(options, 'PRAGMA foreign_key_check;'))
  const foreignKeyErrors = foreignKeyResult.flatMap((item) => item.results ?? [])
  const searchResult = await runD1Json(
    d1CommandArguments(
      options,
      `SELECT COUNT(*) AS expected_count,
              SUM(CASE WHEN search.index_status = 'ready'
                            AND search.object_set_version = integrity.object_set_version
                       THEN 1 ELSE 0 END) AS actual_count
       FROM message_integrity_states integrity
       LEFT JOIN message_search_states search ON search.message_id = integrity.message_id
       WHERE integrity.integrity_status = 'ready';`,
    ),
  )
  const searchRow = searchResult[0]?.results?.[0] ?? { expected_count: 0, actual_count: 0 }
  const expectedSearchCount = Number(searchRow.expected_count ?? 0)
  const actualSearchCount = Number(searchRow.actual_count ?? 0)
  const pendingCount = Math.max(0, expectedSearchCount - actualSearchCount)
  const countOk = expectedCounts.every(({ table, count }) => counts.get(table) === count)
  const objectReferenceResult = await runD1Json(
    d1CommandArguments(
      options,
      `SELECT COUNT(*) AS object_count FROM object_registry WHERE object_status <> 'deleted';`,
    ),
  )
  const objectReferenceCount = Number(objectReferenceResult[0]?.results?.[0]?.object_count ?? 0)
  const objectHashOk =
    options.objectVerification.length === options.plan.objectPlan.length &&
    options.objectVerification.every((item) => item.status === 'passed')
  const objectReferencesOk = objectReferenceCount === options.plan.objectPlan.length
  const items = [
    restoreCheck('manifest_hash', 'passed', 1, 1),
    restoreCheck(
      'table_counts',
      countOk ? 'passed' : 'failed',
      expectedCounts.reduce((sum, item) => sum + item.count, 0),
      [...counts.values()].reduce((sum, count) => sum + count, 0),
      countOk ? null : 'table_count_mismatch',
    ),
    restoreCheck(
      'object_hashes',
      objectHashOk ? 'passed' : 'failed',
      options.plan.objectPlan.length,
      options.objectVerification.filter((item) => item.status === 'passed').length,
      objectHashOk ? null : 'object_hash_mismatch',
    ),
    restoreCheck(
      'foreign_keys',
      foreignKeyErrors.length === 0 ? 'passed' : 'failed',
      0,
      foreignKeyErrors.length,
      foreignKeyErrors.length === 0 ? null : 'foreign_key_violation',
    ),
    restoreCheck(
      'object_references',
      objectReferencesOk ? 'passed' : 'failed',
      options.plan.objectPlan.length,
      objectReferenceCount,
      objectReferencesOk ? null : 'object_reference_mismatch',
    ),
    restoreCheck(
      'search_rebuild',
      pendingCount === 0 ? 'passed' : 'pending',
      expectedSearchCount,
      actualSearchCount,
    ),
  ]
  return {
    items,
    checks: Object.fromEntries(items.map((item) => [item.kind, item.status])),
    searchPending: pendingCount > 0,
    expectedTableCounts: expectedCounts,
    actualTableCounts: Object.fromEntries(counts),
    objectReferenceCount,
    objectVerification: options.objectVerification,
    foreignKeyErrors,
    pendingSearchCount: pendingCount,
  }
}

function restoreCheck(kind, status, expectedCount, actualCount, failureCode = null) {
  return { kind, status, expectedCount, actualCount, failureCode }
}

function assertNonSearchChecks(checks) {
  const failed = checks.items.filter(
    (item) => item.kind !== 'search_rebuild' && item.status !== 'passed',
  )
  if (failed.length > 0)
    throw new Error(`恢复检查失败：${failed.map((item) => item.kind).join('、')}`)
}

function assertStorageMode(manifestMode, targetMode) {
  if (!['kv', 'r2'].includes(targetMode)) throw new Error('必须指定 --storage-mode kv 或 r2')
  if (manifestMode !== targetMode) {
    throw new Error(`备份存储模式为 ${manifestMode}，恢复目标却指定为 ${targetMode}`)
  }
}

async function assertMigrationCompatibility(options, migrationVersion) {
  const result = await runD1Json(
    d1CommandArguments(options, 'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1;'),
  )
  const currentVersion = result[0]?.results?.[0]?.name
  if (currentVersion !== migrationVersion) {
    throw new Error(
      `恢复目标迁移版本不兼容：备份要求 ${migrationVersion}，目标当前为 ${currentVersion ?? '未知'}`,
    )
  }
}

async function createRestoreRun(options, plan) {
  const restoreRunId = randomUUID()
  const now = Date.now()
  const statements = [
    `INSERT INTO restore_runs (
       id, source_backup_reference, source_manifest_sha256, target_mode,
       maintenance_mode_enabled, pre_restore_backup_reference,
       overwrite_confirmation_digest, restore_status, current_stage,
       last_error_code, started_at, completed_at, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(restoreRunId)}, ${sqlLiteral(plan.manifest.backupReference)},
       X'${plan.report.manifestSha256}', 'empty', 0, NULL, NULL,
       'running', 'd1', NULL, ${now}, NULL, ${now}, ${now}
     );`,
    ...RESTORE_STAGE_KINDS.map((stage) => {
      const completed = stage === 'manifest' || stage === 'migrations'
      return `INSERT INTO restore_checkpoints (
        id, restore_run_id, stage_kind, cursor_value, processed_count,
        failed_count, checkpoint_status, last_error_code, created_at, updated_at
      ) VALUES (
        ${sqlLiteral(randomUUID())}, ${sqlLiteral(restoreRunId)}, ${sqlLiteral(stage)}, NULL,
        ${completed ? 1 : 0}, 0, ${sqlLiteral(completed ? 'completed' : 'pending')},
        NULL, ${now}, ${now}
      );`
    }),
    ...RESTORE_CHECK_KINDS.map((kind) => {
      const manifestPassed = kind === 'manifest_hash'
      return `INSERT INTO restore_checks (
        id, restore_run_id, check_kind, check_status, expected_count,
        actual_count, failure_code, checked_at, created_at, updated_at
      ) VALUES (
        ${sqlLiteral(randomUUID())}, ${sqlLiteral(restoreRunId)}, ${sqlLiteral(kind)},
        ${sqlLiteral(manifestPassed ? 'passed' : 'pending')},
        ${manifestPassed ? 1 : 'NULL'}, ${manifestPassed ? 1 : 'NULL'}, NULL,
        ${manifestPassed ? now : 'NULL'}, ${now}, ${now}
      );`
    }),
  ]
  await runD1Json(d1CommandArguments(options, statements.join('\n')))
  return restoreRunId
}

async function setRestoreCheckpoint(options, restoreRunId, stage, status, processedCount = 0) {
  const now = Date.now()
  await runD1Json(
    d1CommandArguments(
      options,
      `UPDATE restore_checkpoints
       SET checkpoint_status = ${sqlLiteral(status)}, processed_count = ${processedCount},
           failed_count = 0, last_error_code = NULL, updated_at = ${now}
       WHERE restore_run_id = ${sqlLiteral(restoreRunId)} AND stage_kind = ${sqlLiteral(stage)};
       UPDATE restore_runs SET current_stage = ${sqlLiteral(stage)}, updated_at = ${now}
       WHERE id = ${sqlLiteral(restoreRunId)} AND restore_status = 'running';`,
    ),
  )
}

async function persistRestoreChecks(options, restoreRunId, checks) {
  const now = Date.now()
  const statements = checks.map((check) => {
    const databaseStatus = check.status === 'pending' ? 'pending' : check.status
    return `UPDATE restore_checks
      SET check_status = ${sqlLiteral(databaseStatus)},
          expected_count = ${sqlLiteral(check.expectedCount)},
          actual_count = ${sqlLiteral(check.actualCount)},
          failure_code = ${sqlLiteral(check.failureCode)},
          checked_at = ${databaseStatus === 'pending' ? 'NULL' : now}, updated_at = ${now}
      WHERE restore_run_id = ${sqlLiteral(restoreRunId)} AND check_kind = ${sqlLiteral(check.kind)};`
  })
  await runD1Json(d1CommandArguments(options, statements.join('\n')))
}

async function completeRestoreRun(options, restoreRunId, checks) {
  const now = Date.now()
  const expectedSearchCount =
    checks.items.find((item) => item.kind === 'search_rebuild')?.expectedCount ?? 0
  await runD1Json(
    d1CommandArguments(
      options,
      `UPDATE restore_checkpoints
       SET checkpoint_status = 'completed', processed_count = ${expectedSearchCount},
           failed_count = 0, last_error_code = NULL, updated_at = ${now}
       WHERE restore_run_id = ${sqlLiteral(restoreRunId)} AND stage_kind = 'search';
       UPDATE restore_checkpoints
       SET checkpoint_status = 'completed', processed_count = 6,
           failed_count = 0, last_error_code = NULL, updated_at = ${now}
       WHERE restore_run_id = ${sqlLiteral(restoreRunId)} AND stage_kind = 'final_checks';
       UPDATE restore_runs
       SET restore_status = 'succeeded', current_stage = 'completed',
           last_error_code = NULL, completed_at = ${now}, updated_at = ${now}
       WHERE id = ${sqlLiteral(restoreRunId)} AND restore_status = 'running';`,
    ),
  )
}

async function markRestoreFailed(options, restoreRunId, error) {
  const now = Date.now()
  const errorCode = error instanceof Error ? 'restore_execution_failed' : 'restore_unknown_failure'
  await runD1Json(
    d1CommandArguments(
      options,
      `UPDATE restore_checkpoints
       SET checkpoint_status = 'failed', failed_count = failed_count + 1,
           last_error_code = ${sqlLiteral(errorCode)}, updated_at = ${now}
       WHERE restore_run_id = ${sqlLiteral(restoreRunId)}
         AND stage_kind = (SELECT current_stage FROM restore_runs WHERE id = ${sqlLiteral(restoreRunId)});
       UPDATE restore_runs
       SET restore_status = 'failed', last_error_code = ${sqlLiteral(errorCode)},
           completed_at = ${now}, updated_at = ${now}
       WHERE id = ${sqlLiteral(restoreRunId)} AND restore_status IN ('planned', 'validating', 'running');`,
    ),
  )
}

async function assertRestoreRunMatches(options, plan) {
  const result = await runD1Json(
    d1CommandArguments(
      options,
      `SELECT source_backup_reference,
              lower(hex(source_manifest_sha256)) AS source_manifest_sha256,
              restore_status
       FROM restore_runs WHERE id = ${sqlLiteral(options.restoreRunId)} LIMIT 1;`,
    ),
  )
  const row = result[0]?.results?.[0]
  if (!row) throw new Error('找不到指定的恢复运行记录')
  if (
    row.source_backup_reference !== plan.manifest.backupReference ||
    row.source_manifest_sha256 !== plan.report.manifestSha256
  ) {
    throw new Error('恢复运行记录与当前备份清单不匹配')
  }
  if (row.restore_status === 'succeeded') return
  if (row.restore_status !== 'running')
    throw new Error(`恢复运行当前状态不能收口：${row.restore_status}`)
}

async function verifyStoredObjects(options, plan, behavior) {
  if (options.storageMode === 'r2' && !options.bucket) throw new Error('R2 恢复必须指定 --bucket')
  if (options.storageMode === 'kv' && !options.binding) throw new Error('KV 恢复必须指定 --binding')
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'simlettra-restore-object-'))
  const results = []
  try {
    for (const [index, object] of plan.objectPlan.entries()) {
      const sourceFile = resolve(plan.outputDirectory, object.sourceFile)
      if (behavior.upload) await uploadObject(options, object, sourceFile)
      const bytes = await downloadObject(options, object, temporaryDirectory, index)
      const actualSha256 = sha256Hex(bytes)
      const passed = bytes.byteLength === object.sizeBytes && actualSha256 === object.sha256
      results.push({
        objectId: object.objectId,
        objectKey: object.objectKey,
        status: passed ? 'passed' : 'failed',
        expectedSizeBytes: object.sizeBytes,
        actualSizeBytes: bytes.byteLength,
        expectedSha256: object.sha256,
        actualSha256,
      })
    }
    return results
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

async function uploadObject(options, object, sourceFile) {
  if (options.storageMode === 'r2') {
    await runWrangler([
      'r2',
      'object',
      'put',
      `${options.bucket}/${object.objectKey}`,
      ...commonWranglerArguments(options),
      '--file',
      sourceFile,
      '--force',
    ])
    return
  }
  await runWrangler([
    'kv',
    'key',
    'put',
    object.objectKey,
    ...commonWranglerArguments(options),
    '--binding',
    options.binding,
    '--path',
    sourceFile,
  ])
}

async function downloadObject(options, object, temporaryDirectory, index) {
  if (options.storageMode === 'r2') {
    const path = join(temporaryDirectory, `${String(index).padStart(8, '0')}.bin`)
    await runWrangler([
      'r2',
      'object',
      'get',
      `${options.bucket}/${object.objectKey}`,
      ...commonWranglerArguments(options),
      '--file',
      path,
    ])
    return readFile(path)
  }
  return runWrangler(
    [
      'kv',
      'key',
      'get',
      object.objectKey,
      ...commonWranglerArguments(options),
      '--binding',
      options.binding,
    ],
    { binary: true },
  )
}

async function assertEmptyD1Target(options) {
  const result = await runD1Json(
    d1CommandArguments(
      options,
      'SELECT (SELECT COUNT(*) FROM system_instances) AS system_count, (SELECT COUNT(*) FROM users) AS user_count, (SELECT COUNT(*) FROM messages) AS message_count, (SELECT COUNT(*) FROM object_registry) AS object_count, (SELECT COUNT(*) FROM restore_runs) AS restore_count;',
    ),
  )
  const row = result[0]?.results?.[0]
  if (!row) throw new Error('无法读取恢复目标状态')
  if (
    [row.system_count, row.user_count, row.message_count, row.object_count, row.restore_count].some(
      (value) => Number(value) > 0,
    )
  ) {
    throw new Error('恢复目标不是空白资源；为避免覆盖数据，恢复已停止')
  }
  return row
}

function buildSearchRebuildSql(tableRows) {
  const rows = tableRows.get('message_integrity_states') ?? []
  const statements = []
  for (const row of rows) {
    if (row.integrity_status !== 'ready' || typeof row.message_id !== 'string') continue
    const generation = Number(row.object_set_version)
    if (!Number.isSafeInteger(generation) || generation < 1) continue
    const taskId = randomUUID()
    const digest = createHash('sha256')
      .update(`index_message\n${row.message_id}\n${generation}`)
      .digest('hex')
    const now = Date.now()
    statements.push(
      `INSERT OR IGNORE INTO message_search_states (message_id, object_set_version, index_generation, index_status, chunk_count, last_error_code, indexed_at, created_at, updated_at) VALUES (${sqlLiteral(row.message_id)}, ${generation}, ${generation}, 'pending', 0, NULL, NULL, ${now}, ${now});`,
      `INSERT OR IGNORE INTO background_tasks (id, task_type, target_type, target_reference, input_version, task_key_digest, task_status, priority, attempt_count, max_attempts, next_attempt_at, lease_owner_reference, lease_token, lease_expires_at, last_error_code, last_error_summary, last_error_at, completed_at, created_at, updated_at) VALUES (${sqlLiteral(taskId)}, 'index_message', 'message_search', ${sqlLiteral(row.message_id)}, ${generation}, X'${digest}', 'pending', 5, 0, 5, ${now}, NULL, 0, NULL, NULL, NULL, NULL, NULL, ${now}, ${now});`,
    )
  }
  return `${statements.join('\n')}\n`
}

export async function encryptBackupDirectory(options) {
  requireBackupPassword(options.password)
  const manifest = await readJson(options.manifestPath)
  assertManifest(manifest)
  const outputDirectory = resolve(options.outputDirectory)
  await mkdir(outputDirectory)
  const dataDirectory = join(outputDirectory, '数据')
  await mkdir(dataDirectory)
  const inputFiles = [
    options.manifestPath,
    ...(await listPartFiles(options.partsDirectory)).sort((left, right) =>
      basename(left).localeCompare(basename(right)),
    ),
  ]
  const salt = randomBytes(16)
  const derivedKey = pbkdf2Sync(options.password, salt, KDF_ITERATIONS, 64, 'sha256')
  const encryptionKey = derivedKey.subarray(0, 32)
  const metadataKey = derivedKey.subarray(32, 64)
  const files = []

  for (const [index, path] of inputFiles.entries()) {
    const plainBytes = await readFile(path)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce)
    const cipherBytes = Buffer.concat([cipher.update(plainBytes), cipher.final()])
    const authTag = cipher.getAuthTag()
    const encryptedName = `${String(index + 1).padStart(8, '0')}.bin`
    await writeFile(join(dataDirectory, encryptedName), cipherBytes)
    files.push({
      name: basename(path),
      encryptedName,
      nonceBase64: nonce.toString('base64'),
      authTagBase64: authTag.toString('base64'),
      plainSizeBytes: plainBytes.byteLength,
      plainSha256: sha256Hex(plainBytes),
      cipherSizeBytes: cipherBytes.byteLength,
      cipherSha256: sha256Hex(cipherBytes),
    })
  }

  const unsignedMetadata = {
    product: PRODUCT_NAME,
    containerVersion: ENCRYPTED_CONTAINER_VERSION,
    backupReference: manifest.backupReference,
    cipher: ENCRYPTION_ALGORITHM,
    kdf: KDF_NAME,
    kdfIterations: KDF_ITERATIONS,
    saltBase64: salt.toString('base64'),
    files,
  }
  const metadataHmac = createHmac('sha256', metadataKey)
    .update(stableStringify(unsignedMetadata))
    .digest('hex')
  const metadata = { ...unsignedMetadata, metadataHmac }
  await writeFile(
    join(outputDirectory, CONTAINER_METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  )
  return {
    outputDirectory,
    backupReference: manifest.backupReference,
    fileCount: files.length,
    totalPlainBytes: files.reduce((sum, file) => sum + file.plainSizeBytes, 0),
  }
}

export async function decryptBackupDirectory(options) {
  requireBackupPassword(options.password)
  const containerDirectory = resolve(options.containerDirectory)
  const metadata = await readJson(join(containerDirectory, CONTAINER_METADATA_FILE))
  const unsignedMetadata = assertEncryptedContainerMetadata(metadata)
  const salt = Buffer.from(unsignedMetadata.saltBase64, 'base64')
  const derivedKey = pbkdf2Sync(
    options.password,
    salt,
    unsignedMetadata.kdfIterations,
    64,
    'sha256',
  )
  const encryptionKey = derivedKey.subarray(0, 32)
  const metadataKey = derivedKey.subarray(32, 64)
  const expectedHmac = createHmac('sha256', metadataKey)
    .update(stableStringify(unsignedMetadata))
    .digest('hex')
  if (expectedHmac !== metadata.metadataHmac) {
    throw new Error('备份密码错误或加密容器元数据已被修改')
  }

  const outputDirectory = resolve(options.outputDirectory)
  await mkdir(outputDirectory)
  for (const file of unsignedMetadata.files) {
    const cipherBytes = await readFile(join(containerDirectory, '数据', file.encryptedName))
    if (
      cipherBytes.byteLength !== file.cipherSizeBytes ||
      sha256Hex(cipherBytes) !== file.cipherSha256
    ) {
      throw new Error(`加密分卷已损坏：${file.name}`)
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      Buffer.from(file.nonceBase64, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(file.authTagBase64, 'base64'))
    let plainBytes
    try {
      plainBytes = Buffer.concat([decipher.update(cipherBytes), decipher.final()])
    } catch {
      throw new Error(`备份密码错误或加密分卷认证失败：${file.name}`)
    }
    if (
      plainBytes.byteLength !== file.plainSizeBytes ||
      sha256Hex(plainBytes) !== file.plainSha256
    ) {
      throw new Error(`解密后的备份分卷校验失败：${file.name}`)
    }
    await writeFile(join(outputDirectory, file.name), plainBytes)
  }
  return {
    outputDirectory,
    backupReference: unsignedMetadata.backupReference,
    fileCount: unsignedMetadata.files.length,
  }
}

function assertManifest(value) {
  if (!value || typeof value !== 'object') throw new Error('备份清单格式无效')
  const manifest = value
  if (manifest.product !== PRODUCT_NAME) throw new Error('备份清单产品不匹配')
  if (!Array.isArray(manifest.entries) || typeof manifest.backupReference !== 'string') {
    throw new Error('备份清单缺少必要字段')
  }
  return manifest.entries.map((entry) => {
    if (
      !entry ||
      !['d1_table', 'object'].includes(entry.kind) ||
      typeof entry.id !== 'string' ||
      typeof entry.logicalKey !== 'string' ||
      typeof entry.sizeBytes !== 'number' ||
      typeof entry.sha256 !== 'string'
    ) {
      throw new Error('备份分卷清单项格式无效')
    }
    return entry
  })
}

function assertEncryptedContainerMetadata(value) {
  if (!value || typeof value !== 'object') throw new Error('加密备份元数据格式无效')
  if (
    value.product !== PRODUCT_NAME ||
    value.containerVersion !== ENCRYPTED_CONTAINER_VERSION ||
    value.cipher !== ENCRYPTION_ALGORITHM ||
    value.kdf !== KDF_NAME ||
    value.kdfIterations !== KDF_ITERATIONS ||
    typeof value.backupReference !== 'string' ||
    typeof value.saltBase64 !== 'string' ||
    typeof value.metadataHmac !== 'string' ||
    !Array.isArray(value.files)
  ) {
    throw new Error('加密备份元数据不兼容')
  }
  const names = new Set()
  const encryptedNames = new Set()
  const files = value.files.map((file) => {
    if (
      !file ||
      typeof file.name !== 'string' ||
      basename(file.name) !== file.name ||
      typeof file.encryptedName !== 'string' ||
      !/^\d{8}\.bin$/u.test(file.encryptedName) ||
      typeof file.nonceBase64 !== 'string' ||
      typeof file.authTagBase64 !== 'string' ||
      !Number.isSafeInteger(file.plainSizeBytes) ||
      file.plainSizeBytes < 0 ||
      !Number.isSafeInteger(file.cipherSizeBytes) ||
      file.cipherSizeBytes < 0 ||
      !/^[0-9a-f]{64}$/u.test(file.plainSha256) ||
      !/^[0-9a-f]{64}$/u.test(file.cipherSha256)
    ) {
      throw new Error('加密备份分卷元数据无效')
    }
    if (names.has(file.name) || encryptedNames.has(file.encryptedName)) {
      throw new Error('加密备份分卷名称重复')
    }
    names.add(file.name)
    encryptedNames.add(file.encryptedName)
    return file
  })
  return {
    product: value.product,
    containerVersion: value.containerVersion,
    backupReference: value.backupReference,
    cipher: value.cipher,
    kdf: value.kdf,
    kdfIterations: value.kdfIterations,
    saltBase64: value.saltBase64,
    files,
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function listPartFiles(directory) {
  const names = await readdir(directory)
  return names
    .filter((name) => name.toLowerCase().endsWith('.bin'))
    .map((name) => join(directory, name))
}

function locatePartFile({ backupReference, entry, partFiles }) {
  const expectedSuffix = `-${safeFileName(entry.logicalKey)}.bin`
  const expectedPrefix = `simlettra-备份-${backupReference}-`
  const matches = partFiles.filter((file) => {
    const name = basename(file)
    return name.startsWith(expectedPrefix) && name.endsWith(expectedSuffix)
  })
  if (matches.length > 1) throw new Error(`备份分卷文件名冲突：${entry.logicalKey}`)
  return matches[0] ?? null
}

function parseNdjson(bytes, logicalKey, errors) {
  const text = new TextDecoder().decode(bytes)
  if (text.length === 0) return []
  const rows = []
  for (const [index, line] of text.split('\n').entries()) {
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      errors.push({ code: 'ndjson_invalid', logicalKey, line: index + 1 })
    }
  }
  return rows
}

function buildObjectRegistry(tableRows) {
  const rows = tableRows.get('object_registry') ?? []
  const registry = new Map()
  for (const row of rows ?? []) {
    if (!row || typeof row.id !== 'string' || typeof row.object_key !== 'string') continue
    const expectedSha256 = decodeBinaryHex(row.expected_sha256)
    if (!expectedSha256 || typeof row.expected_size_bytes !== 'number') continue
    registry.set(row.id, {
      objectKey: row.object_key,
      expectedSizeBytes: row.expected_size_bytes,
      expectedSha256,
    })
  }
  return registry
}

async function buildD1ImportSql(tableRows, options) {
  const schema = await inspectMigrationSchema(options)
  const importedTables = new Set(tableRows.keys())
  for (const table of importedTables) {
    if (!schema.tables.has(table)) throw new Error(`备份包含目标迁移中不存在的表：${table}`)
  }

  const deferredForeignKeys = schema.foreignKeys.filter(
    (foreignKey) =>
      importedTables.has(foreignKey.table) &&
      importedTables.has(foreignKey.targetTable) &&
      foreignKey.table === foreignKey.targetTable,
  )
  for (const foreignKey of deferredForeignKeys) {
    if (!foreignKey.nullable) {
      throw new Error(
        `恢复计划发现不能分阶段处理的非空循环外键：${foreignKey.table}.${foreignKey.column}`,
      )
    }
  }

  const dependencies = new Map([...importedTables].map((table) => [table, new Set()]))
  for (const foreignKey of schema.foreignKeys) {
    if (
      foreignKey.table !== foreignKey.targetTable &&
      importedTables.has(foreignKey.table) &&
      importedTables.has(foreignKey.targetTable)
    ) {
      dependencies.get(foreignKey.table).add(foreignKey.targetTable)
    }
  }
  const tableOrder = topologicalTableOrder(dependencies)
  const deferredByTable = new Map()
  for (const foreignKey of deferredForeignKeys) {
    const columns = deferredByTable.get(foreignKey.table) ?? []
    columns.push(foreignKey)
    deferredByTable.set(foreignKey.table, columns)
  }

  const statements = [
    '-- 由澄笺本地恢复工具生成。目标必须是已经应用正式迁移的空白 D1。',
    '-- D1 外部 SQL 不支持显式事务；任一步失败后必须废弃目标资源并重新恢复。',
    ...schema.triggers.map((trigger) => `DROP TRIGGER ${quoteIdentifier(trigger.name)};`),
  ]
  for (const table of tableOrder.filter((name) => MIGRATION_SEED_TABLES.has(name))) {
    statements.push(`DELETE FROM ${quoteIdentifier(table)};`)
  }
  for (const table of tableOrder) {
    const rows = tableRows.get(table) ?? []
    if (rows.length === 0) continue
    const columns = collectRowColumns(rows)
    const deferredColumns = new Set(
      (deferredByTable.get(table) ?? []).map((foreignKey) => foreignKey.column),
    )
    for (const row of rows) {
      statements.push(
        `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map((column) => sqlLiteral(deferredColumns.has(column) ? null : row[column])).join(', ')});`,
      )
    }
  }
  for (const [table, foreignKeys] of deferredByTable) {
    const primaryKeyColumns = schema.tables.get(table).primaryKeyColumns
    if (primaryKeyColumns.length === 0) {
      throw new Error(`循环外键表缺少主键，无法安全回填：${table}`)
    }
    for (const row of tableRows.get(table) ?? []) {
      for (const foreignKey of foreignKeys) {
        if (row[foreignKey.column] === null || row[foreignKey.column] === undefined) continue
        statements.push(
          `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(foreignKey.column)} = ${sqlLiteral(row[foreignKey.column])} WHERE ${primaryKeyColumns.map((column) => `${quoteIdentifier(column)} = ${sqlLiteral(row[column])}`).join(' AND ')};`,
        )
      }
    }
  }
  for (const trigger of schema.triggers) statements.push(`${trigger.sql};`)
  statements.push('')
  return {
    sql: statements.join('\n'),
    tableOrder,
    deferredForeignKeys: deferredForeignKeys.map((foreignKey) => ({
      table: foreignKey.table,
      column: foreignKey.column,
      targetTable: foreignKey.targetTable,
    })),
  }
}

async function inspectMigrationSchema(options) {
  const migrationsDirectory = resolve(options.migrationsDirectory)
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right))
  const targetIndex = migrationFiles.indexOf(options.migrationVersion)
  if (targetIndex === -1) {
    throw new Error(`本地正式迁移中找不到备份版本：${options.migrationVersion}`)
  }
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('PRAGMA foreign_keys = ON;')
    for (const migration of migrationFiles.slice(0, targetIndex + 1)) {
      database.exec(await readFile(join(migrationsDirectory, migration), 'utf8'))
    }
    const tableNames = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    const tables = new Map()
    const foreignKeys = []
    for (const table of tableNames) {
      const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
      tables.set(table, {
        primaryKeyColumns: columns
          .filter((column) => Number(column.pk) > 0)
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((column) => column.name),
      })
      const columnsByName = new Map(columns.map((column) => [column.name, column]))
      for (const row of database
        .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
        .all()) {
        foreignKeys.push({
          table,
          column: row.from,
          targetTable: row.table,
          targetColumn: row.to,
          nullable: Number(columnsByName.get(row.from)?.notnull ?? 0) === 0,
        })
      }
    }
    const triggers = database
      .prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name`,
      )
      .all()
    return { tables, foreignKeys, triggers }
  } finally {
    database.close()
  }
}

function topologicalTableOrder(dependencies) {
  const remaining = new Map([...dependencies].map(([table, values]) => [table, new Set(values)]))
  const order = []
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, values]) => values.size === 0)
      .map(([table]) => table)
      .sort((left, right) => left.localeCompare(right))
    if (ready.length === 0) {
      const cycle = [...remaining].map(([table, values]) => `${table}->${[...values].join(',')}`)
      throw new Error(`恢复计划发现不能处理的外键循环：${cycle.join('；')}`)
    }
    for (const table of ready) {
      order.push(table)
      remaining.delete(table)
      for (const values of remaining.values()) values.delete(table)
    }
  }
  return order
}

function collectRowColumns(rows) {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))].sort((left, right) =>
    left.localeCompare(right),
  )
}

function buildCheckSql(tableRows) {
  const tables = [...tableRows.keys()]
  return (
    [
      'PRAGMA foreign_keys = ON;',
      'PRAGMA foreign_key_check;',
      ...tables.map(
        (table) =>
          `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM ${quoteIdentifier(table)};`,
      ),
    ].join('\n') + '\n'
  )
}

function buildInstructions(manifest, outputDirectory) {
  return `# 澄笺 | Simlettra 本地备份恢复计划

## 当前状态

本目录由本地恢复工具生成，已完成清单、分卷、大小、SHA-256、表行数和对象登记引用校验。它只允许导入到空白目标，不会自动覆盖现有系统。

## 生成文件

- \`d1-import.sql\`：导入权威 D1 普通表数据。
- \`对象上传清单.json\`：把对象分卷上传到目标 KV 或 R2 的清单。
- \`恢复检查.sql\`：导入后执行外键和数量检查。
- \`恢复报告.json\`：机器可读的校验结果。

## 执行前确认

1. 目标 D1 已按迁移版本 \`${manifest.migrationVersion}\` 建立，且没有业务数据。
2. 目标使用与备份一致的 \`${manifest.storageMode}\` 存储模式。
3. 已准备清单要求的配置加密主密钥版本；密钥不会出现在本目录或备份清单中。
4. 已为目标资源准备独立的回退和删除方案。

## 执行顺序

1. 先在目标 D1 执行 \`d1-import.sql\`。
2. 再按 \`对象上传清单.json\` 上传对象，并逐项核对大小和 SHA-256。
3. 执行 \`恢复检查.sql\`，确认外键、表行数和对象引用全部一致。
4. 运行系统搜索索引重建任务；索引完成前不要把恢复宣称为成功。

目标目录：\`${outputDirectory}\`
`
}

function tableName(logicalKey) {
  const separator = logicalKey.indexOf('/')
  return separator > 0 ? logicalKey.slice(0, separator) : logicalKey
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(`非法标识符：${value}`)
  return `"${value}"`
}

function sqlLiteral(value) {
  const binary = decodeBinaryHex(value)
  if (binary) return `X'${binary}'`
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('不支持的数值')
    return String(value)
  }
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replaceAll("'", "''")}'`
}

function decodeBinaryHex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.__binary_hex !== 'string' || !/^[0-9a-f]*$/iu.test(value.__binary_hex))
    return null
  return value.__binary_hex.toLowerCase()
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeFileName(value) {
  return value.replaceAll(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120) || '分卷'
}

function requireBackupPassword(value) {
  if (typeof value !== 'string' || [...value].length < 12) {
    throw new Error('备份密码至少需要 12 个字符')
  }
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

function commonWranglerArguments(options) {
  if (!options.configPath) throw new Error('必须指定 --config')
  const args = [options.remote ? '--remote' : '--local', '--config', resolve(options.configPath)]
  if (!options.remote && options.persistTo) args.push('--persist-to', resolve(options.persistTo))
  return args
}

function d1CommandArguments(options, command) {
  if (!options.database) throw new Error('必须指定 --database')
  return [
    'd1',
    'execute',
    options.database,
    ...commonWranglerArguments(options),
    '--command',
    command,
    '--json',
  ]
}

async function runD1Json(args) {
  const output = await runWrangler(args)
  const text = output.toString('utf8').replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
    for (let end = text.lastIndexOf(']'); end > start; end = text.lastIndexOf(']', end - 1)) {
      try {
        const value = JSON.parse(text.slice(start, end + 1))
        if (Array.isArray(value)) return value
      } catch {
        // Wrangler 可能在 JSON 前后输出诊断信息，继续尝试下一个数组边界。
      }
    }
  }
  throw new Error(`无法解析 Wrangler D1 JSON 输出：${text.trim() || '标准输出为空'}`)
}

function runWrangler(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [WRANGLER_PATH, ...args], {
      cwd: PROJECT_DIRECTORY,
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
      const output = Buffer.concat(stdout)
      const errors = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        rejectPromise(
          new Error(`Wrangler 执行失败（${code}）：${errors || output.toString('utf8')}`),
        )
        return
      }
      if (!options.binary && errors && !errors.includes('Failed to write to log file')) {
        process.stderr.write(`${errors}\n`)
      }
      const textOutput = output.toString('utf8')
      resolvePromise(options.binary ? output : textOutput || errors)
    })
  })
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  await runCli(process.argv.slice(2))
}

async function runCli(args) {
  const command = args[0]
  const values = parseArguments(args.slice(1))
  if (!['validate', 'plan', 'pack', 'unpack', 'apply', 'finalize'].includes(command)) {
    throw new Error(
      '用法：node tools/本地备份恢复.mjs validate|plan|pack|unpack|apply|finalize [参数]',
    )
  }
  if (command === 'pack') {
    const password = await readCliPassword(values)
    const result = await encryptBackupDirectory({
      manifestPath: values.manifest,
      partsDirectory: values.parts,
      outputDirectory: values.output,
      password,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  if (command === 'unpack') {
    const password = await readCliPassword(values)
    const result = await decryptBackupDirectory({
      containerDirectory: values.container,
      outputDirectory: values.output,
      password,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  const options = {
    manifestPath: values.manifest,
    partsDirectory: values.parts,
    expectedManifestSha256: values['manifest-sha256'],
    outputDirectory: values.output,
    migrationsDirectory: values.migrations,
  }
  if (!options.manifestPath || !options.partsDirectory)
    throw new Error('必须指定 --manifest 和 --parts')
  if (command === 'validate') {
    const result = await validateBackupDirectory(options)
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
    if (result.report.errors.length > 0) process.exitCode = 2
    return
  }
  if (!values.output) throw new Error(`${command} 必须指定 --output`)
  if (command === 'apply' || command === 'finalize') {
    const executionOptions = {
      ...options,
      configPath: values.config,
      database: values.database,
      storageMode: values['storage-mode'],
      bucket: values.bucket,
      binding: values.binding,
      persistTo: values['persist-to'],
      remote: values.remote === true,
      confirmation: values['confirm-empty-target'],
      restoreRunId: values['restore-run-id'],
    }
    if (command === 'apply') {
      const result = await applyRestorePlan(executionOptions)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }
    const result = await finalizeRestore(executionOptions)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  const result = await buildRestorePlan(options)
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
}

async function readCliPassword(values) {
  if (values['password-file']) {
    return (await readFile(values['password-file'], 'utf8')).replace(/[\r\n]+$/u, '')
  }
  const password = process.env.SIMLETTRA_BACKUP_PASSWORD
  if (!password) {
    throw new Error('请通过 SIMLETTRA_BACKUP_PASSWORD 或 --password-file 提供备份密码')
  }
  return password
}

function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    if (key === 'remote') {
      values[key] = true
      continue
    }
    if (args[index + 1] === undefined || args[index + 1].startsWith('--')) {
      throw new Error(`参数 --${key} 缺少值`)
    }
    values[key] = args[index + 1]
    index += 1
  }
  return values
}
