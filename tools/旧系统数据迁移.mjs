import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { domainToASCII, fileURLToPath } from 'node:url'

const PRODUCT_NAME = '澄笺 | Simlettra'
const SOURCE_SYSTEM = 'simletter'
const SOURCE_VERSION = 'legacy-current-schema'
const SOURCE_REFERENCE_COMMIT = '9d016831ff2d862e38c08d9376a58327bc8933df'
const SNAPSHOT_FORMAT_VERSION = 1
const MIGRATION_RULES_VERSION = 1
const TARGET_MIGRATION_VERSION = '0019-旧系统数据迁移.sql'
const RECONSTRUCTION_VERSION = 'simlettra-legacy-structured-v1'
const REHEARSAL_REPORT_VERSION = 1
const FORMAL_CONFIRMATION = 'MIGRATE_LEGACY_COPY'
const KV_FREE_LIMIT_BYTES = 1_000_000_000
const R2_FREE_LIMIT_BYTES = 10_000_000_000
const D1_DATABASE_FREE_LIMIT_BYTES = 500_000_000
const TABLE_NAMES = ['user', 'account', 'email', 'attachments', 'star']
const ENTITY_TYPES = ['user', 'domain', 'address', 'message', 'body', 'attachment', 'star']
const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIRECTORY = resolve(TOOL_DIRECTORY, '..')
const WRANGLER_PATH = join(PROJECT_DIRECTORY, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const MESSAGE_REFERENCE_PATTERN = /<[^<>\s]{1,996}>/gu

export async function createLegacySnapshot(options) {
  requireStorageOptions(options, 'source')
  if (!options.outputDirectory) throw new Error('snapshot 必须指定 --output')
  const outputDirectory = resolve(options.outputDirectory)
  const tableDirectory = join(outputDirectory, '表')
  const objectDirectory = join(outputDirectory, '对象')
  await mkdir(tableDirectory, { recursive: true })
  await mkdir(objectDirectory, { recursive: true })

  const tableList = await runD1Json(
    d1CommandArguments(
      options,
      'source',
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    ),
  )
  const existingTables = new Set(
    tableList.flatMap((item) => item.results ?? []).map((row) => String(row.name)),
  )
  const errors = []
  const warnings = []
  const tableEntries = []
  const tableRows = new Map()

  for (const table of TABLE_NAMES) {
    if (!existingTables.has(table)) {
      errors.push({ code: 'source_table_missing', table })
      tableRows.set(table, [])
      continue
    }
    const primaryKey = legacyPrimaryKey(table)
    const result = await runD1Json(
      d1CommandArguments(
        options,
        'source',
        `SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier(primaryKey)};`,
      ),
    )
    const rows = result.flatMap((item) => item.results ?? []).map(normalizeWranglerRow)
    tableRows.set(table, rows)
    const bytes = Buffer.from(
      rows.map((row) => stableStringify(row)).join('\n') + (rows.length ? '\n' : ''),
    )
    const file = `表/${table}.ndjson`
    await writeFile(join(outputDirectory, file), bytes)
    tableEntries.push({
      kind: 'table',
      logicalKey: table,
      file,
      rowCount: rows.length,
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    })
  }

  const objectKeys = collectReferencedLegacyObjectKeys(tableRows)
  const objectEntries = []
  for (const [index, legacyKey] of [...objectKeys].sort().entries()) {
    try {
      const bytes = await downloadBoundObject(options, 'source', legacyKey)
      const sha256 = sha256Hex(bytes)
      const file = `对象/${String(index + 1).padStart(8, '0')}-${sha256}.bin`
      await writeFile(join(outputDirectory, file), bytes)
      objectEntries.push({
        kind: 'object',
        logicalKey: legacyKey,
        file,
        sizeBytes: bytes.byteLength,
        sha256,
      })
    } catch (error) {
      errors.push({
        code: 'source_object_missing',
        logicalKey: legacyKey,
        summary: safeErrorSummary(error),
      })
    }
  }

  const fixedManifest = {
    product: PRODUCT_NAME,
    sourceSystem: SOURCE_SYSTEM,
    sourceVersion: SOURCE_VERSION,
    sourceReferenceCommit: SOURCE_REFERENCE_COMMIT,
    snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
    migrationRulesVersion: MIGRATION_RULES_VERSION,
    storageMode: options.sourceStorageMode,
    entries: [...tableEntries, ...objectEntries].sort(compareManifestEntries),
  }
  const sourceSnapshotSha256 = sha256Hex(Buffer.from(stableStringify(fixedManifest)))
  const manifest = { ...fixedManifest, sourceSnapshotSha256 }
  const report = buildSnapshotReport({ manifest, tableRows, errors, warnings })
  await writeJson(join(outputDirectory, '迁移清单.json'), manifest)
  await writeJson(join(outputDirectory, '快照报告.json'), report)
  return { outputDirectory, manifest, report }
}

export async function validateLegacySnapshot(options) {
  if (!options.snapshotDirectory) throw new Error('必须指定快照目录')
  const snapshotDirectory = resolve(options.snapshotDirectory)
  const manifest = await readJson(join(snapshotDirectory, '迁移清单.json'))
  assertSnapshotManifest(manifest)
  const errors = []
  const warnings = []
  const tableRows = new Map()
  const objectEntries = new Map()

  const fixedManifest = { ...manifest }
  delete fixedManifest.sourceSnapshotSha256
  const calculatedSnapshotSha256 = sha256Hex(Buffer.from(stableStringify(fixedManifest)))
  if (calculatedSnapshotSha256 !== manifest.sourceSnapshotSha256) {
    errors.push({
      code: 'snapshot_digest_mismatch',
      expected: manifest.sourceSnapshotSha256,
      actual: calculatedSnapshotSha256,
    })
  }

  for (const entry of manifest.entries) {
    const path = resolveSnapshotFile(snapshotDirectory, entry.file)
    let bytes
    try {
      bytes = await readFile(path)
    } catch {
      errors.push({ code: 'snapshot_file_missing', logicalKey: entry.logicalKey, file: entry.file })
      continue
    }
    const actualSha256 = sha256Hex(bytes)
    if (actualSha256 !== entry.sha256) {
      errors.push({
        code: 'snapshot_file_hash_mismatch',
        logicalKey: entry.logicalKey,
        expected: entry.sha256,
        actual: actualSha256,
      })
      continue
    }
    if (bytes.byteLength !== entry.sizeBytes) {
      errors.push({
        code: 'snapshot_file_size_mismatch',
        logicalKey: entry.logicalKey,
        expected: entry.sizeBytes,
        actual: bytes.byteLength,
      })
      continue
    }
    if (entry.kind === 'table') {
      const rows = parseNdjson(bytes, entry.logicalKey, errors)
      if (rows.length !== entry.rowCount) {
        errors.push({
          code: 'snapshot_table_count_mismatch',
          logicalKey: entry.logicalKey,
          expected: entry.rowCount,
          actual: rows.length,
        })
      }
      tableRows.set(entry.logicalKey, rows)
    } else {
      objectEntries.set(entry.logicalKey, { ...entry, path, bytes })
    }
  }
  for (const table of TABLE_NAMES) {
    if (!tableRows.has(table)) errors.push({ code: 'snapshot_table_missing', table })
  }
  const referencedKeys = collectReferencedLegacyObjectKeys(tableRows)
  for (const key of referencedKeys) {
    if (!objectEntries.has(key)) errors.push({ code: 'snapshot_object_missing', logicalKey: key })
  }
  for (const key of objectEntries.keys()) {
    if (!referencedKeys.has(key))
      warnings.push({ code: 'snapshot_object_unreferenced', logicalKey: key })
  }

  const report = buildSnapshotReport({ manifest, tableRows, errors, warnings })
  return { snapshotDirectory, manifest, report, tableRows, objectEntries }
}

export async function buildLegacyMigrationPlan(options) {
  const validation = await validateLegacySnapshot(options)
  if (validation.report.errors.length > 0) {
    throw new Error(`旧系统快照校验失败：${JSON.stringify(validation.report.errors)}`)
  }
  const target = assertTargetFacts(options.targetFacts)
  const runMode = options.runMode === 'formal' ? 'formal' : 'rehearsal'
  const runId =
    options.runId ?? stableId(`migration-${runMode}`, validation.manifest.sourceSnapshotSha256)
  const now = Number.isSafeInteger(options.now) ? options.now : Date.now()
  const model = buildLegacyModel(validation, target, { runId, runMode, now })
  assertExistingMigrationRuns(target, validation.manifest)
  assertExistingSourceMappings(model, target, validation.manifest)
  assertLogicalStorageCapacity(model, target)
  assertPlatformObjectCapacity(model, target)
  const sql = buildMigrationSql(model, target, {
    runId,
    runMode,
    now,
    manifest: validation.manifest,
    rehearsal: options.rehearsal ?? null,
  })
  assertD1Capacity(sql, target)
  return {
    ...validation,
    target,
    model,
    runId,
    runMode,
    now,
    sql,
    objectPlan: model.objects,
    counts: model.counts,
  }
}

export async function rehearseLegacyMigration(options) {
  requireStorageOptions(options, 'target')
  if (!options.reportPath) throw new Error('演练必须指定 --report')
  const targetFacts = await loadTargetFacts(options)
  const plan = await buildLegacyMigrationPlan({
    ...options,
    targetFacts,
    runMode: 'rehearsal',
  })
  const execution = await executeMigrationPlan(options, plan)
  const fixedReport = buildExecutionReport(plan, execution, 'rehearsal')
  const reportSha256 = sha256Hex(Buffer.from(stableStringify(fixedReport)))
  const report = { ...fixedReport, reportSha256 }
  await writeJson(resolve(options.reportPath), report)
  return report
}

export async function applyLegacyMigration(options) {
  requireStorageOptions(options, 'target')
  if (options.confirmation !== FORMAL_CONFIRMATION) {
    throw new Error(`正式迁移必须明确传入 --confirm ${FORMAL_CONFIRMATION}`)
  }
  if (!options.rehearsalReportPath) throw new Error('正式迁移必须指定 --rehearsal-report')
  const targetFacts = await loadTargetFacts(options)
  const manifest = await readJson(join(resolve(options.snapshotDirectory), '迁移清单.json'))
  assertSnapshotManifest(manifest)
  const rehearsal = await readAndValidateRehearsalReport(
    options.rehearsalReportPath,
    manifest,
    targetFacts.storageMode,
  )
  const plan = await buildLegacyMigrationPlan({
    ...options,
    targetFacts,
    runMode: 'formal',
    rehearsal,
  })
  const execution = await executeMigrationPlan(options, plan)
  const fixedReport = buildExecutionReport(plan, execution, 'formal')
  const report = {
    ...fixedReport,
    rehearsalRunId: rehearsal.runId,
    rehearsalReportSha256: rehearsal.reportSha256,
  }
  if (options.reportPath) await writeJson(resolve(options.reportPath), report)
  return report
}

async function executeMigrationPlan(options, plan) {
  const objectVerification = await uploadAndVerifyObjects(options, plan.objectPlan)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'simlettra-legacy-migration-'))
  try {
    const sqlPath = join(temporaryDirectory, '迁移提交.sql')
    await writeFile(sqlPath, plan.sql, 'utf8')
    await runWrangler([
      'd1',
      'execute',
      options.targetDatabase,
      ...commonWranglerArguments(options, 'target'),
      '--file',
      sqlPath,
      '--yes',
    ])
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
  const checks = await verifyMigrationResult(options, plan, objectVerification)
  if (checks.some((check) => check.status !== 'passed')) {
    throw new LegacyMigrationValidationError(
      '迁移提交后的检查没有全部通过',
      checks.filter((check) => check.status !== 'passed'),
    )
  }
  return { objectVerification, checks, completedAt: Date.now() }
}

