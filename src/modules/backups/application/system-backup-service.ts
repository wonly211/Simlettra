import type { BackgroundTaskMessage } from '../../../shared/contracts/background-task'
import type {
  SystemBackupManifest,
  SystemBackupOverviewResponse,
  SystemBackupRunSummary,
} from '../../../shared/contracts/system-backups'
import type { StorageMode } from '../../../shared/contracts/storage-mode'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'
import { bytesToHex, sha256Bytes, toArrayBuffer } from '../../mail-receiving/domain/content-digest'
import type { MailObjectStore } from '../../mail-receiving/infrastructure/object-storage'

const BACKUP_FORMAT_VERSION = 1
const BACKUP_ENCRYPTION_FORMAT = 'AES-GCM-256-本地容器由下载工具加密'
const BACKUP_KDF_NAME = 'PBKDF2-HMAC-SHA-256-900000'
const BACKUP_PAGE_SIZE = 128
const BACKUP_TASK_MAX_ATTEMPTS = 5

const EXCLUDED_TABLES = new Set([
  '_cf_METADATA',
  'd1_migrations',
  'sqlite_sequence',
  'sessions',
  'login_rate_limits',
  'initialization_rate_limits',
  'background_tasks',
  'background_task_attempts',
  'backup_runs',
  'backup_checkpoints',
  'backup_manifest_entries',
  'backup_required_key_versions',
  'restore_runs',
  'restore_checkpoints',
  'restore_checks',
  'export_runs',
  'export_items',
  'export_artifacts',
  'message_search_states',
  'message_search_chunks',
  'message_search_index',
  'message_search_index_config',
  'message_search_index_data',
  'message_search_index_docsize',
  'message_search_index_idx',
])

interface BackupRunRow {
  id: string
  backup_format_version: number
  migration_version: string
  storage_mode: StorageMode
  backup_status: string
  table_count: number
  object_count: number
  total_bytes: number
  manifest_sha256_hex: string | null
  last_error_code: string | null
  started_at: number | null
  completed_at: number | null
  created_at: number
}

interface BackupCheckpointRow {
  id: string
  source_kind: 'd1_table' | 'object_store'
  source_name: string
  cursor_value: string | null
  scanned_count: number
  written_count: number
  written_bytes: number
  checkpoint_status: string
}

interface BackupEntryRow {
  id: string
  entry_kind: 'd1_table' | 'object'
  logical_key: string
  row_count: number | null
  size_bytes: number
  sha256_hex: string
}

export class SystemBackupInputError extends Error {
  constructor(
    readonly field: 'backupId' | 'entryId',
    message: string,
  ) {
    super(message)
  }
}

export class SystemBackupPermissionError extends Error {}

export class SystemBackupAccessError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_ready' | 'object_unavailable' | 'source_changed',
    message: string,
  ) {
    super(message)
  }
}

export async function getSystemBackupOverview(options: {
  database: D1Database
  actorUserId: string
}): Promise<SystemBackupOverviewResponse['data']> {
  await requireAdministrator(options.database, options.actorUserId)
  const backups = await options.database
    .prepare(
      `SELECT id, backup_format_version, migration_version, storage_mode,
              backup_status, table_count, object_count, total_bytes,
              lower(hex(manifest_sha256)) AS manifest_sha256_hex,
              last_error_code, started_at, completed_at, created_at
       FROM backup_runs ORDER BY created_at DESC, id DESC LIMIT 30`,
    )
    .all<BackupRunRow>()
  const restores = await options.database
    .prepare(
      `SELECT id, source_backup_reference,
              lower(hex(source_manifest_sha256)) AS source_manifest_sha256_hex,
              target_mode, restore_status, current_stage, last_error_code,
              created_at, started_at, completed_at
       FROM restore_runs ORDER BY created_at DESC, id DESC LIMIT 30`,
    )
    .all<{
      id: string
      source_backup_reference: string
      source_manifest_sha256_hex: string
      target_mode: 'empty'
      restore_status: string
      current_stage: string
      last_error_code: string | null
      created_at: number
      started_at: number | null
      completed_at: number | null
    }>()
  const requiredKeys = await options.database
    .prepare(
      `SELECT backup_run_id, key_version
       FROM backup_required_key_versions ORDER BY backup_run_id, key_version`,
    )
    .all<{ backup_run_id: string; key_version: number }>()
  const keyMap = new Map<string, number[]>()
  for (const row of requiredKeys.results) {
    const values = keyMap.get(row.backup_run_id) ?? []
    values.push(row.key_version)
    keyMap.set(row.backup_run_id, values)
  }
  return {
    backups: backups.results.map((row) => mapBackupRun(row, keyMap.get(row.id) ?? [])),
    restores: restores.results.map((row) => ({
      id: row.id,
      sourceBackupReference: row.source_backup_reference,
      sourceManifestSha256: row.source_manifest_sha256_hex,
      targetMode: row.target_mode,
      status:
        row.restore_status as SystemBackupOverviewResponse['data']['restores'][number]['status'],
      currentStage:
        row.current_stage as SystemBackupOverviewResponse['data']['restores'][number]['currentStage'],
      errorCode: row.last_error_code,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    })),
  }
}

