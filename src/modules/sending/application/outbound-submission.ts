import type { MailObjectStore } from '../../mail-receiving/public'
import { sha256Bytes } from '../../mail-receiving/domain/content-digest'
import { decryptOutboundCredential, OutboundConfigurationError } from './outbound-management'
import { submitOutboundProviderMessage, type OutboundProviderResult } from './outbound-provider'

const OBJECT_READ_RETRY_DELAY_MS = 60_000
const CREDENTIAL_RETRY_DELAY_MS = 5 * 60_000

type OutboundSendTaskResult =
  | { status: 'succeeded' }
  | { status: 'retry'; nextAttemptAt: number; errorCode: string }
  | { status: 'needs_attention'; errorCode: string }

type RecipientSubmissionResult =
  { status: 'completed' } | { status: 'retry'; nextAttemptAt: number; errorCode: string }

interface SubmissionOperationRow {
  id: string
  workflow_status: string
  message_id: string
  payload_sha256: ArrayBuffer
  payload_size_bytes: number
  sender_address: string
  sender_display_name: string | null
  subject: string
  internet_message_id: string | null
  body_format: 'plain_text' | 'rich_text'
  body_object_key: string
}

interface SubmissionRecipientRow {
  id: string
  recipient_role: 'to' | 'cc' | 'bcc'
  address_text: string
  delivery_status: string
  status_version: number
  next_priority_number: number
  progress_status: string
  last_attempt_id: string | null
  last_switch_reason: string | null
}

interface RouteEntryRow {
  id: string
  priority_number: number
  provider_type: 'resend' | 'smtp2go'
  configuration_key: string
  configuration_version: number
  credential_ciphertext: ArrayBuffer
  credential_nonce: ArrayBuffer
  configuration_status: string
}

interface AttachmentRow {
  object_key: string
  untrusted_file_name: string | null
  media_type: string
}

export async function processOutboundSendTask(options: {
  database: D1Database
  objectStore: MailObjectStore
  encryptionKeyBase64?: string
  sendOperationId: string
  fetcher?: typeof fetch
  now?: number
}): Promise<OutboundSendTaskResult> {
  const now = options.now ?? Date.now()
  const operation = await loadOperation(options.database, options.sendOperationId)
  if (!operation) return { status: 'needs_attention', errorCode: 'send_operation_not_found' }
  if (operation.workflow_status === 'finished') return { status: 'succeeded' }
  let bodyStored
  try {
    bodyStored = await options.objectStore.get(operation.body_object_key)
  } catch {
    return retryResult(now, OBJECT_READ_RETRY_DELAY_MS, 'send_body_read_failed')
  }
  if (!bodyStored) {
    return retryResult(now, OBJECT_READ_RETRY_DELAY_MS, 'send_body_temporarily_unavailable')
  }
  const attachments = await loadAttachments(options.database, operation.message_id)
  const attachmentPayloads: Array<{ fileName: string; mediaType: string; content: string }> = []
  for (const attachment of attachments) {
    let stored
    try {
      stored = await options.objectStore.get(attachment.object_key)
    } catch {
      return retryResult(now, OBJECT_READ_RETRY_DELAY_MS, 'send_attachment_read_failed')
    }
    if (!stored) {
      return retryResult(now, OBJECT_READ_RETRY_DELAY_MS, 'send_attachment_temporarily_unavailable')
    }
    attachmentPayloads.push({
      fileName: attachment.untrusted_file_name || 'attachment',
      mediaType: attachment.media_type,
      content: bytesToBase64(new Uint8Array(stored.bytes)),
    })
  }
  const body = new TextDecoder().decode(bodyStored.bytes)
  const recipients = await loadRecipients(options.database, operation.id)
  for (const recipient of recipients) {
    if (!['waiting', 'submitting'].includes(recipient.delivery_status)) continue
    if (recipient.delivery_status === 'submitting' || recipient.progress_status === 'submitting') {
      await markInterruptedAttemptUnknown(options.database, recipient, now)
      continue
    }
    const submission = await submitRecipient({
      ...options,
      fetcher: options.fetcher ?? fetch,
      operation,
      recipient,
      body,
      attachments: attachmentPayloads,
    })
    if (submission.status === 'retry') return submission
  }
  await finishOperationIfSettled(options.database, operation.id, now)
  return { status: 'succeeded' }
}