async function uploadAndVerifyObjects(options, objects) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'simlettra-legacy-objects-'))
  const results = []
  try {
    for (const [index, object] of objects.entries()) {
      const sourceFile = join(temporaryDirectory, `${String(index).padStart(8, '0')}-source.bin`)
      const downloadedFile = join(
        temporaryDirectory,
        `${String(index).padStart(8, '0')}-downloaded.bin`,
      )
      await writeFile(sourceFile, object.bytes)
      await uploadBoundObject(options, 'target', object.objectKey, sourceFile)
      const bytes = await downloadBoundObject(options, 'target', object.objectKey, downloadedFile)
      const actualSha256 = sha256Hex(bytes)
      const passed = bytes.byteLength === object.sizeBytes && actualSha256 === object.sha256
      results.push({
        objectId: object.id,
        objectKey: object.objectKey,
        status: passed ? 'passed' : 'failed',
        expectedSizeBytes: object.sizeBytes,
        actualSizeBytes: bytes.byteLength,
        expectedSha256: object.sha256,
        actualSha256,
      })
      if (!passed) {
        throw new LegacyMigrationValidationError('迁移对象回读校验失败', [results.at(-1)])
      }
    }
    return results
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

async function verifyMigrationResult(options, plan, objectVerification) {
  const runRows = await queryTarget(
    options,
    `SELECT run_status, source_snapshot_sha256, migration_rules_version, target_version
     FROM migration_runs WHERE id = ${sqlLiteral(plan.runId)} LIMIT 1;`,
  )
  const reconciliationRows = await queryTarget(
    options,
    `SELECT entity_type, expected_count, scanned_count, succeeded_count, skipped_count,
            failed_count, reconciliation_status
     FROM migration_reconciliations
     WHERE migration_run_id = ${sqlLiteral(plan.runId)} ORDER BY entity_type;`,
  )
  const mappingRows = await queryTarget(
    options,
    `SELECT source_entity_type, COUNT(*) AS item_count
     FROM migration_source_mappings
     WHERE source_system = ${sqlLiteral(SOURCE_SYSTEM)}
       AND source_snapshot_sha256 = X'${plan.manifest.sourceSnapshotSha256}'
     GROUP BY source_entity_type ORDER BY source_entity_type;`,
  )
  const contentRows = await queryTarget(
    options,
    `SELECT
       (SELECT COUNT(*) FROM migrated_message_sources WHERE migration_run_id = ${sqlLiteral(plan.runId)}) AS message_count,
       (SELECT COUNT(*) FROM migrated_message_sources AS source
          JOIN message_search_states AS search ON search.message_id = source.message_id
         WHERE source.migration_run_id = ${sqlLiteral(plan.runId)} AND search.index_status = 'ready') AS search_ready_count,
       (SELECT COUNT(*) FROM migrated_message_sources AS source
          JOIN mailbox_entries AS entry ON entry.message_id = source.message_id
          LEFT JOIN mailbox_conversation_entries AS member ON member.mailbox_entry_id = entry.id
         WHERE source.migration_run_id = ${sqlLiteral(plan.runId)} AND member.mailbox_entry_id IS NULL) AS conversation_missing_count,
       (SELECT COUNT(*) FROM object_registry AS object
          JOIN migrated_message_sources AS source ON source.message_id = object.message_id
         WHERE source.migration_run_id = ${sqlLiteral(plan.runId)}
           AND object.object_status = 'active' AND object.is_current = 1) AS object_count;`,
  )
  const foreignKeyRows = await queryTarget(options, 'PRAGMA foreign_key_check;')
  const run = runRows[0]
  const reconciliations = new Map(reconciliationRows.map((row) => [String(row.entity_type), row]))
  const mappings = new Map(
    mappingRows.map((row) => [String(row.source_entity_type), Number(row.item_count)]),
  )
  const content = contentRows[0] ?? {}
  const checks = []
  checks.push(
    migrationCheck(
      'migration_run',
      run?.run_status === 'succeeded' &&
        normalizeBinaryHex(run.source_snapshot_sha256) === plan.manifest.sourceSnapshotSha256 &&
        Number(run.migration_rules_version) === MIGRATION_RULES_VERSION &&
        run.target_version === TARGET_MIGRATION_VERSION,
      { actual: run ?? null },
    ),
  )
  for (const type of ENTITY_TYPES) {
    const expected = plan.counts[type]
    const actual = reconciliations.get(type)
    checks.push(
      migrationCheck(
        `reconciliation:${type}`,
        actual?.reconciliation_status === 'matched' &&
          Number(actual.expected_count) === expected.scanned &&
          Number(actual.scanned_count) === expected.scanned &&
          Number(actual.succeeded_count) === expected.succeeded &&
          Number(actual.skipped_count) === expected.skipped &&
          Number(actual.failed_count) === 0,
        { expected, actual: actual ?? null },
      ),
    )
    checks.push(
      migrationCheck(`mapping:${type}`, (mappings.get(type) ?? 0) === expected.succeeded, {
        expected: expected.succeeded,
        actual: mappings.get(type) ?? 0,
      }),
    )
  }
  checks.push(
    migrationCheck(
      'objects',
      objectVerification.every((item) => item.status === 'passed'),
      {
        expected: plan.objectPlan.length,
        actual: objectVerification.filter((item) => item.status === 'passed').length,
      },
    ),
    migrationCheck('object_registry', Number(content.object_count) === plan.objectPlan.length, {
      expected: plan.objectPlan.length,
      actual: Number(content.object_count ?? 0),
    }),
    migrationCheck(
      'message_sources',
      Number(content.message_count) === plan.model.messages.length,
      {
        expected: plan.model.messages.length,
        actual: Number(content.message_count ?? 0),
      },
    ),
    migrationCheck(
      'search_index',
      Number(content.search_ready_count) === plan.model.messages.length,
      { expected: plan.model.messages.length, actual: Number(content.search_ready_count ?? 0) },
    ),
    migrationCheck('conversations', Number(content.conversation_missing_count) === 0, {
      expected: 0,
      actual: Number(content.conversation_missing_count ?? 0),
    }),
    migrationCheck('foreign_keys', foreignKeyRows.length === 0, {
      actual: foreignKeyRows.slice(0, 20),
    }),
  )
  return checks
}

function buildExecutionReport(plan, execution, runMode) {
  return {
    product: PRODUCT_NAME,
    reportVersion: REHEARSAL_REPORT_VERSION,
    status: 'succeeded',
    runMode,
    runId: plan.runId,
    sourceSystem: SOURCE_SYSTEM,
    sourceVersion: plan.manifest.sourceVersion,
    sourceReferenceCommit: plan.manifest.sourceReferenceCommit,
    sourceSnapshotSha256: plan.manifest.sourceSnapshotSha256,
    snapshotFormatVersion: plan.manifest.snapshotFormatVersion,
    migrationRulesVersion: plan.manifest.migrationRulesVersion,
    targetMigrationVersion: TARGET_MIGRATION_VERSION,
    sourceStorageMode: plan.manifest.storageMode,
    targetStorageMode: plan.target.storageMode,
    counts: plan.counts,
    objects: {
      count: plan.objectPlan.length,
      sizeBytes: plan.objectPlan.reduce((sum, object) => sum + object.sizeBytes, 0),
    },
    checks: execution.checks,
    completedAt: execution.completedAt,
  }
}

async function readAndValidateRehearsalReport(path, manifest, targetStorageMode) {
  const report = await readJson(resolve(path))
  const fixedReport = { ...report }
  delete fixedReport.reportSha256
  const actualSha256 = sha256Hex(Buffer.from(stableStringify(fixedReport)))
  if (
    report.product !== PRODUCT_NAME ||
    report.reportVersion !== REHEARSAL_REPORT_VERSION ||
    report.status !== 'succeeded' ||
    report.runMode !== 'rehearsal' ||
    typeof report.runId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(String(report.reportSha256 ?? '')) ||
    report.reportSha256 !== actualSha256 ||
    report.sourceSystem !== SOURCE_SYSTEM ||
    report.sourceVersion !== manifest.sourceVersion ||
    report.sourceReferenceCommit !== manifest.sourceReferenceCommit ||
    report.sourceSnapshotSha256 !== manifest.sourceSnapshotSha256 ||
    report.snapshotFormatVersion !== manifest.snapshotFormatVersion ||
    report.migrationRulesVersion !== manifest.migrationRulesVersion ||
    report.targetMigrationVersion !== TARGET_MIGRATION_VERSION ||
    report.sourceStorageMode !== manifest.storageMode ||
    report.targetStorageMode !== targetStorageMode ||
    !Array.isArray(report.checks) ||
    report.checks.some((check) => check?.status !== 'passed')
  ) {
    throw new Error('演练报告无效、已被修改，或与当前快照和迁移规则不一致')
  }
  for (const type of ENTITY_TYPES) {
    const count = report.counts?.[type]
    if (
      !count ||
      !['scanned', 'succeeded', 'skipped', 'failed'].every(
        (key) => Number.isSafeInteger(count[key]) && count[key] >= 0,
      ) ||
      count.failed !== 0 ||
      count.succeeded + count.skipped !== count.scanned
    ) {
      throw new Error(`演练报告的 ${type} 对账无效`)
    }
  }
  return report
}

function buildLegacyModel(validation, target, execution) {
  const users = validation.tableRows.get('user') ?? []
  const accounts = validation.tableRows.get('account') ?? []
  const emails = validation.tableRows.get('email') ?? []
  const attachments = validation.tableRows.get('attachments') ?? []
  const stars = validation.tableRows.get('star') ?? []
  const failures = []
  const skipped = Object.fromEntries(ENTITY_TYPES.map((type) => [type, 0]))
  const targetUsers = []
  const domains = new Map()
  const addresses = []
  const messages = []
  const objects = []
  const sourceMappings = []
  const passwordResults = []
  const activeSourceUsers = new Map()
  const addressBySourceAccount = new Map()
  const addressByCanonical = new Map()

  for (const source of users) {
    const sourceId = sourceIdOf(source.user_id, 'user')
    if (numberFlag(source.is_del) === 1) {
      skipped.user += 1
      continue
    }
    let normalized
    try {
      normalized = normalizeManagedEmailAddress(source.email)
    } catch (error) {
      failures.push(failure('user', sourceId, 'invalid_primary_address', error))
      continue
    }
    if (activeSourceUsers.has(sourceId)) {
      failures.push(failure('user', sourceId, 'duplicate_source_user', '旧用户编号重复'))
      continue
    }
    const isExistingAdmin = normalized.canonicalAddress === target.adminPrimaryAddress
    const userId = isExistingAdmin
      ? target.adminUserId
      : stableId('legacy-user', validation.manifest.sourceSnapshotSha256, sourceId)
    const createdAt = parseLegacyTime(source.create_time, execution.now)
    const displayName = safeDisplayName(source.email, normalized.localPart)
    const user = {
      sourceId,
      id: userId,
      isExistingAdmin,
      status: numberFlag(source.status) === 1 ? 'disabled' : 'active',
      displayName,
      createdAt,
      primaryAddress: normalized.canonicalAddress,
      primaryAddressId: isExistingAdmin ? target.adminAddressId : null,
      primaryBindingId: isExistingAdmin ? target.adminBindingId : null,
      aliasCount: 0,
    }
    activeSourceUsers.set(sourceId, user)
    targetUsers.push(user)
    sourceMappings.push(
      mapping(
        execution.runId,
        validation.manifest,
        'user',
        sourceId,
        source,
        'user',
        userId,
        execution.now,
      ),
    )
    const sourceParametersDigest = sha256Hex(
      Buffer.from(
        `SHA-256(salt + password)\n${String(source.salt ?? '')}\n${String(source.password ?? '')}`,
      ),
    )
    passwordResults.push({
      userId,
      sourceUserId: sourceId,
      result: isExistingAdmin ? 'target_preserved' : 'reset_required',
      sourceAlgorithm: 'SHA-256(salt + password)',
      sourceParametersDigest,
    })
  }

  const accountGroups = groupRows(accounts, (row) => sourceIdOf(row.user_id, 'account.user'))
  for (const user of targetUsers) {
    const candidates = accountGroups.get(user.sourceId) ?? []
    const normalizedAccounts = []
    for (const source of candidates) {
      const sourceAccountId = sourceIdOf(source.account_id, 'account')
      if (numberFlag(source.is_del) === 1) {
        skipped.address += 1
        continue
      }
      try {
        normalizedAccounts.push({
          source,
          sourceAccountId,
          ...normalizeManagedEmailAddress(source.email),
        })
      } catch (error) {
        failures.push(failure('address', sourceAccountId, 'invalid_address', error))
      }
    }
    if (!normalizedAccounts.some((item) => item.canonicalAddress === user.primaryAddress)) {
      normalizedAccounts.unshift({
        source: { email: user.primaryAddress, name: user.displayName, pinned: 1, sort: 0 },
        sourceAccountId: `user-primary:${user.sourceId}`,
        ...normalizeManagedEmailAddress(user.primaryAddress),
      })
    }
    const seenForUser = new Set()
    for (const item of normalizedAccounts) {
      if (seenForUser.has(item.canonicalAddress)) {
        failures.push(
          failure(
            'address',
            item.sourceAccountId,
            'duplicate_user_address',
            '同一旧用户存在重复邮箱地址',
          ),
        )
        continue
      }
      seenForUser.add(item.canonicalAddress)
      const role = item.canonicalAddress === user.primaryAddress ? 'primary' : 'alias'
      const existing = target.claims.get(item.canonicalAddress)
      const deterministicAddressId = stableId(
        'legacy-address',
        validation.manifest.sourceSnapshotSha256,
        item.sourceAccountId,
      )
      const existingMapping = target.sourceMappings.get(`address\n${item.sourceAccountId}`)
      const mayReuseAdmin =
        user.isExistingAdmin &&
        role === 'primary' &&
        item.canonicalAddress === target.adminPrimaryAddress
      const mayReuseMapped =
        existingMapping?.sourceSnapshotSha256 === validation.manifest.sourceSnapshotSha256 &&
        existingMapping.targetEntityType === 'email_address' &&
        existingMapping.targetEntityReference === deterministicAddressId &&
        String(existing?.address_id ?? '') === deterministicAddressId
      if (existing && !mayReuseAdmin && !mayReuseMapped) {
        failures.push(
          failure(
            'address',
            item.sourceAccountId,
            'target_address_conflict',
            '目标系统已占用该邮箱地址',
          ),
        )
        continue
      }
      if (addressByCanonical.has(item.canonicalAddress) && !mayReuseAdmin) {
        failures.push(
          failure(
            'address',
            item.sourceAccountId,
            'source_address_conflict',
            '旧数据中邮箱地址被多个主体使用',
          ),
        )
        continue
      }
      const domain = ensureDomain(domains, target, validation.manifest, item, execution.now)
      const addressId = mayReuseAdmin ? target.adminAddressId : deterministicAddressId
      const bindingId = mayReuseAdmin
        ? target.adminBindingId
        : stableId('legacy-binding', validation.manifest.sourceSnapshotSha256, item.sourceAccountId)
      const address = {
        sourceId: item.sourceAccountId,
        source: item.source,
        id: addressId,
        bindingId,
        userId: user.id,
        domainId: domain.id,
        canonicalAddress: item.canonicalAddress,
        role,
        reuseExisting: mayReuseAdmin || mayReuseMapped,
        createdAt: parseLegacyTime(item.source.create_time, user.createdAt),
        label: safeOptionalText(item.source.name, 120),
        pinned: numberFlag(item.source.pinned),
        sortOrder: safeInteger(item.source.sort, 0),
      }
      addresses.push(address)
      addressByCanonical.set(item.canonicalAddress, address)
      if (!item.sourceAccountId.startsWith('user-primary:')) {
        addressBySourceAccount.set(item.sourceAccountId, address)
      }
      if (role === 'primary') {
        user.primaryAddressId = addressId
        user.primaryBindingId = bindingId
      } else {
        user.aliasCount += 1
      }
      sourceMappings.push(
        mapping(
          execution.runId,
          validation.manifest,
          'address',
          item.sourceAccountId,
          item.source,
          'email_address',
          addressId,
          execution.now,
        ),
      )
    }
  }

  for (const domain of domains.values()) {
    sourceMappings.push(
      mapping(
        execution.runId,
        validation.manifest,
        'domain',
        domain.canonicalName,
        { canonicalName: domain.canonicalName },
        'mail_domain',
        domain.id,
        execution.now,
      ),
    )
  }

  const attachmentsByEmail = groupRows(attachments, (row) =>
    sourceIdOf(row.email_id, 'attachment.email'),
  )
  const starredByEmailAndUser = new Map(
    stars.map((row) => [
      `${sourceIdOf(row.email_id, 'star.email')}\n${sourceIdOf(row.user_id, 'star.user')}`,
      row,
    ]),
  )
  for (const source of emails) {
    const sourceMessageId = sourceIdOf(source.email_id, 'email')
    if (numberFlag(source.is_del) === 1) {
      skipped.message += 1
      skipped.body += 1
      skipped.attachment += (attachmentsByEmail.get(sourceMessageId) ?? []).length
      continue
    }
    const user = activeSourceUsers.get(sourceIdOf(source.user_id, 'email.user'))
    const address = addressBySourceAccount.get(sourceIdOf(source.account_id, 'email.account'))
    if (!user || !address) {
      failures.push(
        failure(
          'message',
          sourceMessageId,
          'message_owner_unavailable',
          '邮件所属用户或邮箱地址未能迁移',
        ),
      )
      continue
    }
    const bodyKey = normalizeLegacyObjectKey(source.body_key)
    const bodyEntry = validation.objectEntries.get(bodyKey)
    if (!bodyEntry) {
      failures.push(failure('body', sourceMessageId, 'body_object_missing', '邮件正文对象不存在'))
      continue
    }
    let body
    try {
      body = parseLegacyBody(bodyEntry.bytes)
    } catch (error) {
      failures.push(failure('body', sourceMessageId, 'body_object_invalid', error))
      continue
    }
    const sourceAttachments = attachmentsByEmail.get(sourceMessageId) ?? []
    const validAttachments = []
    let attachmentFailed = false
    for (const sourceAttachment of sourceAttachments) {
      const attachmentId = sourceIdOf(sourceAttachment.att_id, 'attachment')
      if (numberFlag(sourceAttachment.status) === 1) {
        skipped.attachment += 1
        continue
      }
      const key = normalizeLegacyObjectKey(sourceAttachment.key)
      const entry = validation.objectEntries.get(key)
      if (!entry) {
        failures.push(
          failure('attachment', attachmentId, 'attachment_object_missing', '附件对象不存在'),
        )
        attachmentFailed = true
        continue
      }
      const declaredSize = safeInteger(sourceAttachment.size, entry.bytes.byteLength)
      if (declaredSize > 0 && declaredSize !== entry.bytes.byteLength) {
        failures.push(
          failure(
            'attachment',
            attachmentId,
            'attachment_size_mismatch',
            '附件记录大小与对象不一致',
          ),
        )
        attachmentFailed = true
        continue
      }
      validAttachments.push({ source: sourceAttachment, sourceId: attachmentId, entry })
    }
    if (attachmentFailed) continue

    const messageId = stableId(
      'legacy-message',
      validation.manifest.sourceSnapshotSha256,
      sourceMessageId,
    )
    const occurredAt = parseLegacyTime(source.create_time, execution.now)
    const isSent = safeInteger(source.type, 0) === 1
    const headerAddresses = parseLegacyHeaderAddresses(source, address.canonicalAddress, isSent)
    const relationRows = parseLegacyRelations(source)
    const messageObjects = []
    const plainBytes = Buffer.from(body.text)
    messageObjects.push(
      migrationObject(validation.manifest, messageId, 'plain_body', 'body', 0, plainBytes, {
        mediaType: 'text/plain; charset=utf-8',
      }),
    )
    if (body.html) {
      const htmlBytes = Buffer.from(body.html)
      messageObjects.push(
        migrationObject(validation.manifest, messageId, 'html_body', 'body', 0, htmlBytes, {
          mediaType: 'text/html; charset=utf-8',
        }),
      )
    }
    for (const [index, attachment] of validAttachments.entries()) {
      const inline = safeInteger(attachment.source.type, 0) === 1
      const role = inline ? 'inline_resource' : 'attachment'
      const object = migrationObject(
        validation.manifest,
        messageId,
        role,
        `part-${index + 1}`,
        index,
        attachment.entry.bytes,
        {
          mediaType: safeMediaType(attachment.source.mime_type),
          fileName: safeAttachmentName(attachment.source.filename, index),
          contentDisposition: inline ? 'inline' : 'attachment',
          contentId: inline
            ? (safeOptionalText(attachment.source.content_id, 998) ?? `legacy-inline-${index + 1}`)
            : null,
          sourceFile: attachment.entry.path,
        },
      )
      messageObjects.push(object)
      sourceMappings.push(
        mapping(
          execution.runId,
          validation.manifest,
          'attachment',
          attachment.sourceId,
          attachment.source,
          'object_registry',
          object.id,
          execution.now,
        ),
      )
    }
    objects.push(...messageObjects)
    const starred = starredByEmailAndUser.get(`${sourceMessageId}\n${user.sourceId}`)
    const normalAttachmentCount = messageObjects.filter(
      (object) => object.role === 'attachment',
    ).length
    const totalBytes = messageObjects.reduce((sum, object) => sum + object.sizeBytes, 0)
    const mailboxEntryId = stableId(
      'legacy-mailbox-entry',
      validation.manifest.sourceSnapshotSha256,
      sourceMessageId,
    )
    const deliveryId = isSent
      ? null
      : stableId('legacy-delivery', validation.manifest.sourceSnapshotSha256, sourceMessageId)
    const message = {
      source,
      sourceId: sourceMessageId,
      id: messageId,
      userId: user.id,
      address,
      isSent,
      subject: safeOptionalText(source.subject, 998) ?? '',
      internetMessageId: safeMessageReference(source.message_id),
      occurredAt,
      totalBytes,
      normalAttachmentCount,
      headerAddresses,
      relations: relationRows,
      mailboxEntryId,
      deliveryId,
      isRead: numberFlag(source.unread) === 1 ? 1 : 0,
      isStarred: starred ? 1 : 0,
      objects: messageObjects,
    }
    messages.push(message)
    sourceMappings.push(
      mapping(
        execution.runId,
        validation.manifest,
        'message',
        sourceMessageId,
        source,
        'message',
        messageId,
        execution.now,
      ),
      mapping(
        execution.runId,
        validation.manifest,
        'body',
        sourceMessageId,
        { bodyKey, bodySha256: bodyEntry.sha256 },
        'message',
        messageId,
        execution.now,
      ),
    )
    if (starred) {
      sourceMappings.push(
        mapping(
          execution.runId,
          validation.manifest,
          'star',
          sourceIdOf(starred.star_id, 'star'),
          starred,
          'mailbox_user_state',
          `${mailboxEntryId}:${user.id}`,
          execution.now,
        ),
      )
    }
  }

  const activeMessageIds = new Set(messages.map((message) => message.sourceId))
  for (const source of stars) {
    const sourceStarId = sourceIdOf(source.star_id, 'star')
    const sourceMessageId = sourceIdOf(source.email_id, 'star.email')
    const sourceUserId = sourceIdOf(source.user_id, 'star.user')
    if (!activeMessageIds.has(sourceMessageId) || !activeSourceUsers.has(sourceUserId)) {
      skipped.star += 1
      continue
    }
    if (!starredByEmailAndUser.has(`${sourceMessageId}\n${sourceUserId}`)) skipped.star += 1
  }

  if (failures.length > 0) {
    throw new LegacyMigrationValidationError('旧数据存在不能安全迁移的项目', failures)
  }
  if (!targetUsers.some((user) => user.isExistingAdmin)) {
    throw new LegacyMigrationValidationError('目标管理员主地址没有对应的有效旧用户', [
      failure(
        'user',
        target.adminUserId,
        'administrator_primary_address_mismatch',
        '目标管理员主地址必须与一个有效旧用户主地址一致',
      ),
    ])
  }
  const conversations = deriveLegacyConversations(messages)
  const counts = {
    user: countResult(users.length, targetUsers.length, skipped.user),
    domain: countResult(domains.size, domains.size, 0),
    address: countResult(addresses.length + skipped.address, addresses.length, skipped.address),
    message: countResult(emails.length, messages.length, skipped.message),
    body: countResult(
      emails.length,
      messages.length,
      skipped.body + (emails.length - skipped.message - messages.length),
    ),
    attachment: countResult(
      attachments.length,
      sourceMappings.filter((item) => item.sourceEntityType === 'attachment').length,
      skipped.attachment,
    ),
    star: countResult(
      stars.length,
      sourceMappings.filter((item) => item.sourceEntityType === 'star').length,
      skipped.star,
    ),
  }
  normalizeCountRemainders(counts)
  return {
    users: targetUsers,
    domains: [...domains.values()],
    addresses,
    messages,
    objects,
    sourceMappings,
    passwordResults,
    conversations,
    counts,
  }
}

function buildMigrationSql(model, target, execution) {
  const statements = [
    '-- 由澄笺旧系统数据迁移工具生成；可使用确定性编号安全重放。',
    'PRAGMA foreign_keys = ON;',
  ]
  if (execution.runMode === 'formal') {
    if (!execution.rehearsal) throw new Error('正式迁移必须提供有效的演练证据')
    statements.push(...externalRehearsalEvidenceSql(execution.rehearsal, execution))
  }
  statements.push(...migrationRunStartSql(execution))

  for (const mappingRow of model.sourceMappings.filter((row) =>
    ['user', 'domain', 'address'].includes(row.sourceEntityType),
  )) {
    statements.push(mappingSql(mappingRow, execution))
  }

  for (const domain of model.domains) {
    if (!domain.reuseExisting) {
      statements.push(
        `INSERT OR IGNORE INTO mail_domains (id, canonical_name, display_name, status, catch_all_mode, paused_at, created_at, updated_at) VALUES (${sqlLiteral(domain.id)}, ${sqlLiteral(domain.canonicalName)}, ${sqlLiteral(domain.displayName)}, 'active', 'reject', NULL, ${domain.createdAt}, ${domain.createdAt});`,
      )
    }
  }
  for (const user of model.users) {
    if (user.isExistingAdmin) continue
    const placeholderSalt = sha256Bytes(`legacy-placeholder-salt\n${user.id}`).subarray(0, 16)
    const placeholderKey = sha256Bytes(`legacy-placeholder-key\n${user.id}`)
    statements.push(
      `INSERT OR IGNORE INTO users (id, status, display_name, timezone, invitation_policy, deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at) VALUES (${sqlLiteral(user.id)}, 'active', ${sqlLiteral(user.displayName)}, NULL, 'manual', NULL, NULL, NULL, ${user.createdAt}, ${user.createdAt});`,
      `INSERT OR IGNORE INTO password_credentials (user_id, format_version, algorithm, iterations, salt, derived_key, must_change, temporary_expires_at, updated_at) VALUES (${sqlLiteral(user.id)}, 1, 'PBKDF2-HMAC-SHA-256', 900000, X'${placeholderSalt.toString('hex')}', X'${placeholderKey.toString('hex')}', 1, NULL, ${execution.now});`,
      `INSERT OR IGNORE INTO user_alias_policies (user_id, alias_limit, self_creation_enabled, updated_by_user_id, created_at, updated_at) VALUES (${sqlLiteral(user.id)}, ${Math.max(20, user.aliasCount)}, 1, ${sqlLiteral(target.adminUserId)}, ${execution.now}, ${execution.now});`,
      `INSERT OR IGNORE INTO user_organization_policies (user_id, organization_limit, updated_by_user_id, created_at, updated_at) VALUES (${sqlLiteral(user.id)}, 5, ${sqlLiteral(target.adminUserId)}, ${execution.now}, ${execution.now});`,
    )
  }
  for (const user of model.users.filter((candidate) => candidate.isExistingAdmin)) {
    statements.push(
      `UPDATE user_alias_policies SET alias_limit = MAX(alias_limit, ${Math.max(20, user.aliasCount)}), updated_at = MAX(updated_at, ${execution.now}) WHERE user_id = ${sqlLiteral(user.id)};`,
    )
  }
  for (const address of model.addresses) {
    if (!address.reuseExisting) {
      statements.push(
        `INSERT OR IGNORE INTO email_addresses (id, domain_id, display_address, canonical_address, public_label, created_at, retired_at) VALUES (${sqlLiteral(address.id)}, ${sqlLiteral(address.domainId)}, ${sqlLiteral(address.canonicalAddress)}, ${sqlLiteral(address.canonicalAddress)}, ${sqlLiteral(address.label)}, ${address.createdAt}, NULL);`,
        `INSERT OR IGNORE INTO address_claims (canonical_address, address_id, status, reserved_until, created_at, updated_at) VALUES (${sqlLiteral(address.canonicalAddress)}, ${sqlLiteral(address.id)}, 'active', NULL, ${address.createdAt}, ${address.createdAt});`,
        `INSERT INTO address_bindings (id, address_id, owner_type, user_id, organization_id, address_role, started_at, ended_at, ended_reason) SELECT ${sqlLiteral(address.bindingId)}, ${sqlLiteral(address.id)}, 'user', ${sqlLiteral(address.userId)}, NULL, ${sqlLiteral(address.role)}, ${address.createdAt}, NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM address_bindings WHERE id = ${sqlLiteral(address.bindingId)});`,
      )
    }
    statements.push(
      `INSERT OR IGNORE INTO user_address_preferences (user_id, address_id, custom_label, is_pinned, sort_order, is_default_sender, sender_display_name, signature_format, signature_content, created_at, updated_at) VALUES (${sqlLiteral(address.userId)}, ${sqlLiteral(address.id)}, ${sqlLiteral(address.label)}, ${address.pinned}, ${address.sortOrder}, ${address.role === 'primary' ? 1 : 0}, ${sqlLiteral(address.label)}, NULL, NULL, ${address.createdAt}, ${execution.now});`,
    )
  }
  for (const user of model.users) {
    if (!user.isExistingAdmin && user.status === 'disabled') {
      statements.push(
        `UPDATE users SET status = 'disabled', updated_at = ${execution.now} WHERE id = ${sqlLiteral(user.id)} AND status = 'active';`,
      )
    }
  }
  for (const result of model.passwordResults) {
    statements.push(
      `INSERT OR IGNORE INTO migration_user_password_results (migration_run_id, user_id, source_user_id, password_result, source_algorithm, source_parameters_digest, recorded_at) VALUES (${sqlLiteral(execution.runId)}, ${sqlLiteral(result.userId)}, ${sqlLiteral(result.sourceUserId)}, ${sqlLiteral(result.result)}, ${sqlLiteral(result.sourceAlgorithm)}, X'${result.sourceParametersDigest}', ${execution.now});`,
    )
  }

  for (const message of model.messages) statements.push(...messageSql(message, target, execution))
  statements.push(
    `UPDATE message_relations SET target_message_id = (SELECT candidate.id FROM messages AS candidate WHERE candidate.internet_message_id = message_relations.target_reference LIMIT 1) WHERE target_message_id IS NULL AND 1 = (SELECT COUNT(*) FROM messages AS candidate WHERE candidate.internet_message_id = message_relations.target_reference);`,
  )
  for (const conversation of model.conversations) {
    statements.push(
      `INSERT OR IGNORE INTO mailbox_conversations (id, mailbox_type, user_id, organization_id, root_reference, latest_at, rebuilt_at) VALUES (${sqlLiteral(conversation.id)}, 'user', ${sqlLiteral(conversation.userId)}, NULL, ${sqlLiteral(conversation.rootReference)}, ${conversation.latestAt}, ${execution.now});`,
      ...conversation.entries.map(
        (entry) =>
          `INSERT OR IGNORE INTO mailbox_conversation_entries (mailbox_entry_id, conversation_id, sort_at, linked_at) VALUES (${sqlLiteral(entry.mailboxEntryId)}, ${sqlLiteral(conversation.id)}, ${entry.occurredAt}, ${execution.now});`,
      ),
    )
  }
  for (const mappingRow of model.sourceMappings.filter(
    (row) => !['user', 'domain', 'address'].includes(row.sourceEntityType),
  )) {
    statements.push(mappingSql(mappingRow, execution))
  }
  for (const type of ENTITY_TYPES) {
    const count = model.counts[type]
    statements.push(
      `UPDATE migration_checkpoints SET cursor_value = ${sqlLiteral(String(count.scanned))}, scanned_count = ${count.scanned}, succeeded_count = ${count.succeeded}, skipped_count = ${count.skipped}, failed_count = 0, checkpoint_status = 'completed', last_error_code = NULL, updated_at = ${execution.now} WHERE migration_run_id = ${sqlLiteral(execution.runId)} AND entity_type = ${sqlLiteral(type)};`,
      `INSERT OR REPLACE INTO migration_reconciliations (id, migration_run_id, entity_type, expected_count, scanned_count, succeeded_count, skipped_count, failed_count, reconciliation_status, created_at, updated_at) VALUES (${sqlLiteral(stableId('migration-reconciliation', execution.runId, type))}, ${sqlLiteral(execution.runId)}, ${sqlLiteral(type)}, ${count.scanned}, ${count.scanned}, ${count.succeeded}, ${count.skipped}, 0, 'matched', ${execution.now}, ${execution.now});`,
    )
  }
  statements.push(
    `INSERT OR IGNORE INTO audit_events (id, occurred_at, actor_type, actor_user_id, action_name, target_type, target_reference, outcome, reason_code, request_trace_id, source_ip_text, browser_family, created_at) VALUES (${sqlLiteral(stableId('migration-audit', execution.runId))}, ${execution.now}, 'system', NULL, 'legacy_migration.completed', 'migration_run', ${sqlLiteral(execution.runId)}, 'succeeded', ${sqlLiteral(execution.runMode)}, ${sqlLiteral(`legacy-migration:${execution.runId}`)}, NULL, NULL, ${execution.now});`,
    `UPDATE migration_runs SET run_status = 'succeeded', last_error_code = NULL, completed_at = ${execution.now}, updated_at = ${execution.now} WHERE id = ${sqlLiteral(execution.runId)} AND run_status = 'running';`,
    '',
  )
  return statements.join('\n')
}

function messageSql(message, target, execution) {
  const statements = [
    `INSERT OR IGNORE INTO messages (id, origin_type, authored_by_user_id, internet_message_id, subject, header_date_text, header_date_at, accepted_at, sort_at, raw_size_bytes, attachment_count, has_attachments, created_at, updated_at) VALUES (${sqlLiteral(message.id)}, 'migrated', ${message.isSent ? sqlLiteral(message.userId) : 'NULL'}, ${sqlLiteral(message.internetMessageId)}, ${sqlLiteral(message.subject)}, ${sqlLiteral(String(message.source.create_time ?? ''))}, ${message.occurredAt}, ${message.occurredAt}, ${message.occurredAt}, ${message.totalBytes}, ${message.normalAttachmentCount}, ${message.normalAttachmentCount > 0 ? 1 : 0}, ${message.occurredAt}, ${execution.now});`,
  ]
  for (const object of message.objects) {
    statements.push(
      `INSERT OR IGNORE INTO object_registry (id, storage_mode, object_key, owner_kind, owner_reference, message_id, object_role, logical_part_key, sequence_number, generation, required_for_visibility, is_current, expected_size_bytes, expected_sha256, actual_size_bytes, actual_sha256, media_type, untrusted_file_name, content_disposition, content_id, producer_version, backend_version_reference, object_status, stored_at, verified_at, consistency_checked_at, activated_at, superseded_at, delete_after, deleted_at, created_at, updated_at) VALUES (${sqlLiteral(object.id)}, ${sqlLiteral(target.storageMode)}, ${sqlLiteral(object.objectKey)}, 'message', ${sqlLiteral(message.id)}, ${sqlLiteral(message.id)}, ${sqlLiteral(object.role)}, ${sqlLiteral(object.logicalPartKey)}, ${object.sequenceNumber}, 1, 1, 1, ${object.sizeBytes}, X'${object.sha256}', ${object.sizeBytes}, X'${object.sha256}', ${sqlLiteral(object.mediaType)}, ${sqlLiteral(object.fileName)}, ${sqlLiteral(object.contentDisposition)}, ${sqlLiteral(object.contentId)}, ${sqlLiteral(RECONSTRUCTION_VERSION)}, ${sqlLiteral(`migration:${execution.runId}`)}, 'active', ${execution.now}, ${execution.now}, ${target.storageMode === 'kv' ? execution.now : 'NULL'}, ${execution.now}, NULL, NULL, NULL, ${execution.now}, ${execution.now});`,
    )
  }
  statements.push(
    `INSERT OR IGNORE INTO message_integrity_states (message_id, source_completeness, integrity_status, object_set_version, ready_at, hidden_since, damage_code, damage_summary, created_at, updated_at) VALUES (${sqlLiteral(message.id)}, 'structured_only', 'ready', 1, ${execution.now}, NULL, NULL, NULL, ${execution.now}, ${execution.now});`,
  )
  for (const header of message.headerAddresses) {
    statements.push(
      `INSERT OR IGNORE INTO message_header_addresses (id, message_id, address_role, sequence_number, display_name, address_text, canonical_address, visibility_scope, created_at) VALUES (${sqlLiteral(stableId('legacy-header', message.id, header.role, String(header.sequenceNumber)))}, ${sqlLiteral(message.id)}, ${sqlLiteral(header.role)}, ${header.sequenceNumber}, ${sqlLiteral(header.displayName)}, ${sqlLiteral(header.addressText)}, ${sqlLiteral(header.canonicalAddress)}, ${header.role === 'bcc' ? "'sender_only'" : "'header'"}, ${execution.now});`,
    )
  }
  for (const relation of message.relations) {
    statements.push(
      `INSERT OR IGNORE INTO message_relations (id, child_message_id, relation_type, sequence_number, target_reference, target_message_id, created_at) VALUES (${sqlLiteral(stableId('legacy-relation', message.id, relation.type, String(relation.sequenceNumber)))}, ${sqlLiteral(message.id)}, ${sqlLiteral(relation.type)}, ${relation.sequenceNumber}, ${sqlLiteral(relation.reference)}, NULL, ${execution.now});`,
    )
  }
  if (message.deliveryId) {
    statements.push(
      `INSERT OR IGNORE INTO message_deliveries (id, message_id, address_binding_id, canonical_recipient_address, display_recipient_address, delivery_source, delivered_at, created_at) VALUES (${sqlLiteral(message.deliveryId)}, ${sqlLiteral(message.id)}, ${sqlLiteral(message.address.bindingId)}, ${sqlLiteral(message.address.canonicalAddress)}, ${sqlLiteral(message.address.canonicalAddress)}, 'migration', ${message.occurredAt}, ${execution.now});`,
    )
  }
  statements.push(
    `INSERT OR IGNORE INTO mailbox_entries (id, message_id, mailbox_type, user_id, organization_id, entry_kind, base_location, occurred_at, created_at) VALUES (${sqlLiteral(message.mailboxEntryId)}, ${sqlLiteral(message.id)}, 'user', ${sqlLiteral(message.userId)}, NULL, ${message.isSent ? "'sent'" : "'received'"}, ${message.isSent ? "'sent'" : "'inbox'"}, ${message.occurredAt}, ${execution.now});`,
  )
  if (message.deliveryId) {
    statements.push(
      `INSERT OR IGNORE INTO mailbox_entry_deliveries (mailbox_entry_id, delivery_id, created_at) VALUES (${sqlLiteral(message.mailboxEntryId)}, ${sqlLiteral(message.deliveryId)}, ${execution.now});`,
    )
  }
  statements.push(
    `INSERT OR IGNORE INTO mailbox_user_states (mailbox_entry_id, user_id, is_read, is_starred, is_archived, location_override, previous_location, remote_images_allowed, trashed_at, trash_due_at, hidden_at, updated_at) VALUES (${sqlLiteral(message.mailboxEntryId)}, ${sqlLiteral(message.userId)}, ${message.isRead}, ${message.isStarred}, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${execution.now});`,
    `INSERT OR IGNORE INTO migrated_message_sources (message_id, migration_run_id, source_message_id, source_quality, original_mime_sha256, reconstruction_version, created_at) VALUES (${sqlLiteral(message.id)}, ${sqlLiteral(execution.runId)}, ${sqlLiteral(message.sourceId)}, 'structured_rebuilt', NULL, ${sqlLiteral(RECONSTRUCTION_VERSION)}, ${execution.now});`,
    ...messageSearchSql(message, execution.now),
  )
  if (message.totalBytes > 0) {
    const usageId = stableId('legacy-storage-usage', message.id)
    const digest = sha256Hex(Buffer.from(`migration-storage\n${message.id}\n${message.totalBytes}`))
    statements.push(
      `INSERT OR IGNORE INTO logical_storage_usage_entries (id, storage_usage_account_id, storage_reservation_id, entry_kind, owner_reference, bytes_delta, idempotency_key_digest, committed_at, created_at) SELECT ${sqlLiteral(usageId)}, account.id, NULL, 'migration', ${sqlLiteral(`message:${message.id}`)}, ${message.totalBytes}, X'${digest}', ${execution.now}, ${execution.now} FROM logical_storage_usage_accounts AS account WHERE account.owner_type = 'user' AND account.user_id = ${sqlLiteral(message.userId)} AND account.storage_mode = ${sqlLiteral(target.storageMode)} LIMIT 1;`,
    )
  }
  return statements
}

function migrationRunStartSql(execution) {
  const rehearsalId = execution.runMode === 'formal' ? execution.rehearsal.runId : null
  const reportSha = execution.runMode === 'formal' ? execution.rehearsal.reportSha256 : null
  const values = [
    `INSERT OR IGNORE INTO migration_runs (id, run_mode, source_system, source_version, source_reference_commit, source_snapshot_sha256, snapshot_format_version, migration_rules_version, target_version, rehearsal_run_id, rehearsal_report_sha256, run_status, last_error_code, started_at, completed_at, created_at, updated_at) VALUES (${sqlLiteral(execution.runId)}, ${sqlLiteral(execution.runMode)}, ${sqlLiteral(SOURCE_SYSTEM)}, ${sqlLiteral(execution.manifest.sourceVersion)}, ${sqlLiteral(execution.manifest.sourceReferenceCommit)}, X'${execution.manifest.sourceSnapshotSha256}', ${execution.manifest.snapshotFormatVersion}, ${execution.manifest.migrationRulesVersion}, ${sqlLiteral(TARGET_MIGRATION_VERSION)}, ${sqlLiteral(rehearsalId)}, ${reportSha ? `X'${reportSha}'` : 'NULL'}, 'planned', NULL, NULL, NULL, ${execution.now}, ${execution.now});`,
    `UPDATE migration_runs SET run_status = 'running', started_at = COALESCE(started_at, ${execution.now}), completed_at = NULL, last_error_code = NULL, updated_at = ${execution.now} WHERE id = ${sqlLiteral(execution.runId)} AND run_status IN ('planned', 'failed', 'paused');`,
  ]
  for (const type of ENTITY_TYPES) {
    values.push(
      `INSERT OR IGNORE INTO migration_checkpoints (id, migration_run_id, entity_type, cursor_value, scanned_count, succeeded_count, skipped_count, failed_count, checkpoint_status, last_error_code, created_at, updated_at) VALUES (${sqlLiteral(stableId('migration-checkpoint', execution.runId, type))}, ${sqlLiteral(execution.runId)}, ${sqlLiteral(type)}, NULL, 0, 0, 0, 0, 'pending', NULL, ${execution.now}, ${execution.now});`,
    )
  }
  return values
}

function externalRehearsalEvidenceSql(rehearsal, execution) {
  return [
    `INSERT OR IGNORE INTO migration_runs (id, run_mode, source_system, source_version, source_reference_commit, source_snapshot_sha256, snapshot_format_version, migration_rules_version, target_version, rehearsal_run_id, rehearsal_report_sha256, run_status, last_error_code, started_at, completed_at, created_at, updated_at) VALUES (${sqlLiteral(rehearsal.runId)}, 'rehearsal', ${sqlLiteral(SOURCE_SYSTEM)}, ${sqlLiteral(execution.manifest.sourceVersion)}, ${sqlLiteral(execution.manifest.sourceReferenceCommit)}, X'${execution.manifest.sourceSnapshotSha256}', ${execution.manifest.snapshotFormatVersion}, ${execution.manifest.migrationRulesVersion}, ${sqlLiteral(TARGET_MIGRATION_VERSION)}, NULL, NULL, 'planned', NULL, NULL, NULL, ${execution.now}, ${execution.now});`,
    `UPDATE migration_runs SET run_status = 'running', started_at = COALESCE(started_at, ${execution.now}), updated_at = ${execution.now} WHERE id = ${sqlLiteral(rehearsal.runId)} AND run_status = 'planned';`,
    ...ENTITY_TYPES.map((type) => {
      const count = rehearsal.counts[type]
      return `INSERT OR IGNORE INTO migration_reconciliations (id, migration_run_id, entity_type, expected_count, scanned_count, succeeded_count, skipped_count, failed_count, reconciliation_status, created_at, updated_at) VALUES (${sqlLiteral(stableId('external-rehearsal-reconciliation', rehearsal.runId, type))}, ${sqlLiteral(rehearsal.runId)}, ${sqlLiteral(type)}, ${count.scanned}, ${count.scanned}, ${count.succeeded}, ${count.skipped}, 0, 'matched', ${execution.now}, ${execution.now});`
    }),
    `UPDATE migration_runs SET run_status = 'succeeded', completed_at = ${execution.now}, updated_at = ${execution.now} WHERE id = ${sqlLiteral(rehearsal.runId)} AND run_status = 'running';`,
  ]
}

function mappingSql(row, execution) {
  return `INSERT OR IGNORE INTO migration_source_mappings (id, source_system, source_snapshot_sha256, source_entity_type, source_entity_id, source_content_sha256, target_entity_type, target_entity_reference, created_by_migration_run_id, created_at) VALUES (${sqlLiteral(row.id)}, ${sqlLiteral(SOURCE_SYSTEM)}, X'${execution.manifest.sourceSnapshotSha256}', ${sqlLiteral(row.sourceEntityType)}, ${sqlLiteral(row.sourceEntityId)}, X'${row.sourceContentSha256}', ${sqlLiteral(row.targetEntityType)}, ${sqlLiteral(row.targetEntityReference)}, ${sqlLiteral(execution.runId)}, ${execution.now});`
}

function messageSearchSql(message, now) {
  const plainBody = message.objects.find((object) => object.role === 'plain_body')
  if (!plainBody) throw new Error(`迁移邮件 ${message.sourceId} 缺少纯文本正文`)
  const body = plainBody.bytes.toString('utf8')
  const chunks = textChunks(body)
  const scope = `usr${sha256Hex(Buffer.from(`user:${message.userId}`))}`
  const statements = [
    `INSERT OR IGNORE INTO message_search_states (message_id, object_set_version, index_generation, index_status, chunk_count, last_error_code, indexed_at, created_at, updated_at) VALUES (${sqlLiteral(message.id)}, 1, 1, 'indexing', 0, NULL, NULL, ${now}, ${now});`,
  ]
  chunks.forEach((chunk, index) => {
    statements.push(
      `INSERT INTO message_search_chunks (message_id, index_generation, chunk_index, created_at) SELECT ${sqlLiteral(message.id)}, 1, ${index}, ${now} WHERE NOT EXISTS (SELECT 1 FROM message_search_chunks WHERE message_id = ${sqlLiteral(message.id)} AND index_generation = 1 AND chunk_index = ${index});`,
      `INSERT INTO message_search_index (rowid, body_tokens, scopes) SELECT id, ${sqlLiteral(tokenizeSearchText(chunk))}, ${sqlLiteral(scope)} FROM message_search_chunks AS chunk WHERE chunk.message_id = ${sqlLiteral(message.id)} AND chunk.index_generation = 1 AND chunk.chunk_index = ${index} AND NOT EXISTS (SELECT 1 FROM message_search_index WHERE rowid = chunk.id);`,
    )
  })
  statements.push(
    `UPDATE message_search_states SET index_status = 'ready', chunk_count = ${chunks.length}, last_error_code = NULL, indexed_at = ${now}, updated_at = ${now} WHERE message_id = ${sqlLiteral(message.id)} AND index_generation = 1 AND index_status = 'indexing';`,
  )
  return statements
}

function deriveLegacyConversations(messages) {
  const byInternetId = new Map()
  for (const message of messages) {
    if (!message.internetMessageId) continue
    const values = byInternetId.get(message.internetMessageId) ?? []
    values.push(message)
    byInternetId.set(message.internetMessageId, values)
  }
  const parent = new Map(messages.map((message) => [message.id, message.id]))
  const find = (id) => {
    let current = parent.get(id)
    while (current && current !== parent.get(current)) current = parent.get(current)
    if (!current) return id
    let node = id
    while (parent.get(node) !== current) {
      const next = parent.get(node)
      parent.set(node, current)
      node = next
    }
    return current
  }
  const unite = (left, right) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot)
  }
  for (const message of messages) {
    for (const relation of message.relations) {
      const candidates = byInternetId.get(relation.reference) ?? []
      if (candidates.length === 1) unite(message.id, candidates[0].id)
    }
  }
  const components = groupRows(messages, (message) => find(message.id))
  const conversations = []
  for (const component of components.values()) {
    const relationReferences = component.flatMap((message) =>
      message.relations.map((relation) => relation.reference),
    )
    const componentInternetIds = new Set(
      component.map((message) => message.internetMessageId).filter(Boolean),
    )
    const missing = [...new Set(relationReferences)]
      .filter(
        (reference) => !componentInternetIds.has(reference) && !byInternetId.get(reference)?.length,
      )
      .sort()
    const earliest = [...component].sort(
      (left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id),
    )[0]
    const rootReference =
      missing[0] ??
      (earliest.internetMessageId && byInternetId.get(earliest.internetMessageId)?.length === 1
        ? earliest.internetMessageId
        : `message:${earliest.id}`)
    const byUser = groupRows(component, (message) => message.userId)
    for (const [userId, userMessages] of byUser) {
      conversations.push({
        id: `conversation-${sha256Hex(Buffer.from(`user\n${userId}\n${rootReference}`))}`,
        userId,
        rootReference,
        latestAt: Math.max(...userMessages.map((message) => message.occurredAt)),
        entries: userMessages.map((message) => ({
          mailboxEntryId: message.mailboxEntryId,
          occurredAt: message.occurredAt,
        })),
      })
    }
  }
  return conversations
}

