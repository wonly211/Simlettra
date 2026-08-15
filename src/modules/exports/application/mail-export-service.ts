import { zipSync, type Zippable } from 'fflate'
import { createMimeMessage } from 'mimetext/browser'
import type { BackgroundTaskMessage } from '../../../shared/contracts/background-task'
import type {
  MailExportRunSummary,
  MailExportScopeType,
} from '../../../shared/contracts/mail-exports'
import type { StorageMode } from '../../../shared/contracts/storage-mode'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'
import { bytesToHex, sha256Bytes, toArrayBuffer } from '../../mail-receiving/domain/content-digest'
import type { MailObjectStore } from '../../mail-receiving/infrastructure/object-storage'
import {
  commitPlatformCapacityReservation,
  releasePlatformCapacityReservation,
  reservePlatformCapacity,
} from '../../platform-resources/public'

const EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_VOLUME_SOURCE_BYTES = 20_000_000
const EXPORT_TASK_MAX_ATTEMPTS = 5
const CLEANUP_TASK_MAX_ATTEMPTS = 5
const ZIP_GENERATOR_VERSION = 'fflate-0.8.2-simlettra-v1'
const PENDING_ITEM_QUERY_LIMIT = 256

interface ExportRunRow {
  id: string
  requested_by_user_id: string
  scope_type: MailExportScopeType
  organization_id: string | null
  organization_name: string | null
  frozen_message_count: number
  export_status: string
  artifact_count: number
  completed_at: number | null
  expires_at: number
  last_error_code: string | null
  created_at: number
}

interface ExportItemRow {
  id: string
  mailbox_entry_id: string
  message_id: string
  sequence_number: number
  source_quality: 'original_mime' | 'reconstructed_structured'
  source_object_id: string | null
  subject: string
  header_date_text: string | null
  header_date_at: number | null
  accepted_at: number
  internet_message_id: string | null
  authored_by_user_id: string | null
}

interface ExportArtifactRow {
  id: string
  sequence_number: number
  object_key: string
  file_name: string
  size_bytes: number
  sha256_hex: string
  artifact_status: string
}

interface MessageObjectRow {
  id: string
  object_key: string
  object_role: string
  sequence_number: number
  expected_size_bytes: number
  actual_size_bytes: number | null
  sha256_hex: string
  media_type: string
  untrusted_file_name: string | null
}

interface HeaderAddressRow {
  address_role: string
  display_name: string | null
  address_text: string
}

interface ArtifactBuild {
  sequenceNumber: number
  fileName: string
  bytes: Uint8Array
  itemResults: Array<{
    itemId: string
    fileName: string
    sizeBytes: number
    sha256: Uint8Array
  }>
}

export class MailExportInputError extends Error {
  constructor(
    readonly field: 'scopeType' | 'organizationId',
    message: string,
  ) {
    super(message)
  }
}

export class MailExportAccessError extends Error {
  constructor(
    readonly code:
      'not_found' | 'permission_denied' | 'not_ready' | 'expired' | 'object_unavailable',
    message: string,
  ) {
    super(message)
  }
}

export async function getMailExportOverview(options: {
  database: D1Database
  userId: string
  now?: number
}) {
  const [organizations, rows, artifacts] = await Promise.all([
    options.database
      .prepare(
        `SELECT id, name FROM organizations
         WHERE creator_user_id = ?1 AND status = 'active'
         ORDER BY created_at, id`,
      )
      .bind(options.userId)
      .all<{ id: string; name: string }>(),
    options.database
      .prepare(
        `SELECT run.id, run.requested_by_user_id, run.scope_type, run.organization_id,
                organization.name AS organization_name, run.frozen_message_count,
                run.export_status, run.artifact_count, run.completed_at, run.expires_at,
                run.last_error_code, run.created_at
         FROM export_runs AS run
         LEFT JOIN organizations AS organization ON organization.id = run.organization_id
         WHERE run.requested_by_user_id = ?1 AND run.export_status <> 'deleted'
         ORDER BY run.created_at DESC, run.id DESC
         LIMIT 30`,
      )
      .bind(options.userId)
      .all<ExportRunRow>(),
    options.database
      .prepare(
        `SELECT artifact.id, artifact.export_run_id, artifact.sequence_number,
                artifact.file_name, artifact.size_bytes
         FROM export_artifacts AS artifact
         JOIN export_runs AS run ON run.id = artifact.export_run_id
         WHERE run.requested_by_user_id = ?1 AND artifact.artifact_status = 'active'
         ORDER BY artifact.export_run_id, artifact.sequence_number`,
      )
      .bind(options.userId)
      .all<{
        id: string
        export_run_id: string
        sequence_number: number
        file_name: string
        size_bytes: number
      }>(),
  ])
  const byRun = new Map<string, MailExportRunSummary['artifacts']>()
  for (const artifact of artifacts.results) {
    const list = byRun.get(artifact.export_run_id) ?? []
    list.push({
      id: artifact.id,
      sequenceNumber: artifact.sequence_number,
      fileName: artifact.file_name,
      sizeBytes: artifact.size_bytes,
      downloadUrl: `/api/auth/mail-exports/${artifact.export_run_id}/artifacts/${artifact.id}`,
    })
    byRun.set(artifact.export_run_id, list)
  }
  return {
    organizations: organizations.results,
    runs: rows.results.map((row) => mapRun(row, byRun.get(row.id) ?? [])),
  }
}