export async function createSystemBackup(options: {
  database: D1Database
  queue: Queue<BackgroundTaskMessage>
  storageMode: StorageMode
  actorUserId: string
  configEncryptionKeyConfigured: boolean
  audit: AuditContext
  now?: number
}): Promise<SystemBackupRunSummary> {
  await requireAdministrator(options.database, options.actorUserId)
  const now = options.now ?? Date.now()
  const backupId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  const migrationVersion = await loadCurrentMigrationVersion(options.database)
  const tables = await listAuthoritativeTables(options.database)
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO backup_runs (
           id, backup_format_version, migration_version, storage_mode,
           encryption_mode, encryption_format, kdf_name, backup_status,
           table_count, object_count, total_bytes, manifest_sha256,
           last_error_code, started_at, completed_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, 'authenticated', ?5, ?6, 'planned',
                   0, 0, 0, NULL, NULL, NULL, NULL, ?7, ?7)`,
      )
      .bind(
        backupId,
        BACKUP_FORMAT_VERSION,
        migrationVersion,
        options.storageMode,
        BACKUP_ENCRYPTION_FORMAT,
        BACKUP_KDF_NAME,
        now,
      ),
    ...tables.map((tableName) =>
      options.database
        .prepare(
          `INSERT INTO backup_checkpoints (
             id, backup_run_id, source_kind, source_name, cursor_value,
             scanned_count, written_count, written_bytes, checkpoint_status,
             last_error_code, created_at, updated_at
           ) VALUES (?1, ?2, 'd1_table', ?3, NULL, 0, 0, 0, 'pending', NULL, ?4, ?4)`,
        )
        .bind(crypto.randomUUID(), backupId, tableName, now),
    ),
    options.database
      .prepare(
        `INSERT INTO backup_checkpoints (
           id, backup_run_id, source_kind, source_name, cursor_value,
           scanned_count, written_count, written_bytes, checkpoint_status,
           last_error_code, created_at, updated_at
         ) VALUES (?1, ?2, 'object_store', 'object_registry', NULL, 0, 0, 0, 'pending', NULL, ?3, ?3)`,
      )
      .bind(crypto.randomUUID(), backupId, now),
    makeBackupTaskStatement(
      options.database,
      taskId,
      backupId,
      await sha256Bytes(`generate_system_backup\n${backupId}\n1`),
      now,
    ),
    ...(options.configEncryptionKeyConfigured
      ? [
          options.database
            .prepare(
              `INSERT INTO backup_required_key_versions (
                 backup_run_id, key_purpose, key_version, created_at
               ) VALUES (?1, 'config_encryption', 1, ?2)`,
            )
            .bind(backupId, now),
        ]
      : []),
    createAuditEventStatement(options.database, {
      actorType: 'user',
      actorUserId: options.actorUserId,
      actionName: 'system_backup_created',
      targetType: 'backup_run',
      targetReference: backupId,
      outcome: 'succeeded',
      occurredAt: now,
      ...options.audit,
    }),
  ]
  await options.database.batch(statements)
  try {
    await options.queue.send({ taskId, inputVersion: 1 })
  } catch {
    // D1 任务账本是权威来源，Cron 会补投未送达的 Queue 消息。
  }
  return getSystemBackup(options.database, options.actorUserId, backupId)
}

export async function processSystemBackupTask(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  queue?: Queue<BackgroundTaskMessage>
  backupRunId: string
  now?: number
}): Promise<{ status: 'succeeded' }> {
  const now = options.now ?? Date.now()
  const run = await loadBackupRun(options.database, options.backupRunId)
  if (!run || ['succeeded', 'cancelled'].includes(run.backup_status)) return { status: 'succeeded' }
  await options.database
    .prepare(
      `UPDATE backup_runs SET backup_status = 'running',
          started_at = COALESCE(started_at, ?1), last_error_code = NULL, updated_at = ?1
       WHERE id = ?2 AND backup_status IN ('planned', 'running', 'paused', 'failed')`,
    )
    .bind(now, options.backupRunId)
    .run()
  const checkpoint = await nextCheckpoint(options.database, options.backupRunId)
  if (!checkpoint) {
    await finalizeBackup(options)
    return { status: 'succeeded' }
  }
  if (checkpoint.source_kind === 'd1_table') {
    await processTableCheckpoint(options, checkpoint, now)
  } else {
    await processObjectCheckpoint(options, checkpoint, now)
  }
  const next = await nextCheckpoint(options.database, options.backupRunId)
  if (!next) {
    await finalizeBackup(options)
  } else {
    const taskId = crypto.randomUUID()
    const taskDigest = await sha256Bytes(
      `generate_system_backup\n${options.backupRunId}\n${next.id}`,
    )
    await options.database
      .prepare(
        `INSERT OR IGNORE INTO background_tasks (
           id, task_type, target_type, target_reference, input_version,
           task_key_digest, task_status, priority, attempt_count, max_attempts,
           next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
           last_error_code, last_error_summary, last_error_at, completed_at, created_at, updated_at
         ) VALUES (?1, 'generate_system_backup', 'backup_run', ?2, 1, ?3,
                   'pending', 4, 0, ?4, ?5, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?5, ?5)`,
      )
      .bind(taskId, options.backupRunId, taskDigest, BACKUP_TASK_MAX_ATTEMPTS, now)
      .run()
    const task = await options.database
      .prepare(`SELECT id, input_version FROM background_tasks WHERE task_key_digest = ?1 LIMIT 1`)
      .bind(taskDigest)
      .first<{ id: string; input_version: number }>()
    if (task && options.queue) {
      try {
        await options.queue.send({ taskId: task.id, inputVersion: task.input_version })
      } catch {
        // Cron 会依据任务账本补投。
      }
    }
  }
  return { status: 'succeeded' }
}

export async function getSystemBackup(
  database: D1Database,
  actorUserId: string,
  backupId: string,
): Promise<SystemBackupRunSummary> {
  await requireAdministrator(database, actorUserId)
  const row = await loadBackupRun(database, backupId)
  if (!row) throw new SystemBackupAccessError('not_found', '备份记录不存在')
  const keys = await database
    .prepare(
      `SELECT key_version FROM backup_required_key_versions WHERE backup_run_id = ?1 ORDER BY key_version`,
    )
    .bind(backupId)
    .all<{ key_version: number }>()
  return mapBackupRun(
    row,
    keys.results.map((value) => value.key_version),
  )
}

export async function getSystemBackupManifest(options: {
  database: D1Database
  actorUserId: string
  backupId: string
}): Promise<{ bytes: ArrayBuffer; fileName: string }> {
  await requireAdministrator(options.database, options.actorUserId)
  const row = await loadBackupRun(options.database, options.backupId)
  if (!row) throw new SystemBackupAccessError('not_found', '备份记录不存在')
  if (row.backup_status !== 'succeeded')
    throw new SystemBackupAccessError('not_ready', '备份尚未完成')
  const manifest = await buildManifest(options.database, row)
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
  const digest = await sha256Bytes(bytes)
  if (!row.manifest_sha256_hex || bytesToHex(digest) !== row.manifest_sha256_hex) {
    throw new SystemBackupAccessError('source_changed', '备份清单来源已变化，请重新建立备份')
  }
  return {
    bytes: toArrayBuffer(bytes),
    fileName: `simlettra-备份-${options.backupId}-清单.json`,
  }
}

export async function getSystemBackupPart(options: {
  database: D1Database
  objectStore: MailObjectStore
  actorUserId: string
  backupId: string
  entryId: string
}): Promise<{ bytes: ArrayBuffer; fileName: string; mediaType: string }> {
  await requireAdministrator(options.database, options.actorUserId)
  const entry = await options.database
    .prepare(
      `SELECT id, entry_kind, logical_key, row_count, size_bytes,
              lower(hex(content_sha256)) AS sha256_hex
       FROM backup_manifest_entries WHERE id = ?1 AND backup_run_id = ?2 LIMIT 1`,
    )
    .bind(options.entryId, options.backupId)
    .first<BackupEntryRow>()
  if (!entry) throw new SystemBackupAccessError('not_found', '备份分块不存在')
  const run = await loadBackupRun(options.database, options.backupId)
  if (!run) throw new SystemBackupAccessError('not_found', '备份记录不存在')
  if (run.backup_status !== 'succeeded') {
    throw new SystemBackupAccessError('not_ready', '备份尚未完成')
  }
  const bytes =
    entry.entry_kind === 'd1_table'
      ? await rebuildTablePart(options.database, entry)
      : await rebuildObjectPart(options.database, options.objectStore, entry)
  const digest = await sha256Bytes(bytes)
  if (bytes.byteLength !== entry.size_bytes || bytesToHex(digest) !== entry.sha256_hex) {
    throw new SystemBackupAccessError('source_changed', '备份来源已变化，请重新建立备份')
  }
  return {
    bytes: toArrayBuffer(bytes),
    fileName: `simlettra-备份-${options.backupId}-${safeFileName(entry.logical_key)}.bin`,
    mediaType:
      entry.entry_kind === 'd1_table' ? 'application/x-ndjson' : 'application/octet-stream',
  }
}

async function processTableCheckpoint(
  options: { database: D1Database; objectStore: MailObjectStore; backupRunId: string },
  checkpoint: BackupCheckpointRow,
  now: number,
) {
  const offset = checkpoint.cursor_value ? Number(checkpoint.cursor_value) : 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('backup_cursor_invalid')
  const result = await options.database
    .prepare(
      `SELECT * FROM ${quoteIdentifier(checkpoint.source_name)} ORDER BY rowid LIMIT ?1 OFFSET ?2`,
    )
    .bind(BACKUP_PAGE_SIZE, offset)
    .all<Record<string, unknown>>()
  const lines = result.results.map((row) => JSON.stringify(stableNormalize(row)))
  const bytes = new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
  const digest = await sha256Bytes(bytes)
  const logicalKey = `${checkpoint.source_name}/${String(offset).padStart(10, '0')}`
  await options.database.batch([
    options.database
      .prepare(
        `INSERT OR IGNORE INTO backup_manifest_entries (
           id, backup_run_id, entry_kind, logical_key, row_count, size_bytes,
           content_sha256, created_at
         ) VALUES (?1, ?2, 'd1_table', ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        crypto.randomUUID(),
        options.backupRunId,
        logicalKey,
        result.results.length,
        bytes.byteLength,
        digest,
        now,
      ),
    options.database
      .prepare(
        `UPDATE backup_checkpoints
         SET cursor_value = ?1, scanned_count = scanned_count + ?2,
             written_count = written_count + ?2, written_bytes = written_bytes + ?3,
             checkpoint_status = ?4, updated_at = ?5
         WHERE id = ?6`,
      )
      .bind(
        String(offset + result.results.length),
        result.results.length,
        bytes.byteLength,
        result.results.length < BACKUP_PAGE_SIZE ? 'completed' : 'running',
        now,
        checkpoint.id,
      ),
  ])
}