function migrationObject(
  manifest,
  messageId,
  role,
  logicalPartKey,
  sequenceNumber,
  bytes,
  metadata,
) {
  const value = Buffer.from(bytes)
  const sha256 = sha256Hex(value)
  const id = stableId(
    'legacy-object',
    manifest.sourceSnapshotSha256,
    messageId,
    role,
    logicalPartKey,
  )
  return {
    id,
    messageId,
    role,
    logicalPartKey,
    sequenceNumber,
    bytes: value,
    sizeBytes: value.byteLength,
    sha256,
    objectKey: `migration/${manifest.sourceSnapshotSha256}/${messageId}/${role}/${sequenceNumber}-${sha256}`,
    mediaType: metadata.mediaType,
    fileName: metadata.fileName ?? null,
    contentDisposition: metadata.contentDisposition ?? null,
    contentId: metadata.contentId ?? null,
    sourceFile: metadata.sourceFile ?? null,
  }
}

function ensureDomain(domains, target, manifest, normalized, now) {
  const existing = domains.get(normalized.canonicalDomain)
  if (existing) return existing
  const targetExisting = target.domains.get(normalized.canonicalDomain)
  const domain = {
    id:
      targetExisting?.id ??
      stableId('legacy-domain', manifest.sourceSnapshotSha256, normalized.canonicalDomain),
    canonicalName: normalized.canonicalDomain,
    displayName: targetExisting?.displayName ?? normalized.displayDomain,
    reuseExisting: Boolean(targetExisting),
    createdAt: now,
  }
  domains.set(normalized.canonicalDomain, domain)
  return domain
}