export async function createMailExport(options: {
  database: D1Database
  queue: Queue<BackgroundTaskMessage>
  userId: string
  scopeType: unknown
  organizationId?: unknown
  audit: AuditContext
  now?: number
}): Promise<MailExportRunSummary> {
  const now = options.now ?? Date.now()
  const scopeType = parseScopeType(options.scopeType)
  const organizationId = parseOrganizationId(scopeType, options.organizationId)
  if (organizationId)
    await requireOrganizationCreator(options.database, options.userId, organizationId)
  const frozen = await getFrozenScopeSummary(
    options.database,
    options.userId,
    scopeType,
    organizationId,
    now,
  )
  const runId = crypto.randomUUID()
  const expiresAt = now + EXPORT_RETENTION_MS
  const scopeDigest = await sha256Bytes(
    `${scopeType}\n${organizationId ?? ''}\n${frozen.count}\n${frozen.firstSortAt ?? ''}\n${frozen.lastSortAt ?? ''}\n${now}`,
  )
  const generateTaskId = crypto.randomUUID()
  const cleanupTaskId = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO export_runs (
           id, requested_by_user_id, scope_type, organization_id, scope_digest,
           frozen_message_count, output_format, export_status, artifact_count,
           completed_at, expires_at, deleted_at, last_error_code, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 0, 'zip_eml', 'planned', 0,
                    NULL, ?6, NULL, NULL, ?7, ?7)`,
      )
      .bind(runId, options.userId, scopeType, organizationId, scopeDigest, expiresAt, now),
  ]
  statements.push(
    buildFrozenItemsInsert(options.database, runId, options.userId, scopeType, organizationId, now),
    options.database
      .prepare(
        `UPDATE export_runs
         SET frozen_message_count = (
               SELECT COUNT(*) FROM export_items WHERE export_run_id = ?1
             ),
             updated_at = ?2
         WHERE id = ?1`,
      )
      .bind(runId, now),
  )

  statements.push(
    backgroundTaskStatement(options.database, {
      id: generateTaskId,
      taskType: 'generate_mail_export',
      targetType: 'export_run',
      targetReference: runId,
      inputVersion: 1,
      digest: await sha256Bytes(`generate_mail_export\n${runId}\n1`),
      priority: 5,
      maxAttempts: EXPORT_TASK_MAX_ATTEMPTS,
      nextAttemptAt: now,
      now,
    }),
    backgroundTaskStatement(options.database, {
      id: cleanupTaskId,
      taskType: 'cleanup_mail_export',
      targetType: 'export_run',
      targetReference: runId,
      inputVersion: 1,
      digest: await sha256Bytes(`cleanup_mail_export\n${runId}\n1`),
      priority: 7,
      maxAttempts: CLEANUP_TASK_MAX_ATTEMPTS,
      nextAttemptAt: expiresAt,
      now,
    }),
    createAuditEventStatement(options.database, {
      actorType: 'user',
      actorUserId: options.userId,
      actionName: 'mail_export_created',
      targetType: 'export_run',
      targetReference: runId,
      outcome: 'succeeded',
      occurredAt: now,
      ...options.audit,
    }),
  )
  await options.database.batch(statements)
  try {
    await options.queue.send({ taskId: generateTaskId, inputVersion: 1 })
  } catch {
    // D1 任务账本是权威来源，Cron 会补投未送达的 Queue 消息。
  }
  return getMailExportRun(options.database, options.userId, runId)
}

export async function processMailExportTask(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  queue?: Queue<BackgroundTaskMessage>
  taskId: string
  exportRunId: string
  now?: number
}) {
  const now = options.now ?? Date.now()
  const run = await loadRun(options.database, options.exportRunId)
  if (!run || run.export_status === 'deleted') {
    return { status: 'succeeded' as const }
  }
  if (run.export_status === 'expired') {
    await expireExport(options.database, options.objectStore, run.id, now)
    return { status: 'succeeded' as const }
  }
  if (run.export_status === 'succeeded') return { status: 'succeeded' as const }
  if (run.expires_at <= now) {
    await expireExport(options.database, options.objectStore, run.id, now)
    return { status: 'succeeded' as const }
  }
  try {
    await options.database
      .prepare(
        `UPDATE export_runs SET export_status = 'running', last_error_code = NULL, updated_at = ?1
         WHERE id = ?2 AND export_status IN ('planned', 'running', 'failed')`,
      )
      .bind(now, run.id)
      .run()
    const pendingItems = await loadPendingExportItems(options.database, run.id)
    const existingArtifactCount = await countExportArtifacts(options.database, run.id)
    if (pendingItems.length === 0) {
      if (run.frozen_message_count === 0 && existingArtifactCount === 0) {
        await storeArtifact(options, run, createZipArtifact(run, 1, []), now)
      }
      const artifactCount = await activateAndCountArtifacts(options.database, run.id, now)
      await options.database
        .prepare(
          `UPDATE export_runs
           SET export_status = 'succeeded', artifact_count = ?1, completed_at = ?2,
               last_error_code = NULL, updated_at = ?2
           WHERE id = ?3 AND export_status = 'running'`,
        )
        .bind(artifactCount, now, run.id)
        .run()
      return { status: 'succeeded' as const }
    }

    const artifactSequence = existingArtifactCount + 1
    const artifact = await generateAndStoreArtifact(options, run, pendingItems, artifactSequence)
    await storeArtifact(options, run, artifact, now)
    const hasMore = await hasPendingExportItems(options.database, run.id)
    if (hasMore) {
      const nextTask = await createNextExportTask(
        options.database,
        run.id,
        artifactSequence + 1,
        now,
      )
      if (options.queue) {
        try {
          await options.queue.send({ taskId: nextTask.id, inputVersion: nextTask.inputVersion })
        } catch {
          // D1 任务账本是权威来源，Cron 会补投未送达的 Queue 消息。
        }
      }
      return { status: 'succeeded' as const }
    }
    const artifactCount = await activateAndCountArtifacts(options.database, run.id, now)
    await options.database
      .prepare(
        `UPDATE export_runs
         SET export_status = 'succeeded', artifact_count = ?1, completed_at = ?2,
             last_error_code = NULL, updated_at = ?2
         WHERE id = ?3 AND export_status = 'running'`,
      )
      .bind(artifactCount, now, run.id)
      .run()
    return { status: 'succeeded' as const }
  } catch (error) {
    if (await isFinalTaskAttempt(options.database, options.taskId)) {
      const code = normalizeExportFailure(error)
      await options.database
        .prepare(
          `UPDATE export_runs
           SET export_status = 'failed', artifact_count = 0, completed_at = NULL,
               last_error_code = ?1, updated_at = ?2
           WHERE id = ?3 AND export_status <> 'deleted'`,
        )
        .bind(code, now, run.id)
        .run()
      return { status: 'needs_attention' as const, errorCode: code }
    }
    throw error
  }
}

export async function processMailExportCleanupTask(options: {
  database: D1Database
  objectStore: MailObjectStore
  exportRunId: string
  now?: number
}) {
  const now = options.now ?? Date.now()
  const run = await loadRun(options.database, options.exportRunId)
  if (!run || run.export_status === 'deleted') {
    return { status: 'succeeded' as const }
  }
  if (run.expires_at > now) throw new Error('export_cleanup_not_due')
  await expireExport(options.database, options.objectStore, run.id, now)
  return { status: 'succeeded' as const }
}

export async function getMailExportArtifact(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  exportRunId: string
  artifactId: string
  now?: number
}) {
  const now = options.now ?? Date.now()
  const row = await options.database
    .prepare(
      `SELECT artifact.id, artifact.sequence_number, artifact.object_key, artifact.file_name,
              artifact.size_bytes, hex(artifact.sha256) AS sha256_hex, artifact.artifact_status,
              run.expires_at
       FROM export_artifacts AS artifact
       JOIN export_runs AS run ON run.id = artifact.export_run_id
       WHERE artifact.id = ?1 AND artifact.export_run_id = ?2
         AND run.requested_by_user_id = ?3 AND run.export_status = 'succeeded'
       LIMIT 1`,
    )
    .bind(options.artifactId, options.exportRunId, options.userId)
    .first<ExportArtifactRow & { expires_at: number }>()
  if (!row) throw new MailExportAccessError('not_found', '导出文件不存在或无权访问')
  if (row.expires_at <= now || row.artifact_status !== 'active') {
    throw new MailExportAccessError('expired', '导出文件已经过期')
  }
  const stored = await options.objectStore.get(row.object_key)
  if (!stored) throw new MailExportAccessError('object_unavailable', '导出文件暂时无法读取')
  const digest = await sha256Bytes(stored.bytes)
  if (
    stored.bytes.byteLength !== row.size_bytes ||
    bytesToHex(digest) !== row.sha256_hex.toLowerCase()
  ) {
    throw new MailExportAccessError('object_unavailable', '导出文件完整性校验失败')
  }
  return { bytes: stored.bytes, fileName: row.file_name }
}

export async function deleteMailExport(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  exportRunId: string
  audit: AuditContext
  now?: number
}) {
  const now = options.now ?? Date.now()
  const run = await loadRun(options.database, options.exportRunId)
  if (!run || run.requested_by_user_id !== options.userId || run.export_status === 'deleted') {
    throw new MailExportAccessError('not_found', '导出任务不存在或无权操作')
  }
  if (run.export_status === 'planned' || run.export_status === 'running') {
    throw new MailExportAccessError('not_ready', '导出仍在处理中，请完成后再删除')
  }
  const artifacts = await listArtifacts(options.database, run.id)
  for (const artifact of artifacts) {
    if (artifact.artifact_status !== 'deleted')
      await options.objectStore.delete(artifact.object_key)
  }
  await options.database.batch([
    options.database
      .prepare(
        `UPDATE export_artifacts
         SET artifact_status = 'deleted', deleted_at = ?1, updated_at = ?1
         WHERE export_run_id = ?2 AND artifact_status <> 'deleted'`,
      )
      .bind(now, run.id),
    options.database
      .prepare(
        `UPDATE export_runs
         SET export_status = 'deleted', deleted_at = ?1, completed_at = NULL,
             artifact_count = 0, updated_at = ?1
         WHERE id = ?2 AND requested_by_user_id = ?3 AND export_status <> 'deleted'`,
      )
      .bind(now, run.id, options.userId),
    options.database
      .prepare(
        `UPDATE background_tasks
         SET task_status = 'cancelled', next_attempt_at = NULL, completed_at = ?1, updated_at = ?1
         WHERE target_type = 'export_run' AND target_reference = ?2
           AND task_status IN ('pending', 'retry_wait')`,
      )
      .bind(now, run.id),
    createAuditEventStatement(options.database, {
      actorType: 'user',
      actorUserId: options.userId,
      actionName: 'mail_export_deleted',
      targetType: 'export_run',
      targetReference: run.id,
      outcome: 'succeeded',
      occurredAt: now,
      ...options.audit,
    }),
  ])
}

async function generateAndStoreArtifact(
  options: {
    database: D1Database
    objectStore: MailObjectStore
    storageMode: StorageMode
  },
  run: ExportRunRow,
  items: ExportItemRow[],
  sequenceNumber: number,
): Promise<ArtifactBuild> {
  const volumeItems: Array<{
    item: ExportItemRow
    fileName: string
    bytes: Uint8Array
    sha256: Uint8Array
  }> = []
  let sourceBytes = 0
  for (const item of items) {
    const bytes = await buildExportMessage(options.database, options.objectStore, run, item)
    const digest = await sha256Bytes(bytes)
    const fileName = exportMessageFileName(item.sequence_number, item.subject)
    if (volumeItems.length > 0 && sourceBytes + bytes.byteLength > MAX_VOLUME_SOURCE_BYTES) break
    volumeItems.push({ item, fileName, bytes, sha256: digest })
    sourceBytes += bytes.byteLength
  }
  if (volumeItems.length === 0) throw new Error('export_item_too_large')
  return createZipArtifact(run, sequenceNumber, volumeItems)
}

function createZipArtifact(
  run: ExportRunRow,
  sequenceNumber: number,
  items: Array<{ item: ExportItemRow; fileName: string; bytes: Uint8Array; sha256: Uint8Array }>,
): ArtifactBuild {
  const files: Zippable = {}
  for (const value of items) files[`邮件/${value.fileName}`] = [value.bytes, { level: 0 }]
  const manifest = [
    '# 澄笺 | Simlettra 邮件导出清单',
    '',
    `- 导出编号：${run.id}`,
    `- 范围：${run.scope_type === 'personal' ? '个人邮件' : `组织邮件（${run.organization_name ?? run.organization_id ?? ''}）`}`,
    `- 本分卷：${sequenceNumber}`,
    `- 本分卷邮件数量：${items.length}`,
    `- 生成器：${ZIP_GENERATOR_VERSION}`,
    '',
    '| 序号 | 文件 | 来源 | SHA-256 |',
    '| ---: | --- | --- | --- |',
    ...items.map(
      (value) =>
        `| ${value.item.sequence_number} | ${escapeManifest(value.fileName)} | ${value.item.source_quality === 'original_mime' ? '原始 MIME' : '结构化数据重建'} | ${bytesToHex(value.sha256)} |`,
    ),
    '',
    '结构化数据重建的邮件会包含 `X-Simlettra-Export-Source: reconstructed-structured` 邮件头。',
  ].join('\n')
  files['导出清单.md'] = [new TextEncoder().encode(manifest), { level: 0 }]
  const bytes = zipSync(files, { level: 0 })
  return {
    sequenceNumber,
    fileName: `Simlettra-邮件导出-${run.id.slice(0, 8)}-${String(sequenceNumber).padStart(2, '0')}.zip`,
    bytes,
    itemResults: items.map((value) => ({
      itemId: value.item.id,
      fileName: value.fileName,
      sizeBytes: value.bytes.byteLength,
      sha256: value.sha256,
    })),
  }
}

async function storeArtifact(
  options: {
    database: D1Database
    objectStore: MailObjectStore
    storageMode: StorageMode
  },
  run: ExportRunRow,
  artifact: ArtifactBuild,
  now: number,
) {
  const objectKey = `exports/${run.id}/part-${String(artifact.sequenceNumber).padStart(4, '0')}.zip`
  const digest = await sha256Bytes(artifact.bytes)
  const operationReference = `${run.id}:${artifact.sequenceNumber}`
  const reservation = await reservePlatformCapacity({
    database: options.database,
    storageMode: options.storageMode,
    operationKind: 'mail_export',
    operationReference,
    d1EstimatedBytes: Math.max(2_048, artifact.itemResults.length * 256),
    objectEstimatedBytes: artifact.bytes.byteLength,
    now,
  })
  try {
    const backendVersion = await options.objectStore.put({
      key: objectKey,
      bytes: toArrayBuffer(artifact.bytes),
      mediaType: 'application/zip',
      sha256Hex: bytesToHex(digest),
    })
    const statements: D1PreparedStatement[] = [
      options.database
        .prepare(
          `INSERT INTO export_artifacts (
             id, export_run_id, sequence_number, object_key, storage_mode, file_name,
             media_type, size_bytes, sha256, backend_version_reference, artifact_status,
             stored_at, activated_at, deleted_at, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'application/zip', ?7, ?8, ?9,
                     'stored', ?10, NULL, NULL, ?10, ?10)`,
        )
        .bind(
          crypto.randomUUID(),
          run.id,
          artifact.sequenceNumber,
          objectKey,
          options.storageMode,
          artifact.fileName,
          artifact.bytes.byteLength,
          digest,
          backendVersion,
          now,
        ),
      ...artifact.itemResults.map((item) =>
        options.database
          .prepare(
            `UPDATE export_items
             SET item_status = 'written', artifact_sequence_number = ?1,
                 output_file_name = ?2, output_size_bytes = ?3, output_sha256 = ?4,
                 error_code = NULL, updated_at = ?5
             WHERE id = ?6 AND export_run_id = ?7 AND item_status = 'pending'`,
          )
          .bind(
            artifact.sequenceNumber,
            item.fileName,
            item.sizeBytes,
            item.sha256,
            now,
            item.itemId,
            run.id,
          ),
      ),
    ]
    await options.database.batch(statements)
    await commitPlatformCapacityReservation({ database: options.database, reservation, now })
  } catch (error) {
    await Promise.allSettled([
      options.objectStore.delete(objectKey),
      releasePlatformCapacityReservation({ database: options.database, reservation, now }),
    ])
    throw error
  }
}

async function buildExportMessage(
  database: D1Database,
  objectStore: MailObjectStore,
  run: ExportRunRow,
  item: ExportItemRow,
): Promise<Uint8Array> {
  if (item.source_quality === 'original_mime' && item.source_object_id) {
    const source = await database
      .prepare(
        `SELECT id, object_key, object_role, sequence_number, expected_size_bytes,
                actual_size_bytes, hex(COALESCE(actual_sha256, expected_sha256)) AS sha256_hex,
                media_type, untrusted_file_name
         FROM object_registry
         WHERE id = ?1 AND message_id = ?2 AND object_role IN ('raw_mime', 'final_mime')
           AND is_current = 1 AND object_status = 'active' LIMIT 1`,
      )
      .bind(item.source_object_id, item.message_id)
      .first<MessageObjectRow>()
    if (!source) throw new Error('export_source_missing')
    return readVerifiedObject(objectStore, source)
  }
  return reconstructMessage(database, objectStore, run, item)
}

async function reconstructMessage(
  database: D1Database,
  objectStore: MailObjectStore,
  run: ExportRunRow,
  item: ExportItemRow,
): Promise<Uint8Array> {
  const [addresses, objects] = await Promise.all([
    database
      .prepare(
        `SELECT address_role, display_name, address_text
         FROM message_header_addresses
         WHERE message_id = ?1
           AND (
             visibility_scope = 'header'
             OR EXISTS (
               SELECT 1 FROM messages AS authored_message
               WHERE authored_message.id = message_header_addresses.message_id
                 AND authored_message.authored_by_user_id = ?2
             )
           )
         ORDER BY CASE address_role
           WHEN 'from' THEN 0 WHEN 'sender' THEN 1 WHEN 'reply_to' THEN 2
           WHEN 'to' THEN 3 WHEN 'cc' THEN 4 ELSE 5 END,
           sequence_number, id`,
      )
      .bind(item.message_id, run.requested_by_user_id)
      .all<HeaderAddressRow>(),
    database
      .prepare(
        `SELECT id, object_key, object_role, sequence_number, expected_size_bytes,
                actual_size_bytes, hex(COALESCE(actual_sha256, expected_sha256)) AS sha256_hex,
                media_type, untrusted_file_name
         FROM object_registry
         WHERE message_id = ?1
           AND object_role IN ('plain_body', 'html_body', 'attachment')
           AND is_current = 1 AND object_status = 'active'
         ORDER BY CASE object_role WHEN 'plain_body' THEN 0 WHEN 'html_body' THEN 1 ELSE 2 END,
                  sequence_number, id`,
      )
      .bind(item.message_id)
      .all<MessageObjectRow>(),
  ])
  const sender = addresses.results.find((value) => value.address_role === 'from')
  if (!sender) throw new Error('export_sender_missing')
  const message = createMimeMessage()
  message.setSender(mailboxAddress(sender))
  setRecipients(message, addresses.results, 'to')
  setRecipients(message, addresses.results, 'cc')
  if (item.authored_by_user_id === run.requested_by_user_id)
    setRecipients(message, addresses.results, 'bcc')
  message.setSubject(item.subject)
  message.setHeader(
    'Date',
    item.header_date_text || new Date(item.header_date_at ?? item.accepted_at).toUTCString(),
  )
  if (item.internet_message_id) message.setHeader('Message-ID', item.internet_message_id)
  message.setHeader('X-Simlettra-Export-Source', 'reconstructed-structured')
  for (const object of objects.results.filter((value) => value.object_role !== 'attachment')) {
    const bytes = await readVerifiedObject(objectStore, object)
    message.addMessage({
      contentType: object.object_role === 'html_body' ? 'text/html' : 'text/plain',
      charset: 'UTF-8',
      data: new TextDecoder().decode(bytes),
    })
  }
  for (const object of objects.results.filter((value) => value.object_role === 'attachment')) {
    const bytes = await readVerifiedObject(objectStore, object)
    message.addAttachment({
      filename: safeFileName(
        object.untrusted_file_name || `attachment-${object.sequence_number + 1}`,
      ),
      contentType: object.media_type || 'application/octet-stream',
      data: bytesToBase64(bytes),
    })
  }
  if (
    !objects.results.some(
      (value) => value.object_role === 'plain_body' || value.object_role === 'html_body',
    )
  ) {
    message.addMessage({ contentType: 'text/plain', charset: 'UTF-8', data: '' })
  }
  return new TextEncoder().encode(message.asRaw())
}

function setRecipients(
  message: ReturnType<typeof createMimeMessage>,
  addresses: HeaderAddressRow[],
  role: 'to' | 'cc' | 'bcc',
) {
  const values = addresses.filter((value) => value.address_role === role).map(mailboxAddress)
  if (!values.length) return
  if (role === 'to') message.setTo(values)
  else if (role === 'cc') message.setCc(values)
  else message.setBcc(values)
}

function mailboxAddress(value: HeaderAddressRow) {
  return value.display_name
    ? { addr: value.address_text, name: value.display_name }
    : { addr: value.address_text }
}

async function readVerifiedObject(objectStore: MailObjectStore, object: MessageObjectRow) {
  const stored = await objectStore.get(object.object_key)
  if (!stored) throw new Error('export_object_unavailable')
  const bytes = new Uint8Array(stored.bytes)
  const digest = await sha256Bytes(bytes)
  if (
    bytes.byteLength !== (object.actual_size_bytes ?? object.expected_size_bytes) ||
    bytesToHex(digest) !== object.sha256_hex.toLowerCase()
  ) {
    throw new Error('export_object_damaged')
  }
  return bytes
}

async function getFrozenScopeSummary(
  database: D1Database,
  userId: string,
  scopeType: MailExportScopeType,
  organizationId: string | null,
  now: number,
) {
  const scopeCondition =
    scopeType === 'personal'
      ? `entry.mailbox_type = 'user' AND entry.user_id = ?1
         AND COALESCE(state.location_override, entry.base_location) <> 'hidden'
         AND (state.location_override IS NULL OR state.location_override <> 'trash'
              OR state.trash_due_at IS NULL OR state.trash_due_at > ?2)`
      : `entry.mailbox_type = 'organization' AND entry.organization_id = ?2`
  const row = await database
    .prepare(
      `SELECT COUNT(DISTINCT entry.message_id) AS count,
              MIN(message.sort_at) AS first_sort_at,
              MAX(message.sort_at) AS last_sort_at
       FROM mailbox_entries AS entry
       JOIN messages AS message ON message.id = entry.message_id
       JOIN message_integrity_states AS integrity
         ON integrity.message_id = message.id AND integrity.integrity_status = 'ready'
       LEFT JOIN mailbox_user_states AS state
         ON state.mailbox_entry_id = entry.id AND state.user_id = ?1
       WHERE ${scopeCondition}
       `,
    )
    .bind(userId, scopeType === 'personal' ? now : organizationId)
    .first<{ count: number; first_sort_at: number | null; last_sort_at: number | null }>()
  return {
    count: row?.count ?? 0,
    firstSortAt: row?.first_sort_at ?? null,
    lastSortAt: row?.last_sort_at ?? null,
  }
}

function buildFrozenItemsInsert(
  database: D1Database,
  runId: string,
  userId: string,
  scopeType: MailExportScopeType,
  organizationId: string | null,
  now: number,
) {
  const scopeCondition =
    scopeType === 'personal'
      ? `entry.mailbox_type = 'user' AND entry.user_id = ?2
         AND COALESCE(state.location_override, entry.base_location) <> 'hidden'
         AND (state.location_override IS NULL OR state.location_override <> 'trash'
              OR state.trash_due_at IS NULL OR state.trash_due_at > ?3)`
      : `entry.mailbox_type = 'organization' AND entry.organization_id = ?3`
  return database
    .prepare(
      `INSERT INTO export_items (
         id, export_run_id, mailbox_entry_id, message_id, sequence_number,
         source_quality, source_object_id, item_status, artifact_sequence_number,
         output_file_name, output_size_bytes, output_sha256, error_code, created_at, updated_at
       )
       SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
              ?1, entry_id, message_id, ROW_NUMBER() OVER (ORDER BY sort_at, message_id),
              CASE WHEN source_object_id IS NULL THEN 'reconstructed_structured' ELSE 'original_mime' END,
              source_object_id, 'pending', NULL, NULL, NULL, NULL, NULL, ?4, ?4
       FROM (
         SELECT MIN(entry.id) AS entry_id, entry.message_id, MIN(message.sort_at) AS sort_at,
                (
                  SELECT object.id
                  FROM object_registry AS object
                  WHERE object.message_id = entry.message_id
                    AND object.object_role IN ('raw_mime', 'final_mime')
                    AND object.is_current = 1 AND object.object_status = 'active'
                    AND (
                      NOT EXISTS (
                        SELECT 1 FROM message_header_addresses AS hidden_address
                        WHERE hidden_address.message_id = entry.message_id
                          AND hidden_address.visibility_scope = 'sender_only'
                      )
                      OR EXISTS (
                        SELECT 1 FROM messages AS source_message
                        WHERE source_message.id = entry.message_id
                          AND source_message.authored_by_user_id = ?2
                      )
                    )
                  ORDER BY CASE object.object_role WHEN 'raw_mime' THEN 0 ELSE 1 END, object.id
                  LIMIT 1
                ) AS source_object_id
         FROM mailbox_entries AS entry
         JOIN messages AS message ON message.id = entry.message_id
         JOIN message_integrity_states AS integrity
           ON integrity.message_id = message.id AND integrity.integrity_status = 'ready'
         LEFT JOIN mailbox_user_states AS state
           ON state.mailbox_entry_id = entry.id AND state.user_id = ?2
         WHERE ${scopeCondition}
         GROUP BY entry.message_id
       ) AS frozen
       ORDER BY sort_at, message_id`,
    )
    .bind(runId, userId, scopeType === 'personal' ? now : organizationId, now)
}

async function requireOrganizationCreator(
  database: D1Database,
  userId: string,
  organizationId: string,
) {
  const found = await database
    .prepare(
      `SELECT 1 AS found FROM organizations
       WHERE id = ?1 AND creator_user_id = ?2 AND status = 'active' LIMIT 1`,
    )
    .bind(organizationId, userId)
    .first<{ found: number }>()
  if (!found)
    throw new MailExportAccessError('permission_denied', '只有当前组织创建者可以导出组织邮件')
}

async function loadRun(database: D1Database, runId: string) {
  return database
    .prepare(
      `SELECT run.id, run.requested_by_user_id, run.scope_type, run.organization_id,
              organization.name AS organization_name, run.frozen_message_count,
              run.export_status, run.artifact_count, run.completed_at, run.expires_at,
              run.last_error_code, run.created_at
       FROM export_runs AS run
       LEFT JOIN organizations AS organization ON organization.id = run.organization_id
       WHERE run.id = ?1 LIMIT 1`,
    )
    .bind(runId)
    .first<ExportRunRow>()
}

async function getMailExportRun(database: D1Database, userId: string, runId: string) {
  const run = await loadRun(database, runId)
  if (!run || run.requested_by_user_id !== userId) {
    throw new MailExportAccessError('not_found', '导出任务不存在')
  }
  const artifacts = (await listArtifacts(database, runId))
    .filter((value) => value.artifact_status === 'active')
    .map((value) => ({
      id: value.id,
      sequenceNumber: value.sequence_number,
      fileName: value.file_name,
      sizeBytes: value.size_bytes,
      downloadUrl: `/api/auth/mail-exports/${run.id}/artifacts/${value.id}`,
    }))
  return mapRun(run, artifacts)
}

async function loadPendingExportItems(database: D1Database, runId: string) {
  const rows = await database
    .prepare(
      `SELECT item.id, item.mailbox_entry_id, item.message_id, item.sequence_number,
              item.source_quality, item.source_object_id, message.subject,
              message.header_date_text, message.header_date_at, message.accepted_at,
              message.internet_message_id, message.authored_by_user_id
       FROM export_items AS item
       JOIN messages AS message ON message.id = item.message_id
       WHERE item.export_run_id = ?1 AND item.item_status = 'pending'
       ORDER BY item.sequence_number
       LIMIT ?2`,
    )
    .bind(runId, PENDING_ITEM_QUERY_LIMIT)
    .all<ExportItemRow>()
  return rows.results
}

async function hasPendingExportItems(database: D1Database, runId: string) {
  const row = await database
    .prepare(
      `SELECT 1 AS found FROM export_items WHERE export_run_id = ?1 AND item_status = 'pending' LIMIT 1`,
    )
    .bind(runId)
    .first<{ found: number }>()
  return Boolean(row)
}

async function countExportArtifacts(database: D1Database, runId: string) {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM export_artifacts WHERE export_run_id = ?1 AND artifact_status IN ('stored', 'active')`,
    )
    .bind(runId)
    .first<{ count: number }>()
  return row?.count ?? 0
}