async function processObjectCheckpoint(
  options: { database: D1Database; objectStore: MailObjectStore; backupRunId: string },
  checkpoint: BackupCheckpointRow,
  now: number,
) {
  const row = await options.database
    .prepare(
      `SELECT id, object_key, expected_size_bytes, expected_sha256, media_type
       FROM object_registry
       WHERE object_status <> 'deleted' AND (?1 IS NULL OR id > ?1)
       ORDER BY id LIMIT 1`,
    )
    .bind(checkpoint.cursor_value)
    .first<{
      id: string
      object_key: string
      expected_size_bytes: number
      expected_sha256: ArrayBuffer
      media_type: string
    }>()
  if (!row) {
    await options.database
      .prepare(
        `UPDATE backup_checkpoints SET checkpoint_status = 'completed', updated_at = ?1 WHERE id = ?2`,
      )
      .bind(now, checkpoint.id)
      .run()
    return
  }
  const object = await options.objectStore.get(row.object_key)
  if (!object) throw new Error('backup_source_object_missing')
  const bytes = new Uint8Array(object.bytes)
  const digest = await sha256Bytes(bytes)
  if (
    bytes.byteLength !== row.expected_size_bytes ||
    bytesToHex(digest) !== bytesToHex(new Uint8Array(row.expected_sha256))
  )
    throw new Error('backup_source_object_hash_mismatch')
  await options.database.batch([
    options.database
      .prepare(
        `INSERT OR IGNORE INTO backup_manifest_entries (
           id, backup_run_id, entry_kind, logical_key, row_count, size_bytes,
           content_sha256, created_at
         ) VALUES (?1, ?2, 'object', ?3, NULL, ?4, ?5, ?6)`,
      )
      .bind(crypto.randomUUID(), options.backupRunId, row.id, bytes.byteLength, digest, now),
    options.database
      .prepare(
        `UPDATE backup_checkpoints
         SET cursor_value = ?1, scanned_count = scanned_count + 1,
             written_count = written_count + 1, written_bytes = written_bytes + ?2,
             checkpoint_status = 'running', updated_at = ?3 WHERE id = ?4`,
      )
      .bind(row.id, bytes.byteLength, now, checkpoint.id),
  ])
}