function parseLegacyBody(bytes) {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('正文对象不是 JSON 对象')
  }
  const html =
    typeof parsed.html === 'string'
      ? parsed.html
      : typeof parsed.content === 'string'
        ? parsed.content
        : ''
  const text = typeof parsed.text === 'string' ? parsed.text : htmlToPlainText(html)
  return { html, text }
}

function parseLegacyHeaderAddresses(source, fallbackAddress, isSent) {
  const result = []
  const push = (role, value, sequenceNumber, fallbackName = null) => {
    const item = normalizeLegacyHeaderAddress(value, fallbackName)
    if (!item) return
    result.push({ role, sequenceNumber, ...item })
  }
  push('from', source.send_email || (isSent ? fallbackAddress : '未知发件人'), 0, source.name)
  const recipients = parseLegacyAddressList(source.recipient)
  if (recipients.length === 0 && source.to_email) {
    push('to', source.to_email, 0, source.to_name)
  } else {
    recipients.forEach((value, index) => push('to', value.address, index, value.name))
  }
  parseLegacyAddressList(source.cc).forEach((value, index) =>
    push('cc', value.address, index, value.name),
  )
  parseLegacyAddressList(source.bcc).forEach((value, index) =>
    push('bcc', value.address, index, value.name),
  )
  return result
}