async function activateAndCountArtifacts(database: D1Database, runId: string, now: number) {
  await database
    .prepare(
      `UPDATE export_artifacts
       SET artifact_status = 'active', activated_at = COALESCE(activated_at, ?1), updated_at = ?1
       WHERE export_run_id = ?2 AND artifact_status = 'stored'`,
    )
    .bind(now, runId)
    .run()
  return countExportArtifacts(database, runId)
}

async function createNextExportTask(
  database: D1Database,
  runId: string,
  sequenceNumber: number,
  now: number,
) {
  const taskId = crypto.randomUUID()
  const digest = await sha256Bytes(`generate_mail_export\n${runId}\n${sequenceNumber}`)
  await database
    .prepare(
      `INSERT OR IGNORE INTO background_tasks (
         id, task_type, target_type, target_reference, input_version,
         task_key_digest, task_status, priority, attempt_count, max_attempts,
         next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
         last_error_code, last_error_summary, last_error_at, completed_at, created_at, updated_at
       ) VALUES (?1, 'generate_mail_export', 'export_run', ?2, ?3, ?4, 'pending', 5, 0, ?5,
                 ?6, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?6, ?6)`,
    )
    .bind(taskId, runId, sequenceNumber, digest, EXPORT_TASK_MAX_ATTEMPTS, now)
    .run()
  const row = await database
    .prepare(
      `SELECT id, input_version
       FROM background_tasks
       WHERE task_key_digest = ?1
       LIMIT 1`,
    )
    .bind(digest)
    .first<{ id: string; input_version: number }>()
  if (!row) throw new Error('export_next_task_missing')
  return { id: row.id, inputVersion: row.input_version }
}