async function finalizeBackup(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  backupRunId: string
  now?: number
}) {
  const now = options.now ?? Date.now()
  const run = await loadBackupRun(options.database, options.backupRunId)
  if (!run) throw new Error('backup_run_missing')
  const rows = await options.database
    .prepare(
      `SELECT id, entry_kind, logical_key, row_count, size_bytes,
              lower(hex(content_sha256)) AS sha256_hex
       FROM backup_manifest_entries WHERE backup_run_id = ?1 ORDER BY entry_kind, logical_key, id`,
    )
    .bind(options.backupRunId)
    .all<BackupEntryRow>()
  const keys = await options.database
    .prepare(
      `SELECT key_version FROM backup_required_key_versions WHERE backup_run_id = ?1 ORDER BY key_version`,
    )
    .bind(options.backupRunId)
    .all<{ key_version: number }>()
  const entries = rows.results.map((row) => ({
    id: row.id,
    kind: row.entry_kind,
    logicalKey: row.logical_key,
    rowCount: row.row_count,
    sizeBytes: row.size_bytes,
    sha256: row.sha256_hex,
  }))
  const manifest: SystemBackupManifest & { entries: typeof entries } = {
    product: '澄笺 | Simlettra',
    formatVersion: BACKUP_FORMAT_VERSION,
    backupReference: options.backupRunId,
    migrationVersion: run.migration_version,
    storageMode: options.storageMode,
    encryption: { mode: 'authenticated', format: BACKUP_ENCRYPTION_FORMAT, kdf: BACKUP_KDF_NAME },
    requiredConfigurationKeyVersions: keys.results.map((row) => row.key_version),
    tableCount: new Set(
      entries.filter((row) => row.kind === 'd1_table').map((row) => row.logicalKey.split('/')[0]),
    ).size,
    objectCount: entries.filter((row) => row.kind === 'object').length,
    totalBytes: entries.reduce((sum, row) => sum + row.sizeBytes, 0),
    createdAt: run.created_at,
    completedAt: now,
    entries,
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
  const digest = await sha256Bytes(bytes)
  await options.database
    .prepare(
      `UPDATE backup_runs SET backup_status = 'succeeded', table_count = ?1,
          object_count = ?2, total_bytes = ?3, manifest_sha256 = ?4,
          completed_at = ?5, last_error_code = NULL, updated_at = ?5
       WHERE id = ?6 AND backup_status IN ('running', 'paused', 'failed')`,
    )
    .bind(
      manifest.tableCount,
      manifest.objectCount,
      manifest.totalBytes,
      digest,
      now,
      options.backupRunId,
    )
    .run()
}

async function nextCheckpoint(database: D1Database, backupRunId: string) {
  return database
    .prepare(
      `SELECT id, source_kind, source_name, cursor_value, scanned_count,
              written_count, written_bytes, checkpoint_status
       FROM backup_checkpoints
       WHERE backup_run_id = ?1 AND checkpoint_status <> 'completed'
       ORDER BY CASE source_kind WHEN 'd1_table' THEN 0 ELSE 1 END, source_name, id LIMIT 1`,
    )
    .bind(backupRunId)
    .first<BackupCheckpointRow>()
}

async function buildManifest(database: D1Database, row: BackupRunRow) {
  const entries = await database
    .prepare(
      `SELECT id, entry_kind, logical_key, row_count, size_bytes,
              lower(hex(content_sha256)) AS sha256_hex
       FROM backup_manifest_entries WHERE backup_run_id = ?1
       ORDER BY entry_kind, logical_key, id`,
    )
    .bind(row.id)
    .all<BackupEntryRow>()
  const keys = await database
    .prepare(
      `SELECT key_version FROM backup_required_key_versions WHERE backup_run_id = ?1 ORDER BY key_version`,
    )
    .bind(row.id)
    .all<{ key_version: number }>()
  const mapped = entries.results.map((entry) => ({
    id: entry.id,
    kind: entry.entry_kind,
    logicalKey: entry.logical_key,
    rowCount: entry.row_count,
    sizeBytes: entry.size_bytes,
    sha256: entry.sha256_hex,
  }))
  return {
    product: '澄笺 | Simlettra' as const,
    formatVersion: BACKUP_FORMAT_VERSION,
    backupReference: row.id,
    migrationVersion: row.migration_version,
    storageMode: row.storage_mode,
    encryption: {
      mode: 'authenticated' as const,
      format: BACKUP_ENCRYPTION_FORMAT,
      kdf: BACKUP_KDF_NAME,
    },
    requiredConfigurationKeyVersions: keys.results.map((key) => key.key_version),
    tableCount: new Set(
      mapped
        .filter((entry) => entry.kind === 'd1_table')
        .map((entry) => entry.logicalKey.split('/')[0]),
    ).size,
    objectCount: mapped.filter((entry) => entry.kind === 'object').length,
    totalBytes: mapped.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    createdAt: row.created_at,
    completedAt: row.completed_at ?? row.created_at,
    entries: mapped,
  } satisfies SystemBackupManifest & { entries: typeof mapped }
}

async function rebuildTablePart(database: D1Database, entry: BackupEntryRow): Promise<Uint8Array> {
  const separator = entry.logical_key.lastIndexOf('/')
  const tableName = entry.logical_key.slice(0, separator)
  const offset = Number(entry.logical_key.slice(separator + 1))
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new SystemBackupAccessError('source_changed', '备份分块游标无效')
  }
  const rows = await database
    .prepare(`SELECT * FROM ${quoteIdentifier(tableName)} LIMIT ?1 OFFSET ?2`)
    .bind(BACKUP_PAGE_SIZE, offset)
    .all<Record<string, unknown>>()
  const lines = rows.results.map((row) => JSON.stringify(stableNormalize(row)))
  return new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
}