function parseLegacyAddressList(value) {
  if (!value) return []
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      parsed = value.split(',')
    }
  }
  if (!Array.isArray(parsed)) parsed = [parsed]
  return parsed
    .map((item) =>
      typeof item === 'string'
        ? { address: item, name: null }
        : { address: item?.address ?? item?.email ?? '', name: item?.name ?? null },
    )
    .filter((item) => String(item.address).trim().length > 0)
}

function normalizeLegacyHeaderAddress(value, displayName) {
  const addressText = String(value ?? '')
    .trim()
    .slice(0, 998)
  if (!addressText) return null
  let canonicalAddress = null
  const candidate = addressText
    .replace(/^.*<([^<>]+)>.*$/u, '$1')
    .trim()
    .toLowerCase()
  if (candidate.includes('@') && candidate.length <= 320) canonicalAddress = candidate
  return {
    addressText,
    canonicalAddress,
    displayName: safeOptionalText(displayName, 320),
  }
}

function parseLegacyRelations(source) {
  const result = []
  const seen = new Set()
  const add = (type, reference) => {
    const value = safeMessageReference(reference)
    if (!value || seen.has(`${type}\n${value}`)) return
    seen.add(`${type}\n${value}`)
    result.push({
      type,
      sequenceNumber: result.filter((item) => item.type === type).length,
      reference: value,
    })
  }
  add('in_reply_to', source.in_reply_to)
  const relationText = String(source.relation ?? '')
  const matches = [...relationText.matchAll(MESSAGE_REFERENCE_PATTERN)].map((match) => match[0])
  if (matches.length > 0) matches.slice(0, 100).forEach((value) => add('reference', value))
  else
    relationText
      .split(/[\s,]+/u)
      .slice(0, 100)
      .forEach((value) => add('reference', value))
  return result
}