async function submitRecipient(options: {
  database: D1Database
  objectStore: MailObjectStore
  encryptionKeyBase64?: string
  fetcher: typeof fetch
  operation: SubmissionOperationRow
  recipient: SubmissionRecipientRow
  body: string
  attachments: Array<{ fileName: string; mediaType: string; content: string }>
  now?: number
}): Promise<RecipientSubmissionResult> {
  let recipient = options.recipient
  while (recipient.delivery_status === 'waiting') {
    const entry = await loadRouteEntry(
      options.database,
      options.operation.id,
      recipient.next_priority_number,
    )
    if (!entry) {
      await markRecipientFailed(
        options.database,
        recipient,
        'outbound_route_exhausted',
        options.now ?? Date.now(),
      )
      return { status: 'completed' }
    }
    if (entry.configuration_status === 'disabled') {
      recipient = await moveToFallback(
        options.database,
        recipient,
        null,
        'configuration_disabled',
        options.now ?? Date.now(),
      )
      continue
    }
    let credential: string
    try {
      credential = await decryptOutboundCredential({
        ...(options.encryptionKeyBase64
          ? { encryptionKeyBase64: options.encryptionKeyBase64 }
          : {}),
        configurationKey: entry.configuration_key,
        configurationVersion: entry.configuration_version,
        ciphertext: entry.credential_ciphertext,
        nonce: entry.credential_nonce,
      })
    } catch (error) {
      return retryResult(
        options.now ?? Date.now(),
        CREDENTIAL_RETRY_DELAY_MS,
        error instanceof OutboundConfigurationError && error.field === 'encryptionKey'
          ? 'outbound_config_key_unavailable'
          : 'outbound_credential_decryption_failed',
      )
    }
    // 只有真正准备调用供应商之后，才把收件人推进到 submitting。
    // 这样配置或密文错误不会被下一次任务误判为“供应商结果未知”。
    const attempt = await prepareAttempt(
      options.database,
      options.operation,
      recipient,
      entry,
      options.now ?? Date.now(),
    )
    const result = await callProvider({
      fetcher: options.fetcher,
      providerType: entry.provider_type,
      credential,
      attemptId: attempt.id,
      operation: options.operation,
      recipient,
      body: options.body,
      attachments: options.attachments,
    })
    const now = options.now ?? Date.now()
    if (result.kind === 'accepted') {
      await markAccepted(options.database, recipient, attempt.id, result.submissionId, now)
      return { status: 'completed' }
    }
    if (result.kind === 'unknown') {
      await markUnknown(options.database, recipient, attempt.id, result.code, now)
      return { status: 'completed' }
    }
    const hasFallback = await hasRouteEntry(
      options.database,
      options.operation.id,
      recipient.next_priority_number + 1,
    )
    if (result.retryWithFallback && hasFallback) {
      recipient = await moveToFallback(
        options.database,
        recipient,
        attempt.id,
        result.code === 'configuration_rejected' ? 'configuration_disabled' : 'temporary_rejection',
        now,
      )
      continue
    }
    await markNotAcceptedFailed(options.database, recipient, attempt.id, result.code, now)
    return { status: 'completed' }
  }
  return { status: 'completed' }
}

function retryResult(
  now: number,
  delayMs: number,
  errorCode: string,
): Extract<OutboundSendTaskResult, { status: 'retry' }> {
  return { status: 'retry', nextAttemptAt: now + delayMs, errorCode }
}

async function loadOperation(
  database: D1Database,
  operationId: string,
): Promise<SubmissionOperationRow | null> {
  return database
    .prepare(
      `SELECT operation.id, operation.workflow_status, operation.message_id,
              operation.payload_sha256, operation.payload_size_bytes,
              sender.canonical_address AS sender_address,
              COALESCE(preference.sender_display_name, user.display_name, organization.name)
                AS sender_display_name,
              message.subject, message.internet_message_id,
              CASE body.object_role WHEN 'html_body' THEN 'rich_text' ELSE 'plain_text' END
                AS body_format,
              body.object_key AS body_object_key
       FROM send_operations operation
       JOIN messages message ON message.id = operation.message_id
       JOIN email_addresses sender ON sender.id = operation.sender_address_id
       LEFT JOIN users user ON user.id = operation.sent_user_id
       LEFT JOIN organizations organization ON organization.id = operation.sent_organization_id
       LEFT JOIN user_address_preferences preference
         ON preference.user_id = operation.operator_user_id
        AND preference.address_id = operation.sender_address_id
       JOIN object_registry body
         ON body.message_id = operation.message_id
        AND body.object_role IN ('plain_body', 'html_body')
        AND body.object_status = 'active' AND body.is_current = 1
       WHERE operation.id = ?1 LIMIT 1`,
    )
    .bind(operationId)
    .first<SubmissionOperationRow>()
}