async function rebuildObjectPart(
  database: D1Database,
  objectStore: MailObjectStore,
  entry: BackupEntryRow,
): Promise<Uint8Array> {
  const registry = await database
    .prepare(
      `SELECT object_key FROM object_registry
       WHERE id = ?1 AND object_status <> 'deleted' LIMIT 1`,
    )
    .bind(entry.logical_key)
    .first<{ object_key: string }>()
  if (!registry) throw new SystemBackupAccessError('object_unavailable', '备份对象登记不存在')
  const object = await objectStore.get(registry.object_key)
  if (!object) throw new SystemBackupAccessError('object_unavailable', '备份对象暂时不可用')
  return new Uint8Array(object.bytes)
}

async function listAuthoritativeTables(database: D1Database) {
  const result = await database
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
    .all<{ name: string }>()
  return result.results
    .map((row) => row.name)
    .filter((name) => !EXCLUDED_TABLES.has(name) && !name.startsWith('message_search_index_'))
}

async function loadCurrentMigrationVersion(database: D1Database) {
  const migration = await database
    .prepare(`SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`)
    .first<{ name: string }>()
  if (!migration?.name) throw new Error('backup_migration_version_missing')
  return migration.name
}

function makeBackupTaskStatement(
  database: D1Database,
  taskId: string,
  backupId: string,
  taskDigest: Uint8Array,
  now: number,
) {
  return database
    .prepare(
      `INSERT INTO background_tasks (
         id, task_type, target_type, target_reference, input_version,
         task_key_digest, task_status, priority, attempt_count, max_attempts,
         next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
         last_error_code, last_error_summary, last_error_at, completed_at, created_at, updated_at
       ) VALUES (?1, 'generate_system_backup', 'backup_run', ?2, 1, ?3,
                 'pending', 4, 0, ?4, ?5, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?5, ?5)`,
    )
    .bind(taskId, backupId, taskDigest, BACKUP_TASK_MAX_ATTEMPTS, now)
}