function mapping(
  runId,
  manifest,
  sourceEntityType,
  sourceEntityId,
  source,
  targetEntityType,
  targetReference,
  now,
) {
  const sourceContentSha256 = sha256Hex(Buffer.from(stableStringify(source)))
  return {
    id: stableId('legacy-mapping', manifest.sourceSnapshotSha256, sourceEntityType, sourceEntityId),
    runId,
    sourceEntityType,
    sourceEntityId,
    sourceContentSha256,
    targetEntityType,
    targetEntityReference: targetReference,
    now,
  }
}

function assertLogicalStorageCapacity(model, target) {
  const bytesByUser = new Map()
  for (const message of model.messages) {
    bytesByUser.set(message.userId, (bytesByUser.get(message.userId) ?? 0) + message.totalBytes)
  }
  for (const [userId, bytes] of bytesByUser) {
    const usage = target.logicalStorage.get(userId) ?? {
      committedBytes: 0,
      limitBytes: target.defaultLogicalLimitBytes,
    }
    if (usage.committedBytes + bytes > usage.limitBytes) {
      throw new Error(`用户 ${userId} 的迁移邮件会超过逻辑存储配额`)
    }
  }
}

function assertPlatformObjectCapacity(model, target) {
  const plannedBytes = model.objects.reduce((sum, object) => sum + object.sizeBytes, 0)
  if (target.storageUsedBytes + plannedBytes > target.storageStopBytes) {
    throw new Error('迁移对象会超过当前 Cloudflare 免费资源保守停止线')
  }
}

function assertD1Capacity(sql, target) {
  const plannedBytes = Buffer.byteLength(sql, 'utf8')
  if (target.d1UsedBytes + plannedBytes > target.d1StopBytes) {
    throw new Error('迁移 D1 数据会超过当前 Cloudflare 免费资源保守停止线')
  }
}

function assertExistingSourceMappings(model, target, manifest) {
  for (const row of model.sourceMappings) {
    const key = `${row.sourceEntityType}\n${row.sourceEntityId}`
    const existing = target.sourceMappings.get(key)
    if (!existing) continue
    if (
      existing.sourceSnapshotSha256 !== manifest.sourceSnapshotSha256 ||
      existing.sourceContentSha256 !== row.sourceContentSha256 ||
      existing.targetEntityType !== row.targetEntityType ||
      existing.targetEntityReference !== row.targetEntityReference
    ) {
      throw new LegacyMigrationValidationError('目标系统存在冲突的旧系统来源映射', [
        failure(
          row.sourceEntityType,
          row.sourceEntityId,
          'source_mapping_conflict',
          '同一旧编号的内容摘要或目标编号与当前迁移计划不一致',
        ),
      ])
    }
  }
}

function assertExistingMigrationRuns(target, manifest) {
  for (const run of target.migrationRuns) {
    if (
      run.sourceSnapshotSha256 === manifest.sourceSnapshotSha256 &&
      (run.migrationRulesVersion !== MIGRATION_RULES_VERSION ||
        run.targetVersion !== TARGET_MIGRATION_VERSION)
    ) {
      throw new Error('目标系统已有同一快照但不同迁移规则或目标版本的运行记录')
    }
  }
}