async function listArtifacts(database: D1Database, runId: string) {
  const rows = await database
    .prepare(
      `SELECT id, sequence_number, object_key, file_name, size_bytes,
              hex(sha256) AS sha256_hex, artifact_status
       FROM export_artifacts WHERE export_run_id = ?1 ORDER BY sequence_number`,
    )
    .bind(runId)
    .all<ExportArtifactRow>()
  return rows.results
}

async function expireExport(
  database: D1Database,
  objectStore: MailObjectStore,
  runId: string,
  now: number,
) {
  const artifacts = await listArtifacts(database, runId)
  for (const artifact of artifacts) {
    if (artifact.artifact_status !== 'deleted') await objectStore.delete(artifact.object_key)
  }
  await database.batch([
    database
      .prepare(
        `UPDATE export_artifacts SET artifact_status = 'deleted', deleted_at = ?1, updated_at = ?1
         WHERE export_run_id = ?2 AND artifact_status <> 'deleted'`,
      )
      .bind(now, runId),
    database
      .prepare(
        `UPDATE export_runs
         SET export_status = 'expired', artifact_count = 0, completed_at = NULL, updated_at = ?1
         WHERE id = ?2 AND export_status <> 'deleted'`,
      )
      .bind(now, runId),
  ])
}

function mapRun(
  run: ExportRunRow,
  artifacts: MailExportRunSummary['artifacts'],
): MailExportRunSummary {
  return {
    id: run.id,
    scopeType: run.scope_type,
    organization:
      run.organization_id && run.organization_name
        ? { id: run.organization_id, name: run.organization_name }
        : null,
    frozenMessageCount: run.frozen_message_count,
    status: run.export_status as MailExportRunSummary['status'],
    artifactCount: run.artifact_count,
    artifacts,
    errorCode: run.last_error_code,
    createdAt: run.created_at,
    completedAt: run.completed_at,
    expiresAt: run.expires_at,
  }
}