async function loadRecipients(
  database: D1Database,
  operationId: string,
): Promise<SubmissionRecipientRow[]> {
  const rows = await database
    .prepare(
      `SELECT recipient.id, recipient.recipient_role, recipient.address_text,
              recipient.delivery_status, recipient.status_version,
              progress.next_priority_number, progress.progress_status,
              progress.last_attempt_id, progress.last_switch_reason
       FROM send_recipients recipient
       JOIN send_recipient_route_progress progress ON progress.send_recipient_id = recipient.id
       WHERE recipient.send_operation_id = ?1 AND recipient.route_channel = 'external'
       ORDER BY recipient.recipient_role, recipient.sequence_number, recipient.id`,
    )
    .bind(operationId)
    .all<SubmissionRecipientRow>()
  return rows.results
}

async function loadAttachments(database: D1Database, messageId: string): Promise<AttachmentRow[]> {
  const rows = await database
    .prepare(
      `SELECT object_key, untrusted_file_name, media_type
       FROM object_registry WHERE message_id = ?1 AND object_role = 'attachment'
         AND object_status = 'active' AND is_current = 1
       ORDER BY sequence_number, id`,
    )
    .bind(messageId)
    .all<AttachmentRow>()
  return rows.results
}

async function loadRouteEntry(
  database: D1Database,
  operationId: string,
  priority: number,
): Promise<RouteEntryRow | null> {
  return database
    .prepare(
      `SELECT entry.id, entry.priority_number, entry.provider_type,
              entry.configuration_key, entry.configuration_version,
              config.credential_ciphertext, config.credential_nonce,
              config.configuration_status
       FROM send_operations operation
       JOIN outbound_route_snapshot_entries entry
         ON entry.route_snapshot_id = operation.outbound_route_snapshot_id
        AND entry.priority_number = ?2
       JOIN outbound_provider_configs config ON config.id = entry.provider_config_id
       WHERE operation.id = ?1 LIMIT 1`,
    )
    .bind(operationId, priority)
    .first<RouteEntryRow>()
}

async function hasRouteEntry(database: D1Database, operationId: string, priority: number) {
  return Boolean(await loadRouteEntry(database, operationId, priority))
}

async function prepareAttempt(
  database: D1Database,
  operation: SubmissionOperationRow,
  recipient: SubmissionRecipientRow,
  entry: RouteEntryRow,
  now: number,
) {
  const next = await database
    .prepare(
      `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
       FROM outbound_submission_attempts WHERE send_operation_id = ?1`,
    )
    .bind(operation.id)
    .first<{ attempt_number: number }>()
  const attemptNumber = next?.attempt_number ?? 1
  const id = crypto.randomUUID()
  const idempotencyKey = `simlettra-${id}`
  const idempotencyDigest =
    entry.provider_type === 'resend' ? await sha256Bytes(idempotencyKey) : null
  const newVersion = recipient.status_version + 1
  const selectionKind = attemptNumber === 1 ? 'initial' : 'fallback'
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO outbound_submission_attempts (
          id, send_operation_id, route_snapshot_entry_id, attempt_number,
          attempt_status, payload_sha256, payload_size_bytes,
          idempotency_key_digest, provider_submission_id, started_at,
          completed_at, error_code, error_summary, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, 'prepared', ?5, ?6, ?7,
                   NULL, NULL, NULL, NULL, NULL, ?8, ?8)`,
      )
      .bind(
        id,
        operation.id,
        entry.id,
        attemptNumber,
        operation.payload_sha256,
        operation.payload_size_bytes,
        idempotencyDigest,
        now,
      ),
    database
      .prepare(
        `INSERT INTO outbound_submission_attempt_recipients (
          outbound_submission_attempt_id, send_recipient_id, selection_kind,
          fallback_reason, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(
        id,
        recipient.id,
        selectionKind,
        selectionKind === 'fallback' ? recipient.last_switch_reason || 'temporary_rejection' : null,
        now,
      ),
    database
      .prepare(
        `UPDATE outbound_submission_attempts
         SET attempt_status = 'submitting', started_at = ?1, updated_at = ?1
         WHERE id = ?2 AND attempt_status = 'prepared'`,
      )
      .bind(now, id),
    database
      .prepare(
        `UPDATE send_recipients
         SET delivery_status = 'submitting', status_version = ?1,
             status_updated_at = ?2, updated_at = ?2
         WHERE id = ?3 AND delivery_status = 'waiting' AND status_version = ?4`,
      )
      .bind(newVersion, now, recipient.id, recipient.status_version),
    database
      .prepare(
        `INSERT INTO send_recipient_status_history (
          id, send_recipient_id, previous_status, new_status, status_version,
          source_type, source_reference, occurred_at, created_at
         ) VALUES (?1, ?2, 'waiting', 'submitting', ?3,
                   'provider_attempt', ?4, ?5, ?5)`,
      )
      .bind(crypto.randomUUID(), recipient.id, newVersion, id, now),
    database
      .prepare(
        `UPDATE send_recipient_route_progress
         SET selected_route_snapshot_entry_id = ?1, progress_status = 'submitting',
             last_attempt_id = ?2, updated_at = ?3
         WHERE send_recipient_id = ?4 AND progress_status = 'ready'
           AND next_priority_number = ?5`,
      )
      .bind(entry.id, id, now, recipient.id, recipient.next_priority_number),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('域外发信提交状态已经发生变化')
  }
  return { id, idempotencyKey }
}