async function loadTargetFacts(options) {
  const systemRows = await queryTarget(
    options,
    `SELECT system.storage_mode, system.current_admin_user_id,
            address.id AS admin_address_id, binding.id AS admin_binding_id,
            address.canonical_address AS admin_primary_address
     FROM system_instances AS system
     JOIN address_bindings AS binding
       ON binding.user_id = system.current_admin_user_id
      AND binding.address_role = 'primary' AND binding.ended_at IS NULL
     JOIN email_addresses AS address ON address.id = binding.address_id
     WHERE system.singleton_id = 1 LIMIT 1;`,
  )
  const system = systemRows[0]
  if (!system) throw new Error('目标系统尚未完成初始化，或唯一管理员缺少当前主邮箱')
  const storageMode = String(system.storage_mode)
  if (!['kv', 'r2'].includes(storageMode)) throw new Error('目标系统存储模式无效')

  const domainRows = await queryTarget(
    options,
    'SELECT id, canonical_name, display_name FROM mail_domains ORDER BY canonical_name;',
  )
  const claimRows = await queryTarget(
    options,
    'SELECT canonical_address, address_id, status FROM address_claims ORDER BY canonical_address;',
  )
  const logicalRows = await queryTarget(
    options,
    `SELECT account.user_id, account.committed_bytes,
            COALESCE(override.limit_bytes, defaults.limit_bytes) AS limit_bytes
     FROM logical_storage_usage_accounts AS account
     JOIN logical_storage_quota_policies AS defaults
       ON defaults.storage_mode = account.storage_mode
      AND defaults.owner_type = 'system_default'
      AND defaults.default_owner_type = 'user'
      AND defaults.policy_status = 'active'
     LEFT JOIN logical_storage_quota_policies AS override
       ON override.storage_mode = account.storage_mode
      AND override.owner_type = 'user'
      AND override.user_id = account.user_id
      AND override.policy_status = 'active'
     WHERE account.storage_mode = ${sqlLiteral(storageMode)} AND account.owner_type = 'user';`,
  )
  const defaultRows = await queryTarget(
    options,
    `SELECT limit_bytes FROM logical_storage_quota_policies
     WHERE storage_mode = ${sqlLiteral(storageMode)}
       AND owner_type = 'system_default' AND default_owner_type = 'user'
       AND policy_status = 'active' LIMIT 1;`,
  )
  const resourceRows = await queryTarget(
    options,
    `SELECT snapshot.resource_kind, snapshot.simlettra_used_bytes,
            snapshot.current_resource_limit_bytes, threshold.stop_ratio_bps
     FROM platform_resource_snapshots AS snapshot
     JOIN platform_resource_thresholds AS threshold
       ON threshold.resource_kind = snapshot.resource_kind
      AND threshold.threshold_status = 'active'
     WHERE snapshot.id = (
       SELECT latest.id FROM platform_resource_snapshots AS latest
       WHERE latest.resource_kind = snapshot.resource_kind
         AND latest.fetch_status IN ('success', 'stale')
       ORDER BY latest.fetched_at DESC, latest.id DESC LIMIT 1
     ) AND snapshot.resource_kind IN ('d1', ${sqlLiteral(storageMode)});`,
  )
  const mappingRows = await queryTarget(
    options,
    `SELECT source_snapshot_sha256, source_entity_type, source_entity_id,
            source_content_sha256, target_entity_type, target_entity_reference
     FROM migration_source_mappings WHERE source_system = ${sqlLiteral(SOURCE_SYSTEM)};`,
  )
  const migrationRows = await queryTarget(
    options,
    `SELECT source_snapshot_sha256, migration_rules_version, target_version
     FROM migration_runs WHERE source_system = ${sqlLiteral(SOURCE_SYSTEM)};`,
  )
  const localD1Bytes = options.targetRemote ? 0 : await localD1SizeBytes(options)
  const localObjectBytes = options.targetRemote
    ? 0
    : await localObjectRegistryBytes(options, storageMode)
  const snapshots = new Map(resourceRows.map((row) => [String(row.resource_kind), row]))
  const storageSnapshot = snapshots.get(storageMode)
  const d1Snapshot = snapshots.get('d1')
  const storageLimit = storageMode === 'kv' ? KV_FREE_LIMIT_BYTES : R2_FREE_LIMIT_BYTES
  return {
    storageMode,
    adminUserId: String(system.current_admin_user_id),
    adminAddressId: String(system.admin_address_id),
    adminBindingId: String(system.admin_binding_id),
    adminPrimaryAddress: normalizeManagedEmailAddress(system.admin_primary_address)
      .canonicalAddress,
    domains: new Map(
      domainRows.map((row) => [
        String(row.canonical_name),
        { id: String(row.id), displayName: String(row.display_name) },
      ]),
    ),
    claims: new Map(claimRows.map((row) => [String(row.canonical_address), row])),
    logicalStorage: new Map(
      logicalRows.map((row) => [
        String(row.user_id),
        { committedBytes: Number(row.committed_bytes), limitBytes: Number(row.limit_bytes) },
      ]),
    ),
    defaultLogicalLimitBytes: Number(
      defaultRows[0]?.limit_bytes ?? (storageMode === 'kv' ? 100_000_000 : 1_000_000_000),
    ),
    storageUsedBytes: Number(storageSnapshot?.simlettra_used_bytes ?? localObjectBytes),
    storageStopBytes: stopBytes(
      Number(storageSnapshot?.current_resource_limit_bytes ?? storageLimit),
      Number(storageSnapshot?.stop_ratio_bps ?? 9500),
    ),
    d1UsedBytes: Number(d1Snapshot?.simlettra_used_bytes ?? localD1Bytes),
    d1StopBytes: stopBytes(
      Number(d1Snapshot?.current_resource_limit_bytes ?? D1_DATABASE_FREE_LIMIT_BYTES),
      Number(d1Snapshot?.stop_ratio_bps ?? 9500),
    ),
    sourceMappings: new Map(
      mappingRows.map((row) => [
        `${row.source_entity_type}\n${row.source_entity_id}`,
        {
          sourceSnapshotSha256: normalizeBinaryHex(row.source_snapshot_sha256),
          sourceContentSha256: normalizeBinaryHex(row.source_content_sha256),
          targetEntityType: String(row.target_entity_type),
          targetEntityReference: String(row.target_entity_reference),
        },
      ]),
    ),
    migrationRuns: migrationRows.map((row) => ({
      sourceSnapshotSha256: normalizeBinaryHex(row.source_snapshot_sha256),
      migrationRulesVersion: Number(row.migration_rules_version),
      targetVersion: String(row.target_version),
    })),
  }
}

async function queryTarget(options, command) {
  const results = await runD1Json(d1CommandArguments(options, 'target', command))
  return results.flatMap((item) => item.results ?? []).map(normalizeWranglerRow)
}

function stopBytes(limitBytes, ratioBps) {
  return Math.floor((limitBytes * ratioBps) / 10_000)
}

async function localD1SizeBytes(options) {
  const rows = await runD1Json(
    d1CommandArguments(options, 'target', 'SELECT COUNT(*) AS item_count FROM sqlite_master;'),
  )
  const size = rows[0]?.meta?.size_after
  return Number.isFinite(Number(size)) ? Math.max(0, Number(size)) : 0
}

async function localObjectRegistryBytes(options, storageMode) {
  const rows = await queryTarget(
    options,
    `SELECT COALESCE(SUM(expected_size_bytes), 0) AS used_bytes
     FROM object_registry
     WHERE storage_mode = ${sqlLiteral(storageMode)}
       AND object_status <> 'deleted' AND is_current = 1;`,
  )
  return Number(rows[0]?.used_bytes ?? 0)
}

function migrationCheck(name, passed, detail) {
  return { name, status: passed ? 'passed' : 'failed', ...detail }
}

function requireStorageOptions(options, side) {
  const mode = options[`${side}StorageMode`]
  if (!['kv', 'r2'].includes(mode)) {
    throw new Error(`${side === 'source' ? '来源' : '目标'}必须指定 --${side}-storage-mode kv|r2`)
  }
  if (!options[`${side}ConfigPath`]) throw new Error(`必须指定 --${side}-config`)
  if (mode === 'r2' && !options[`${side}Bucket`]) {
    throw new Error(`${side === 'source' ? '来源' : '目标'} R2 必须指定 --${side}-bucket`)
  }
  if (mode === 'kv' && !options[`${side}Binding`]) {
    throw new Error(`${side === 'source' ? '来源' : '目标'} KV 必须指定 --${side}-binding`)
  }
}

function commonWranglerArguments(options, side) {
  const configPath = options[`${side}ConfigPath`]
  if (!configPath) throw new Error(`必须指定 --${side}-config`)
  const remote = options[`${side}Remote`] === true
  const args = [remote ? '--remote' : '--local', '--config', resolve(configPath)]
  const persistTo = options[`${side}PersistTo`]
  if (!remote && persistTo) args.push('--persist-to', resolve(persistTo))
  return args
}

function d1CommandArguments(options, side, command) {
  const database = options[`${side}Database`]
  if (!database) throw new Error(`必须指定 --${side}-database`)
  return [
    'd1',
    'execute',
    database,
    ...commonWranglerArguments(options, side),
    '--command',
    command,
    '--json',
  ]
}

async function runD1Json(args) {
  const output = await runWrangler(args)
  const value = output.toString('utf8').replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  for (let start = value.indexOf('['); start !== -1; start = value.indexOf('[', start + 1)) {
    for (let end = value.lastIndexOf(']'); end > start; end = value.lastIndexOf(']', end - 1)) {
      try {
        const parsed = JSON.parse(value.slice(start, end + 1))
        if (Array.isArray(parsed)) return parsed
      } catch {
        // Wrangler 可在 JSON 前后写入诊断信息，继续尝试下一个数组边界。
      }
    }
  }
  throw new Error(`无法解析 Wrangler D1 JSON 输出：${value.trim() || '标准输出为空'}`)
}

async function downloadBoundObject(options, side, key, outputPath = null) {
  const mode = options[`${side}StorageMode`]
  if (mode === 'r2') {
    const temporaryDirectory = outputPath
      ? null
      : await mkdtemp(join(tmpdir(), 'simlettra-legacy-read-'))
    const path = outputPath ?? join(temporaryDirectory, '对象.bin')
    try {
      await runWrangler([
        'r2',
        'object',
        'get',
        `${options[`${side}Bucket`]}/${key}`,
        ...commonWranglerArguments(options, side),
        '--file',
        path,
      ])
      return await readFile(path)
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { force: true, recursive: true })
    }
  }
  return runWrangler(
    [
      'kv',
      'key',
      'get',
      key,
      ...commonWranglerArguments(options, side),
      '--binding',
      options[`${side}Binding`],
    ],
    { binary: true },
  )
}

async function uploadBoundObject(options, side, key, sourceFile) {
  const mode = options[`${side}StorageMode`]
  if (mode === 'r2') {
    await runWrangler([
      'r2',
      'object',
      'put',
      `${options[`${side}Bucket`]}/${key}`,
      ...commonWranglerArguments(options, side),
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
    key,
    ...commonWranglerArguments(options, side),
    '--binding',
    options[`${side}Binding`],
    '--path',
    sourceFile,
  ])
}

function runWrangler(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [WRANGLER_PATH, ...args], {
      cwd: PROJECT_DIRECTORY,
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
      const output = Buffer.concat(stdout)
      const errorText = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        rejectPromise(
          new Error(`Wrangler 执行失败（${code}）：${errorText || output.toString('utf8')}`),
        )
        return
      }
      if (!options.binary && errorText && !errorText.includes('Failed to write to log file')) {
        process.stderr.write(`${errorText}\n`)
      }
      resolvePromise(options.binary ? output : output.toString('utf8') || errorText)
    })
  })
}

function normalizeWranglerRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeWranglerValue(value)]),
  )
}

function normalizeWranglerValue(value) {
  if (
    Array.isArray(value) &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return { __binary_hex: Buffer.from(value).toString('hex') }
  }
  if (value && typeof value === 'object') {
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
      return { __binary_hex: Buffer.from(value.data).toString('hex') }
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeWranglerValue(child)]),
    )
  }
  return value
}

function normalizeBinaryHex(value) {
  if (typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value)) return value.toLowerCase()
  if (typeof value === 'string' && /^\[(?:\d+(?:,\s*)?)*\]$/u.test(value)) {
    try {
      const bytes = JSON.parse(value)
      if (
        Array.isArray(bytes) &&
        bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
      ) {
        return Buffer.from(bytes).toString('hex')
      }
    } catch {
      return null
    }
  }
  if (value && typeof value === 'object' && typeof value.__binary_hex === 'string') {
    return value.__binary_hex.toLowerCase()
  }
  return null
}

function legacyPrimaryKey(table) {
  return {
    user: 'user_id',
    account: 'account_id',
    email: 'email_id',
    attachments: 'att_id',
    star: 'star_id',
  }[table]
}