function parseScopeType(value: unknown): MailExportScopeType {
  if (value === 'personal' || value === 'organization') return value
  throw new MailExportInputError('scopeType', '请选择个人邮件或组织邮件')
}

function parseOrganizationId(scopeType: MailExportScopeType, value: unknown) {
  if (scopeType === 'personal') return null
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new MailExportInputError('organizationId', '请选择需要导出的组织')
  }
  return value
}

function backgroundTaskStatement(
  database: D1Database,
  task: {
    id: string
    taskType: string
    targetType: string
    targetReference: string
    inputVersion: number
    digest: Uint8Array
    priority: number
    maxAttempts: number
    nextAttemptAt: number
    now: number
  },
) {
  return database
    .prepare(
      `INSERT INTO background_tasks (
         id, task_type, target_type, target_reference, input_version,
         task_key_digest, task_status, priority, attempt_count, max_attempts,
         next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
         last_error_code, last_error_summary, last_error_at, completed_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, 0, ?8,
                 ?9, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?10, ?10)`,
    )
    .bind(
      task.id,
      task.taskType,
      task.targetType,
      task.targetReference,
      task.inputVersion,
      task.digest,
      task.priority,
      task.maxAttempts,
      task.nextAttemptAt,
      task.now,
    )
}

async function isFinalTaskAttempt(database: D1Database, taskId: string) {
  const row = await database
    .prepare(`SELECT attempt_count, max_attempts FROM background_tasks WHERE id = ?1 LIMIT 1`)
    .bind(taskId)
    .first<{ attempt_count: number; max_attempts: number }>()
  return !row || row.attempt_count >= row.max_attempts
}

function normalizeExportFailure(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  if (/^[a-z0-9_]{1,80}$/u.test(text)) return text
  return 'mail_export_failed'
}

function exportMessageFileName(sequence: number, subject: string) {
  const safeSubject = safeFileName(subject || '无主题').slice(0, 80)
  return `${String(sequence).padStart(6, '0')}-${safeSubject}.eml`
}

function safeFileName(value: string) {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, '_')
    .trim()
  return normalized.replace(/[. ]+$/u, '').slice(0, 120) || '未命名'
}

function escapeManifest(value: string) {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