async function loadBackupRun(database: D1Database, backupId: string) {
  return database
    .prepare(
      `SELECT id, backup_format_version, migration_version, storage_mode,
              backup_status, table_count, object_count, total_bytes,
              lower(hex(manifest_sha256)) AS manifest_sha256_hex,
              last_error_code, started_at, completed_at, created_at
       FROM backup_runs WHERE id = ?1 LIMIT 1`,
    )
    .bind(backupId)
    .first<BackupRunRow>()
}

async function requireAdministrator(database: D1Database, userId: string) {
  const row = await database
    .prepare(
      `SELECT users.status,
              CASE WHEN system_instances.current_admin_user_id = users.id THEN 1 ELSE 0 END
                AS is_administrator
       FROM users
       LEFT JOIN system_instances ON system_instances.singleton_id = 1
       WHERE users.id = ?1 LIMIT 1`,
    )
    .bind(userId)
    .first<{ status: string; is_administrator: number }>()
  if (!row || row.is_administrator !== 1 || row.status !== 'active')
    throw new SystemBackupPermissionError('只有系统管理员可以管理系统备份')
}

function mapBackupRun(row: BackupRunRow, keyVersions: number[]): SystemBackupRunSummary {
  return {
    id: row.id,
    formatVersion: row.backup_format_version,
    migrationVersion: row.migration_version,
    storageMode: row.storage_mode,
    status: row.backup_status as SystemBackupRunSummary['status'],
    tableCount: row.table_count,
    objectCount: row.object_count,
    totalBytes: row.total_bytes,
    manifestSha256: row.manifest_sha256_hex,
    requiredConfigurationKeyVersions: keyVersions,
    errorCode: row.last_error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function quoteIdentifier(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error('backup_table_name_invalid')
  return `"${value}"`
}

function stableNormalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value
  if (value instanceof ArrayBuffer) return { __binary_hex: bytesToHex(new Uint8Array(value)) }
  if (value instanceof Uint8Array) return { __binary_hex: bytesToHex(value) }
  if (Array.isArray(value)) return value.map(stableNormalize)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableNormalize(record[key])]),
    )
  }
  return String(value)
}

function safeFileName(value: string) {
  return value.replaceAll(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120) || '分块'
}