async function callProvider(options: {
  fetcher: typeof fetch
  providerType: 'resend' | 'smtp2go'
  credential: string
  attemptId: string
  operation: SubmissionOperationRow
  recipient: SubmissionRecipientRow
  body: string
  attachments: Array<{ fileName: string; mediaType: string; content: string }>
}): Promise<OutboundProviderResult> {
  return submitOutboundProviderMessage({
    fetcher: options.fetcher,
    providerType: options.providerType,
    credential: options.credential,
    idempotencyKey: `simlettra-${options.attemptId}`,
    message: {
      senderDisplayName: options.operation.sender_display_name,
      senderAddress: options.operation.sender_address,
      recipientAddress: options.recipient.address_text,
      subject: options.operation.subject,
      ...(options.operation.body_format === 'rich_text'
        ? { html: options.body }
        : { text: options.body }),
      headers: options.operation.internet_message_id
        ? { 'Message-ID': options.operation.internet_message_id }
        : {},
      attachments: options.attachments,
    },
  })
}

async function markAccepted(
  database: D1Database,
  recipient: SubmissionRecipientRow,
  attemptId: string,
  providerSubmissionId: string | null,
  now: number,
): Promise<void> {
  const version = recipient.status_version + 2
  await database.batch([
    finishAttemptStatement(database, attemptId, 'accepted', providerSubmissionId, null, now),
    database
      .prepare(
        `UPDATE send_recipients
         SET delivery_status = 'submitted', status_version = ?1,
             status_updated_at = ?2, last_provider_reference = ?3,
             failure_code = NULL, failure_detail = NULL, updated_at = ?2
         WHERE id = ?4 AND delivery_status = 'submitting' AND status_version = ?5`,
      )
      .bind(version, now, providerSubmissionId, recipient.id, recipient.status_version + 1),
    statusHistoryStatement(
      database,
      recipient.id,
      'submitting',
      'submitted',
      version,
      attemptId,
      now,
    ),
    database
      .prepare(
        `UPDATE send_recipient_route_progress
         SET progress_status = 'accepted', updated_at = ?1
         WHERE send_recipient_id = ?2 AND progress_status = 'submitting'
           AND last_attempt_id = ?3`,
      )
      .bind(now, recipient.id, attemptId),
    database
      .prepare(
        `UPDATE domain_monthly_usage_reservations
         SET usage_status = 'committed', committed_at = ?1, updated_at = ?1
         WHERE send_recipient_id = ?2 AND usage_status = 'reserved'`,
      )
      .bind(now, recipient.id),
  ])
}