function collectReferencedLegacyObjectKeys(tableRows) {
  const keys = new Set()
  for (const row of tableRows.get('email') ?? []) {
    if (numberFlag(row.is_del) === 1) continue
    const key = normalizeLegacyObjectKey(row.body_key)
    if (key) keys.add(key)
  }
  for (const row of tableRows.get('attachments') ?? []) {
    if (numberFlag(row.status) === 1) continue
    const key = normalizeLegacyObjectKey(row.key)
    if (key) keys.add(key)
  }
  return keys
}

function compareManifestEntries(left, right) {
  return `${left.kind}\n${left.logicalKey}`.localeCompare(`${right.kind}\n${right.logicalKey}`)
}

function buildSnapshotReport({ manifest, tableRows, errors, warnings }) {
  return {
    product: PRODUCT_NAME,
    sourceSnapshotSha256: manifest.sourceSnapshotSha256,
    storageMode: manifest.storageMode,
    tables: Object.fromEntries(
      TABLE_NAMES.map((table) => [table, (tableRows.get(table) ?? []).length]),
    ),
    objects: manifest.entries.filter((entry) => entry.kind === 'object').length,
    errors,
    warnings,
    status: errors.length === 0 ? 'valid' : 'invalid',
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function assertSnapshotManifest(value) {
  if (
    !value ||
    value.product !== PRODUCT_NAME ||
    value.sourceSystem !== SOURCE_SYSTEM ||
    value.sourceVersion !== SOURCE_VERSION ||
    value.sourceReferenceCommit !== SOURCE_REFERENCE_COMMIT ||
    value.snapshotFormatVersion !== SNAPSHOT_FORMAT_VERSION ||
    value.migrationRulesVersion !== MIGRATION_RULES_VERSION ||
    !['kv', 'r2'].includes(value.storageMode) ||
    !Array.isArray(value.entries) ||
    !/^[0-9a-f]{64}$/u.test(String(value.sourceSnapshotSha256 ?? ''))
  ) {
    throw new Error('旧系统快照清单格式或版本不兼容')
  }
  const identities = new Set()
  for (const entry of value.entries) {
    if (
      !entry ||
      !['table', 'object'].includes(entry.kind) ||
      typeof entry.logicalKey !== 'string' ||
      typeof entry.file !== 'string' ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      !/^[0-9a-f]{64}$/u.test(String(entry.sha256 ?? '')) ||
      (entry.kind === 'table' && (!Number.isSafeInteger(entry.rowCount) || entry.rowCount < 0))
    ) {
      throw new Error('旧系统快照清单项无效')
    }
    const identity = `${entry.kind}\n${entry.logicalKey}`
    if (identities.has(identity)) throw new Error('旧系统快照清单项重复')
    identities.add(identity)
  }
}

function resolveSnapshotFile(snapshotDirectory, file) {
  const root = resolve(snapshotDirectory)
  const path = resolve(root, file)
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('快照文件路径越界')
  return path
}

function parseNdjson(bytes, logicalKey, errors) {
  const rows = []
  const value = Buffer.from(bytes).toString('utf8')
  for (const [index, line] of value.split('\n').entries()) {
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      errors.push({ code: 'snapshot_ndjson_invalid', logicalKey, line: index + 1 })
    }
  }
  return rows
}

function assertTargetFacts(target) {
  if (
    !target ||
    !['kv', 'r2'].includes(target.storageMode) ||
    !target.adminUserId ||
    !target.adminAddressId ||
    !target.adminBindingId ||
    !(target.domains instanceof Map) ||
    !(target.claims instanceof Map) ||
    !(target.logicalStorage instanceof Map) ||
    !(target.sourceMappings instanceof Map) ||
    !Array.isArray(target.migrationRuns) ||
    !Number.isSafeInteger(target.defaultLogicalLimitBytes) ||
    !Number.isFinite(target.storageUsedBytes) ||
    !Number.isFinite(target.storageStopBytes) ||
    !Number.isFinite(target.d1UsedBytes) ||
    !Number.isFinite(target.d1StopBytes)
  ) {
    throw new Error('目标系统事实不完整')
  }
  return target
}

function normalizeManagedEmailAddress(value) {
  const text = String(value ?? '').trim()
  const separator = text.lastIndexOf('@')
  if (separator <= 0 || separator === text.length - 1 || text.indexOf('@') !== separator) {
    throw new Error('邮箱地址格式无效')
  }
  const localPart = text.slice(0, separator).toLowerCase()
  const displayDomain = text
    .slice(separator + 1)
    .replace(/\.$/u, '')
    .toLowerCase()
  if (!LOCAL_PART_PATTERN.test(localPart) || localPart.includes('..')) {
    throw new Error('邮箱前缀不符合当前 ASCII 规则')
  }
  const canonicalDomain = domainToASCII(displayDomain).toLowerCase()
  if (
    !canonicalDomain ||
    canonicalDomain.length > 253 ||
    !canonicalDomain.includes('.') ||
    canonicalDomain.split('.').some((label) => !DOMAIN_LABEL_PATTERN.test(label))
  ) {
    throw new Error('邮箱域名格式无效')
  }
  const canonicalAddress = `${localPart}@${canonicalDomain}`
  if (canonicalAddress.length > 320) throw new Error('邮箱地址过长')
  return { localPart, displayDomain, canonicalDomain, canonicalAddress }
}

function parseLegacyTime(value, fallback) {
  if (Number.isSafeInteger(value) && value >= 0)
    return value < 10_000_000_000 ? value * 1000 : value
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric >= 0)
    return numeric < 10_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric)
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function safeDisplayName(value, fallback) {
  return safeOptionalText(value, 80) ?? safeOptionalText(fallback, 80) ?? '旧系统用户'
}

function safeOptionalText(value, maximumLength) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text ? [...text].slice(0, maximumLength).join('') : null
}

function safeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : fallback
}

function numberFlag(value) {
  return Number(value) === 1 ? 1 : 0
}

function sourceIdOf(value, entity) {
  if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
    return String(value).trim()
  }
  throw new Error(`${entity} 缺少稳定来源编号`)
}

function normalizeLegacyObjectKey(value) {
  const key = String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
  if (!key || key.startsWith('/') || key.includes('../') || key.includes('/..')) return null
  return key
}

function safeMediaType(value) {
  const mediaType = safeOptionalText(value, 255)
  return mediaType && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;.*)?$/u.test(mediaType)
    ? mediaType
    : 'application/octet-stream'
}

function safeAttachmentName(value, index) {
  const name = safeOptionalText(value, 255)
  return name ?? `旧附件-${index + 1}`
}

function safeMessageReference(value) {
  const text = safeOptionalText(value, 998)
  if (!text) return null
  const match = text.match(MESSAGE_REFERENCE_PATTERN)
  return match?.[0] ?? null
}

function failure(entityType, sourceEntityId, failureCode, error) {
  return {
    entityType,
    sourceEntityId: String(sourceEntityId),
    failureCode,
    summary: safeErrorSummary(error),
  }
}

function countResult(scanned, succeeded, skipped) {
  return { scanned, succeeded, skipped, failed: Math.max(0, scanned - succeeded - skipped) }
}

function normalizeCountRemainders(counts) {
  for (const count of Object.values(counts)) {
    count.failed = Math.max(0, count.scanned - count.succeeded - count.skipped)
  }
}

function textChunks(value, maximumCharacters = 12_000, overlapCharacters = 128) {
  const input = String(value ?? '')
  if (!input) return ['']
  const chunks = []
  const step = maximumCharacters - overlapCharacters
  for (let start = 0; start < input.length; start += step) {
    chunks.push(input.slice(start, Math.min(input.length, start + maximumCharacters)))
  }
  return chunks
}

function tokenizeSearchText(input) {
  const chineseCharacter = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
  const letterNumberOrMark = /\p{Letter}|\p{Number}|\p{Mark}/u
  const tokens = []
  let chineseRun = ''
  let latinRun = ''
  const flushChinese = () => {
    if (chineseRun.length === 1) tokens.push(chineseRun)
    else
      for (let index = 0; index < chineseRun.length - 1; index += 1)
        tokens.push(chineseRun.slice(index, index + 2))
    chineseRun = ''
  }
  const flushLatin = () => {
    for (let index = 0; index < latinRun.length; index += 64)
      tokens.push(latinRun.slice(index, index + 64))
    latinRun = ''
  }
  for (const character of String(input ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')) {
    if (chineseCharacter.test(character)) {
      flushLatin()
      chineseRun += character
    } else if (letterNumberOrMark.test(character)) {
      flushChinese()
      latinRun += character
    } else {
      flushChinese()
      flushLatin()
    }
  }
  flushChinese()
  flushLatin()
  return tokens.filter(Boolean).join(' ')
}

function htmlToPlainText(value) {
  return String(value ?? '')
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll(/\s+/gu, ' ')
    .trim()
}

function stableId(namespace, ...parts) {
  return `${namespace}-${sha256Hex(Buffer.from(parts.map(String).join('\n')))}`
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest()
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SQL 数值无效')
    return String(value)
  }
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replaceAll("'", "''")}'`
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(`非法数据库标识符：${value}`)
  return `"${value}"`
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

function safeErrorSummary(error) {
  const value = error instanceof Error ? error.message : String(error)
  return [...value.replaceAll(/[\r\n\t]+/gu, ' ').trim()].slice(0, 500).join('') || '未知错误'
}

function groupRows(rows, keyOf) {
  const result = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    const values = result.get(key) ?? []
    values.push(row)
    result.set(key, values)
  }
  return result
}

async function writeFailureReport(error, values) {
  const path = values['failure-report'] ?? values.report
  if (!path) return
  const failures = error instanceof LegacyMigrationValidationError ? error.failures : []
  await writeJson(resolve(path), {
    product: PRODUCT_NAME,
    status: 'failed',
    error: safeErrorSummary(error),
    failures,
    failedAt: Date.now(),
  })
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  await runCli(process.argv.slice(2))
}

async function runCli(args) {
  const command = args[0]
  const values = parseArguments(args.slice(1))
  const options = cliOptions(values)
  try {
    if (command === 'snapshot') {
      const result = await createLegacySnapshot(options)
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
      if (result.report.errors.length > 0) process.exitCode = 2
      return
    }
    if (command === 'validate') {
      const result = await validateLegacySnapshot(options)
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
      if (result.report.errors.length > 0) process.exitCode = 2
      return
    }
    if (command === 'rehearse') {
      process.stdout.write(`${JSON.stringify(await rehearseLegacyMigration(options), null, 2)}\n`)
      return
    }
    if (command === 'apply') {
      process.stdout.write(`${JSON.stringify(await applyLegacyMigration(options), null, 2)}\n`)
      return
    }
    throw new Error('用法：node tools/旧系统数据迁移.mjs snapshot|validate|rehearse|apply [参数]')
  } catch (error) {
    await writeFailureReport(error, values)
    throw error
  }
}

function cliOptions(values) {
  return {
    snapshotDirectory: values.snapshot,
    outputDirectory: values.output,
    reportPath: values.report,
    rehearsalReportPath: values['rehearsal-report'],
    confirmation: values.confirm,
    sourceConfigPath: values['source-config'],
    sourceDatabase: values['source-database'],
    sourceStorageMode: values['source-storage-mode'],
    sourceBucket: values['source-bucket'],
    sourceBinding: values['source-binding'],
    sourcePersistTo: values['source-persist-to'],
    sourceRemote: values['source-remote'] === true,
    targetConfigPath: values['target-config'],
    targetDatabase: values['target-database'],
    targetStorageMode: values['target-storage-mode'],
    targetBucket: values['target-bucket'],
    targetBinding: values['target-binding'],
    targetPersistTo: values['target-persist-to'],
    targetRemote: values['target-remote'] === true,
  }
}

function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) throw new Error(`无法识别参数：${argument}`)
    const key = argument.slice(2)
    if (key === 'source-remote' || key === 'target-remote') {
      values[key] = true
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值`)
    values[key] = value
    index += 1
  }
  return values
}

export class LegacyMigrationValidationError extends Error {
  constructor(message, failures) {
    super(message)
    this.failures = failures
  }
}