async function markUnknown(
  database: D1Database,
  recipient: SubmissionRecipientRow,
  attemptId: string,
  code: string,
  now: number,
): Promise<void> {
  const version = recipient.status_version + 2
  await database.batch([
    finishAttemptStatement(database, attemptId, 'unknown', null, code, now),
    database
      .prepare(
        `UPDATE send_recipients
         SET delivery_status = 'unknown', status_version = ?1,
             status_updated_at = ?2, failure_code = ?3,
             failure_detail = '供应商是否接受邮件暂时无法判断', updated_at = ?2
         WHERE id = ?4 AND delivery_status = 'submitting' AND status_version = ?5`,
      )
      .bind(version, now, code, recipient.id, recipient.status_version + 1),
    statusHistoryStatement(
      database,
      recipient.id,
      'submitting',
      'unknown',
      version,
      attemptId,
      now,
    ),
    database
      .prepare(
        `UPDATE send_recipient_route_progress
         SET progress_status = 'unknown', updated_at = ?1
         WHERE send_recipient_id = ?2 AND progress_status = 'submitting'
           AND last_attempt_id = ?3`,
      )
      .bind(now, recipient.id, attemptId),
    database
      .prepare(
        `UPDATE domain_monthly_usage_reservations
         SET usage_status = 'unknown_held', unknown_at = ?1, updated_at = ?1
         WHERE send_recipient_id = ?2 AND usage_status = 'reserved'`,
      )
      .bind(now, recipient.id),
  ])
}

async function markInterruptedAttemptUnknown(
  database: D1Database,
  recipient: SubmissionRecipientRow,
  now: number,
): Promise<void> {
  if (!recipient.last_attempt_id) {
    await markRecipientFailed(database, recipient, 'submission_state_incomplete', now)
    return
  }
  const attempt = await database
    .prepare(`SELECT attempt_status FROM outbound_submission_attempts WHERE id = ?1 LIMIT 1`)
    .bind(recipient.last_attempt_id)
    .first<{ attempt_status: string }>()
  if (attempt?.attempt_status !== 'submitting') return
  const originalVersion = recipient.status_version - 1
  await markUnknown(
    database,
    { ...recipient, status_version: originalVersion },
    recipient.last_attempt_id,
    'interrupted_submission_result_unknown',
    now,
  )
}

async function moveToFallback(
  database: D1Database,
  recipient: SubmissionRecipientRow,
  attemptId: string | null,
  reason: 'temporary_rejection' | 'configuration_disabled',
  now: number,
): Promise<SubmissionRecipientRow> {
  if (attemptId) {
    const submittingVersion = recipient.status_version + 1
    const waitingVersion = submittingVersion + 1
    await database.batch([
      finishAttemptStatement(database, attemptId, 'not_accepted', null, reason, now),
      database
        .prepare(
          `UPDATE send_recipients
           SET delivery_status = 'waiting', status_version = ?1,
               status_updated_at = ?2, failure_code = ?3,
               failure_detail = '默认服务明确未接受，准备尝试备用服务', updated_at = ?2
           WHERE id = ?4 AND delivery_status = 'submitting' AND status_version = ?5`,
        )
        .bind(waitingVersion, now, reason, recipient.id, submittingVersion),
      statusHistoryStatement(
        database,
        recipient.id,
        'submitting',
        'waiting',
        waitingVersion,
        attemptId,
        now,
      ),
      database
        .prepare(
          `UPDATE send_recipient_route_progress
           SET next_priority_number = next_priority_number + 1,
               selected_route_snapshot_entry_id = NULL,
               progress_status = 'ready', last_switch_reason = ?1, updated_at = ?2
           WHERE send_recipient_id = ?3 AND progress_status = 'submitting'
             AND last_attempt_id = ?4`,
        )
        .bind(reason, now, recipient.id, attemptId),
    ])
    return {
      ...recipient,
      delivery_status: 'waiting',
      status_version: waitingVersion,
      next_priority_number: recipient.next_priority_number + 1,
      progress_status: 'ready',
      last_attempt_id: attemptId,
      last_switch_reason: reason,
    }
  }
  await database
    .prepare(
      `UPDATE send_recipient_route_progress
       SET next_priority_number = next_priority_number + 1,
           selected_route_snapshot_entry_id = NULL,
           progress_status = 'ready', last_switch_reason = ?1, updated_at = ?2
       WHERE send_recipient_id = ?3 AND progress_status = 'ready'`,
    )
    .bind(reason, now, recipient.id)
    .run()
  return {
    ...recipient,
    next_priority_number: recipient.next_priority_number + 1,
    last_switch_reason: reason,
  }
}

async function markNotAcceptedFailed(
  database: D1Database,
  recipient: SubmissionRecipientRow,
  attemptId: string,
  code: string,
  now: number,
): Promise<void> {
  const version = recipient.status_version + 2
  await database.batch([
    finishAttemptStatement(database, attemptId, 'not_accepted', null, code, now),
    database
      .prepare(
        `UPDATE send_recipients
         SET delivery_status = 'failed', status_version = ?1,
             status_updated_at = ?2, failure_code = ?3,
             failure_detail = '发信服务明确拒绝了这名收件人', updated_at = ?2
         WHERE id = ?4 AND delivery_status = 'submitting' AND status_version = ?5`,
      )
      .bind(version, now, code, recipient.id, recipient.status_version + 1),
    statusHistoryStatement(database, recipient.id, 'submitting', 'failed', version, attemptId, now),
    database
      .prepare(
        `UPDATE send_recipient_route_progress
         SET progress_status = 'finished', updated_at = ?1
         WHERE send_recipient_id = ?2 AND progress_status = 'submitting'
           AND last_attempt_id = ?3`,
      )
      .bind(now, recipient.id, attemptId),
    database
      .prepare(
        `UPDATE domain_monthly_usage_reservations
         SET usage_status = 'released', released_at = ?1, updated_at = ?1
         WHERE send_recipient_id = ?2 AND usage_status = 'reserved'`,
      )
      .bind(now, recipient.id),
  ])
}

async function markRecipientFailed(
  database: D1Database,
  recipient: SubmissionRecipientRow,
  code: string,
  now: number,
): Promise<void> {
  const version = recipient.status_version + 1
  await database.batch([
    database
      .prepare(
        `UPDATE send_recipients
         SET delivery_status = 'failed', status_version = ?1,
             status_updated_at = ?2, failure_code = ?3,
             failure_detail = '没有剩余可用的域外发信服务', updated_at = ?2
         WHERE id = ?4 AND delivery_status = 'waiting' AND status_version = ?5`,
      )
      .bind(version, now, code, recipient.id, recipient.status_version),
    statusHistoryStatement(
      database,
      recipient.id,
      'waiting',
      'failed',
      version,
      `route:${recipient.next_priority_number}`,
      now,
    ),
    database
      .prepare(
        `UPDATE send_recipient_route_progress
         SET progress_status = 'finished', updated_at = ?1
         WHERE send_recipient_id = ?2 AND progress_status = 'ready'`,
      )
      .bind(now, recipient.id),
    database
      .prepare(
        `UPDATE domain_monthly_usage_reservations
         SET usage_status = 'released', released_at = ?1, updated_at = ?1
         WHERE send_recipient_id = ?2 AND usage_status = 'reserved'`,
      )
      .bind(now, recipient.id),
  ])
}

function finishAttemptStatement(
  database: D1Database,
  attemptId: string,
  status: 'accepted' | 'not_accepted' | 'unknown',
  submissionId: string | null,
  errorCode: string | null,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE outbound_submission_attempts
       SET attempt_status = ?1, provider_submission_id = ?2,
           completed_at = ?3, error_code = ?4,
           error_summary = ?5, updated_at = ?3
       WHERE id = ?6 AND attempt_status = 'submitting'`,
    )
    .bind(
      status,
      submissionId,
      now,
      errorCode,
      errorCode ? '域外发信服务没有明确接受本次提交' : null,
      attemptId,
    )
}

function statusHistoryStatement(
  database: D1Database,
  recipientId: string,
  previousStatus: string,
  nextStatus: string,
  version: number,
  sourceReference: string,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO send_recipient_status_history (
        id, send_recipient_id, previous_status, new_status, status_version,
        source_type, source_reference, occurred_at, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'provider_attempt', ?6, ?7, ?7)`,
    )
    .bind(
      crypto.randomUUID(),
      recipientId,
      previousStatus,
      nextStatus,
      version,
      `${sourceReference}:${nextStatus}`,
      now,
    )
}

async function finishOperationIfSettled(
  database: D1Database,
  operationId: string,
  now: number,
): Promise<void> {
  await database
    .prepare(
      `UPDATE send_operations
       SET workflow_status = 'finished', updated_at = ?1
       WHERE id = ?2 AND workflow_status = 'processing'
         AND NOT EXISTS (
           SELECT 1 FROM send_recipients
           WHERE send_operation_id = ?2 AND route_channel = 'external'
             AND delivery_status IN ('waiting', 'submitting')
         )`,
    )
    .bind(now, operationId)
    .run()
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
