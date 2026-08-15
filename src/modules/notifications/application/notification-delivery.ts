import type { BackgroundTaskMessage } from '../../../shared/contracts/background-task'
import type { NotificationChannelType } from '../../../shared/contracts/notifications'
import { equalBytes, sha256Bytes } from '../../mail-receiving/domain/content-digest'
import type { MailObjectStore } from '../../mail-receiving/public'
import type { BackgroundTaskExecutionResult } from '../../tasks/application/background-task-service'
import {
  decryptNotificationCredential,
  NotificationCredentialError,
} from './notification-credential'
import {
  notificationPayloadLimitError,
  submitNotificationToChannel,
  type NotificationChannelResult,
} from './notification-channel'

const NOTIFICATION_PAYLOAD_VERSION = 1
const NOTIFICATION_TASK_MAX_ATTEMPTS = 3

export interface NotificationMessageAddress {
  role: 'from' | 'sender' | 'reply_to' | 'to' | 'cc' | 'bcc'
  displayName: string | null
  address: string
}

export interface NotificationDeliveryCandidate {
  deliveryId: string
  addressBindingId: string
  actualAddress: string
}

export interface PreparedNotificationWork {
  statements: D1PreparedStatement[]
  messages: BackgroundTaskMessage[]
}

interface SubscriptionMatchRow {
  notification_subscription_id: string
  address_binding_id: string
}

interface OperationRow {
  id: string
  operation_status: string
}

interface ExecutionRow {
  id: string
  operation_status: string
  notification_subscription_id: string
  channel_type: NotificationChannelType
  public_options_json: string
  credential_ciphertext: ArrayBuffer
  credential_nonce: ArrayBuffer
  message_id: string
  subject: string
  display_recipient_address: string
  payload_object_set_version: number
  payload_size_bytes: number
  payload_sha256: ArrayBuffer
}

interface BodyObjectRow {
  object_key: string
  object_role: 'plain_body' | 'html_body'
  expected_size_bytes: number
  expected_sha256: ArrayBuffer
}

interface HeaderAddressRow {
  address_role: NotificationMessageAddress['role']
  display_name: string | null
  address_text: string
}

interface TaskAttemptRow {
  attempt_count: number
  max_attempts: number
}

export async function prepareNotificationWork(options: {
  database: D1Database
  subject: string
  addresses: NotificationMessageAddress[]
  bodyFormat: 'plain_text' | 'rich_text'
  body: string
  deliveries: NotificationDeliveryCandidate[]
  objectSetVersion: number
  now: number
}): Promise<PreparedNotificationWork> {
  if (options.deliveries.length === 0) return { statements: [], messages: [] }
  const matches = await findSubscriptionMatches(
    options.database,
    options.deliveries.map((delivery) => delivery.addressBindingId),
  )
  if (matches.length === 0) return { statements: [], messages: [] }
  const plainBody =
    options.bodyFormat === 'plain_text'
      ? normalizePlainText(options.body)
      : await extractVisibleTextFromHtml(options.body)
  const deliveryByBinding = new Map(
    options.deliveries.map((delivery) => [delivery.addressBindingId, delivery]),
  )
  const statements: D1PreparedStatement[] = []
  const messages: BackgroundTaskMessage[] = []
  const seen = new Set<string>()
  for (const match of matches) {
    const delivery = deliveryByBinding.get(match.address_binding_id)
    if (!delivery) continue
    const uniqueKey = `${match.notification_subscription_id}:${delivery.deliveryId}`
    if (seen.has(uniqueKey)) continue
    seen.add(uniqueKey)
    const payload = formatNotificationPayload({
      subject: options.subject,
      addresses: options.addresses,
      actualAddress: delivery.actualAddress,
      body: plainBody,
    })
    const payloadBytes = new TextEncoder().encode(payload)
    const payloadDigest = await sha256Bytes(payloadBytes)
    const operationId = crypto.randomUUID()
    const taskId = crypto.randomUUID()
    const taskDigest = await sha256Bytes(`notification_send\n${operationId}\n1`)
    statements.push(
      options.database
        .prepare(
          `INSERT INTO notification_operations (
            id, notification_subscription_id, message_delivery_id,
            payload_format_version, payload_object_set_version,
            payload_size_bytes, payload_sha256, operation_status,
            provider_reference, error_code, error_summary,
            created_at, updated_at, completed_at
           ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending',
            NULL, NULL, NULL, ?8, ?8, NULL
           )`,
        )
        .bind(
          operationId,
          match.notification_subscription_id,
          delivery.deliveryId,
          NOTIFICATION_PAYLOAD_VERSION,
          options.objectSetVersion,
          payloadBytes.byteLength,
          payloadDigest,
          options.now,
        ),
      options.database
        .prepare(
          `INSERT INTO background_tasks (
            id, task_type, target_type, target_reference, input_version,
            task_key_digest, task_status, priority, attempt_count, max_attempts,
            next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
            last_error_code, last_error_summary, last_error_at, completed_at,
            created_at, updated_at
           ) VALUES (
            ?1, 'send_notification', 'notification_operation', ?2, 1,
            ?3, 'pending', 4, 0, ?4, ?5, NULL, 0, NULL,
            NULL, NULL, NULL, NULL, ?5, ?5
           )`,
        )
        .bind(taskId, operationId, taskDigest, NOTIFICATION_TASK_MAX_ATTEMPTS, options.now),
    )
    messages.push({ taskId, inputVersion: 1 })
  }
  return { statements, messages }
}

export async function processNotificationTask(options: {
  database: D1Database
  objectStore: MailObjectStore
  encryptionKeyBase64?: string
  taskId: string
  operationId: string
  fetcher?: typeof fetch
  now?: number
}): Promise<BackgroundTaskExecutionResult> {
  const now = options.now ?? Date.now()
  const operation = await readOperation(options.database, options.operationId)
  if (!operation) return { status: 'needs_attention', errorCode: 'notification_operation_missing' }
  if (['submitted', 'failed', 'unknown', 'cancelled'].includes(operation.operation_status)) {
    return { status: 'succeeded' }
  }
  if (operation.operation_status === 'submitting') {
    await markInterruptedUnknown(options.database, operation.id, now)
    return { status: 'succeeded' }
  }

  const execution = await loadExecution(options.database, operation.id)
  if (!execution) {
    await cancelOperation(
      options.database,
      operation.id,
      'notification_access_lost',
      '邮件来源或订阅权限已经失效',
      now,
    )
    return { status: 'succeeded' }
  }
  const bodyObject = await loadBodyObject(options.database, execution.message_id)
  if (!bodyObject) {
    return handleRecoverablePreparationFailure(
      options.database,
      options.taskId,
      operation.id,
      'notification_body_missing',
      '邮件正文对象暂时不可用',
      now,
    )
  }
  const stored = await options.objectStore.get(bodyObject.object_key)
  if (!stored) {
    return handleRecoverablePreparationFailure(
      options.database,
      options.taskId,
      operation.id,
      'notification_body_unavailable',
      '邮件正文对象暂时不可用',
      now,
    )
  }
  const digest = await sha256Bytes(stored.bytes)
  if (
    stored.bytes.byteLength !== bodyObject.expected_size_bytes ||
    !equalBytes(digest, bodyObject.expected_sha256)
  ) {
    await failOperation(
      options.database,
      operation.id,
      'notification_body_damaged',
      '邮件正文完整性检查失败',
      now,
    )
    return { status: 'needs_attention', errorCode: 'notification_body_damaged' }
  }
  const addresses = await loadHeaderAddresses(options.database, execution.message_id)
  const sourceBody = new TextDecoder().decode(stored.bytes)
  const plainBody =
    bodyObject.object_role === 'plain_body'
      ? normalizePlainText(sourceBody)
      : await extractVisibleTextFromHtml(sourceBody)
  const payload = formatNotificationPayload({
    subject: execution.subject,
    addresses,
    actualAddress: execution.display_recipient_address,
    body: plainBody,
  })
  const payloadBytes = new TextEncoder().encode(payload)
  const payloadDigest = await sha256Bytes(payloadBytes)
  if (
    payloadBytes.byteLength !== execution.payload_size_bytes ||
    !equalBytes(payloadDigest, execution.payload_sha256)
  ) {
    await failOperation(
      options.database,
      operation.id,
      'notification_payload_changed',
      '通知内容与接收时摘要不一致',
      now,
    )
    return { status: 'needs_attention', errorCode: 'notification_payload_changed' }
  }

  const limitError = notificationPayloadLimitError(execution.channel_type, payload)
  if (limitError) {
    await failOperation(
      options.database,
      operation.id,
      limitError,
      payloadLimitSummary(execution.channel_type),
      now,
    )
    return { status: 'succeeded' }
  }

  let credential: Record<string, string | null>
  try {
    credential = await decryptNotificationCredential({
      ...(options.encryptionKeyBase64 ? { encryptionKeyBase64: options.encryptionKeyBase64 } : {}),
      subscriptionId: execution.notification_subscription_id,
      ciphertext: execution.credential_ciphertext,
      nonce: execution.credential_nonce,
    })
  } catch (error) {
    const summary =
      error instanceof NotificationCredentialError ? error.message : '通知凭据无法解密'
    await failOperation(
      options.database,
      operation.id,
      'notification_credential_invalid',
      summary,
      now,
    )
    return { status: 'needs_attention', errorCode: 'notification_credential_invalid' }
  }

  const attempt = await beginAttempt(options.database, operation.id, now)
  let result: NotificationChannelResult
  try {
    result = await submitNotificationToChannel(
      {
        channelType: execution.channel_type,
        publicOptions: parsePublicOptions(execution.public_options_json),
        credential,
        payload,
      },
      options.fetcher ?? fetch,
    )
  } catch {
    await finishAttemptAndOperation(options.database, {
      operationId: operation.id,
      attemptId: attempt.id,
      attemptStatus: 'failed',
      operationStatus: 'failed',
      httpStatus: null,
      providerReference: null,
      errorCode: 'notification_configuration_invalid',
      errorSummary: '通知服务设置无效',
      now,
    })
    return { status: 'needs_attention', errorCode: 'notification_configuration_invalid' }
  }
  if (result.kind === 'accepted') {
    await finishAttemptAndOperation(options.database, {
      operationId: operation.id,
      attemptId: attempt.id,
      attemptStatus: 'submitted',
      operationStatus: 'submitted',
      httpStatus: result.httpStatus,
      providerReference: result.providerReference,
      errorCode: null,
      errorSummary: null,
      now,
    })
    return { status: 'succeeded' }
  }
  if (result.kind === 'unknown') {
    await finishAttemptAndOperation(options.database, {
      operationId: operation.id,
      attemptId: attempt.id,
      attemptStatus: 'unknown',
      operationStatus: 'unknown',
      httpStatus: result.httpStatus,
      providerReference: null,
      errorCode: result.code,
      errorSummary: '外部服务可能已经收到通知，系统不会自动重复推送',
      now,
    })
    return { status: 'succeeded' }
  }
  const isLastAttempt = await isFinalTaskAttempt(options.database, options.taskId)
  if (result.retryable && !isLastAttempt) {
    await finishRetryableAttempt(options.database, operation.id, attempt.id, result, now)
    throw new Error('通知服务明确暂时未接受，等待后台重试')
  }
  await finishAttemptAndOperation(options.database, {
    operationId: operation.id,
    attemptId: attempt.id,
    attemptStatus: 'failed',
    operationStatus: 'failed',
    httpStatus: result.httpStatus,
    providerReference: null,
    errorCode: result.code,
    errorSummary: result.retryable ? '通知服务连续拒绝，已停止自动重试' : '通知服务拒绝了本次推送',
    now,
  })
  return result.retryable
    ? { status: 'needs_attention', errorCode: result.code }
    : { status: 'succeeded' }
}

async function findSubscriptionMatches(
  database: D1Database,
  addressBindingIds: string[],
): Promise<SubscriptionMatchRow[]> {
  const unique = [...new Set(addressBindingIds)]
  const placeholders = unique.map((_, index) => `?${index + 1}`).join(', ')
  const rows = await database
    .prepare(
      `SELECT DISTINCT subscription.id AS notification_subscription_id,
              binding.id AS address_binding_id
       FROM address_bindings binding
       JOIN notification_subscriptions subscription
         ON subscription.subscription_status = 'active'
       JOIN users user
         ON user.id = subscription.user_id AND user.status = 'active'
       JOIN notification_subscription_scopes scope
         ON scope.notification_subscription_id = subscription.id
       LEFT JOIN organizations organization
         ON organization.id = binding.organization_id AND organization.status = 'active'
       LEFT JOIN organization_memberships membership
         ON membership.organization_id = binding.organization_id
        AND membership.user_id = subscription.user_id AND membership.left_at IS NULL
       WHERE binding.id IN (${placeholders}) AND binding.ended_at IS NULL
         AND (
           (scope.scope_kind = 'all_personal'
             AND binding.owner_type = 'user' AND binding.user_id = subscription.user_id)
           OR (scope.scope_kind = 'personal_address'
             AND binding.owner_type = 'user' AND binding.user_id = subscription.user_id
             AND scope.email_address_id = binding.address_id)
           OR (scope.scope_kind = 'organization_address'
             AND binding.owner_type = 'organization' AND organization.id IS NOT NULL
             AND membership.id IS NOT NULL AND scope.email_address_id = binding.address_id)
         )
       ORDER BY subscription.id, binding.id`,
    )
    .bind(...unique)
    .all<SubscriptionMatchRow>()
  return rows.results
}

function readOperation(database: D1Database, operationId: string) {
  return database
    .prepare(`SELECT id, operation_status FROM notification_operations WHERE id = ?1 LIMIT 1`)
    .bind(operationId)
    .first<OperationRow>()
}

function loadExecution(database: D1Database, operationId: string) {
  return database
    .prepare(
      `SELECT operation.id, operation.operation_status,
              operation.notification_subscription_id, subscription.channel_type,
              subscription.public_options_json, secret.credential_ciphertext,
              secret.credential_nonce, delivery.message_id, message.subject,
              delivery.display_recipient_address, operation.payload_object_set_version,
              operation.payload_size_bytes, operation.payload_sha256
       FROM notification_operations operation
       JOIN notification_subscriptions subscription
         ON subscription.id = operation.notification_subscription_id
        AND subscription.subscription_status = 'active'
       JOIN notification_subscription_secrets secret
         ON secret.notification_subscription_id = subscription.id
       JOIN users user ON user.id = subscription.user_id AND user.status = 'active'
       JOIN message_deliveries delivery ON delivery.id = operation.message_delivery_id
       JOIN messages message ON message.id = delivery.message_id
       JOIN message_integrity_states integrity
         ON integrity.message_id = message.id AND integrity.integrity_status = 'ready'
        AND integrity.hidden_since IS NULL
        AND integrity.object_set_version = operation.payload_object_set_version
       JOIN address_bindings binding
         ON binding.id = delivery.address_binding_id AND binding.ended_at IS NULL
       LEFT JOIN organizations organization
         ON organization.id = binding.organization_id AND organization.status = 'active'
       LEFT JOIN organization_memberships membership
         ON membership.organization_id = binding.organization_id
        AND membership.user_id = subscription.user_id AND membership.left_at IS NULL
       WHERE operation.id = ?1 AND operation.operation_status = 'pending'
         AND EXISTS (
           SELECT 1 FROM notification_subscription_scopes scope
           WHERE scope.notification_subscription_id = subscription.id
             AND (
               (scope.scope_kind = 'all_personal'
                 AND binding.owner_type = 'user' AND binding.user_id = subscription.user_id)
               OR (scope.scope_kind = 'personal_address'
                 AND binding.owner_type = 'user' AND binding.user_id = subscription.user_id
                 AND scope.email_address_id = binding.address_id)
               OR (scope.scope_kind = 'organization_address'
                 AND binding.owner_type = 'organization' AND organization.id IS NOT NULL
                 AND membership.id IS NOT NULL AND scope.email_address_id = binding.address_id)
             )
         )
       LIMIT 1`,
    )
    .bind(operationId)
    .first<ExecutionRow>()
}

function loadBodyObject(database: D1Database, messageId: string) {
  return database
    .prepare(
      `SELECT object_key, object_role, expected_size_bytes, expected_sha256
       FROM object_registry
       WHERE message_id = ?1 AND object_role IN ('plain_body', 'html_body')
         AND object_status = 'active' AND is_current = 1
       ORDER BY CASE object_role WHEN 'plain_body' THEN 0 ELSE 1 END, id
       LIMIT 1`,
    )
    .bind(messageId)
    .first<BodyObjectRow>()
}

async function loadHeaderAddresses(
  database: D1Database,
  messageId: string,
): Promise<NotificationMessageAddress[]> {
  const rows = await database
    .prepare(
      `SELECT address_role, display_name, address_text
       FROM message_header_addresses
       WHERE message_id = ?1 AND address_role IN ('from', 'sender', 'to', 'cc')
       ORDER BY address_role, sequence_number, id`,
    )
    .bind(messageId)
    .all<HeaderAddressRow>()
  return rows.results.map((row) => ({
    role: row.address_role,
    displayName: row.display_name,
    address: row.address_text,
  }))
}

async function beginAttempt(database: D1Database, operationId: string, now: number) {
  const next = await database
    .prepare(
      `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
       FROM notification_attempts WHERE notification_operation_id = ?1`,
    )
    .bind(operationId)
    .first<{ attempt_number: number }>()
  const id = crypto.randomUUID()
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO notification_attempts (
          id, notification_operation_id, attempt_number, attempt_status,
          http_status, provider_reference, error_code, error_summary,
          started_at, completed_at, created_at
         ) VALUES (?1, ?2, ?3, 'prepared', NULL, NULL, NULL, NULL, NULL, NULL, ?4)`,
      )
      .bind(id, operationId, next?.attempt_number ?? 1, now),
    database
      .prepare(
        `UPDATE notification_operations
         SET operation_status = 'submitting', error_code = NULL,
             error_summary = NULL, updated_at = ?1
         WHERE id = ?2 AND operation_status = 'pending'`,
      )
      .bind(now, operationId),
    database
      .prepare(
        `UPDATE notification_attempts
         SET attempt_status = 'submitting', started_at = ?1
         WHERE id = ?2 AND attempt_status = 'prepared'`,
      )
      .bind(now, id),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('通知尝试状态已经发生变化')
  }
  return { id }
}

async function finishRetryableAttempt(
  database: D1Database,
  operationId: string,
  attemptId: string,
  result: Extract<NotificationChannelResult, { kind: 'not_accepted' }>,
  now: number,
): Promise<void> {
  const results = await database.batch([
    database
      .prepare(
        `UPDATE notification_attempts
         SET attempt_status = 'failed', http_status = ?1, error_code = ?2,
             error_summary = '通知服务明确暂时未接受', completed_at = ?3
         WHERE id = ?4 AND attempt_status = 'submitting'`,
      )
      .bind(result.httpStatus, result.code, now, attemptId),
    database
      .prepare(
        `UPDATE notification_operations
         SET operation_status = 'pending', error_code = ?1,
             error_summary = '通知服务明确暂时未接受，等待重试', updated_at = ?2
         WHERE id = ?3 AND operation_status = 'submitting'`,
      )
      .bind(result.code, now, operationId),
  ])
  if (results.some((item) => item.meta.changes !== 1)) throw new Error('通知重试状态写入失败')
}

async function finishAttemptAndOperation(
  database: D1Database,
  options: {
    operationId: string
    attemptId: string
    attemptStatus: 'submitted' | 'failed' | 'unknown'
    operationStatus: 'submitted' | 'failed' | 'unknown'
    httpStatus: number | null
    providerReference: string | null
    errorCode: string | null
    errorSummary: string | null
    now: number
  },
): Promise<void> {
  const results = await database.batch([
    database
      .prepare(
        `UPDATE notification_attempts
         SET attempt_status = ?1, http_status = ?2, provider_reference = ?3,
             error_code = ?4, error_summary = ?5, completed_at = ?6
         WHERE id = ?7 AND attempt_status = 'submitting'`,
      )
      .bind(
        options.attemptStatus,
        options.httpStatus,
        options.providerReference,
        options.errorCode,
        options.errorSummary,
        options.now,
        options.attemptId,
      ),
    database
      .prepare(
        `UPDATE notification_operations
         SET operation_status = ?1, provider_reference = ?2,
             error_code = ?3, error_summary = ?4,
             completed_at = ?5, updated_at = ?5
         WHERE id = ?6 AND operation_status = 'submitting'`,
      )
      .bind(
        options.operationStatus,
        options.providerReference,
        options.errorCode,
        options.errorSummary,
        options.now,
        options.operationId,
      ),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('通知结果状态已经发生变化')
  }
}

async function markInterruptedUnknown(database: D1Database, operationId: string, now: number) {
  const results = await database.batch([
    database
      .prepare(
        `UPDATE notification_attempts
         SET attempt_status = 'unknown', error_code = 'interrupted_result_unknown',
             error_summary = '提交期间任务中断，结果未知', completed_at = ?1
         WHERE notification_operation_id = ?2 AND attempt_status = 'submitting'`,
      )
      .bind(now, operationId),
    database
      .prepare(
        `UPDATE notification_operations
         SET operation_status = 'unknown', error_code = 'interrupted_result_unknown',
             error_summary = '外部服务可能已经收到通知，系统不会自动重复推送',
             completed_at = ?1, updated_at = ?1
         WHERE id = ?2 AND operation_status = 'submitting'`,
      )
      .bind(now, operationId),
  ])
  if (results[1]?.meta.changes !== 1) throw new Error('中断通知结果无法收口')
}

async function cancelOperation(
  database: D1Database,
  operationId: string,
  code: string,
  summary: string,
  now: number,
) {
  await database
    .prepare(
      `UPDATE notification_operations
       SET operation_status = 'cancelled', error_code = ?1, error_summary = ?2,
           completed_at = ?3, updated_at = ?3
       WHERE id = ?4 AND operation_status = 'pending'`,
    )
    .bind(code, summary, now, operationId)
    .run()
}

async function failOperation(
  database: D1Database,
  operationId: string,
  code: string,
  summary: string,
  now: number,
) {
  await database
    .prepare(
      `UPDATE notification_operations
       SET operation_status = 'failed', error_code = ?1, error_summary = ?2,
           completed_at = ?3, updated_at = ?3
       WHERE id = ?4 AND operation_status = 'pending'`,
    )
    .bind(code, summary, now, operationId)
    .run()
}

async function handleRecoverablePreparationFailure(
  database: D1Database,
  taskId: string,
  operationId: string,
  code: string,
  summary: string,
  now: number,
): Promise<BackgroundTaskExecutionResult> {
  if (await isFinalTaskAttempt(database, taskId)) {
    await failOperation(database, operationId, code, summary, now)
    return { status: 'needs_attention', errorCode: code }
  }
  throw new Error(summary)
}

async function isFinalTaskAttempt(database: D1Database, taskId: string): Promise<boolean> {
  const row = await database
    .prepare(`SELECT attempt_count, max_attempts FROM background_tasks WHERE id = ?1 LIMIT 1`)
    .bind(taskId)
    .first<TaskAttemptRow>()
  return !row || row.attempt_count >= row.max_attempts
}

function formatNotificationPayload(options: {
  subject: string
  addresses: NotificationMessageAddress[]
  actualAddress: string
  body: string
}): string {
  const sender = options.addresses.find(
    (address) => address.role === 'from' || address.role === 'sender',
  )
  const recipients = options.addresses.filter((address) => address.role === 'to')
  const copied = options.addresses.filter((address) => address.role === 'cc')
  return [
    `发件人：${sender ? formatAddress(sender) : '未知发件人'}`,
    `收件人：${recipients.length ? recipients.map(formatAddress).join('、') : options.actualAddress}`,
    ...(copied.length ? [`抄送：${copied.map(formatAddress).join('、')}`] : []),
    `实际投递：${options.actualAddress}`,
    `主题：${options.subject || '（无主题）'}`,
    '',
    '正文：',
    options.body,
  ].join('\n')
}

function formatAddress(address: NotificationMessageAddress): string {
  return address.displayName ? `${address.displayName} <${address.address}>` : address.address
}

function normalizePlainText(value: string): string {
  return value.replace(/\r\n?/gu, '\n')
}

async function extractVisibleTextFromHtml(html: string): Promise<string> {
  if (!html.trim()) return ''
  const wrapped = `<!doctype html><html><body>${html}</body></html>`
  let sanitizer = new HTMLRewriter()
  for (const tag of ['script', 'style', 'template', 'svg', 'form', 'iframe', 'object']) {
    sanitizer = sanitizer.on(tag, {
      element(element) {
        element.remove()
      },
    })
  }
  const sanitized = await sanitizer
    .transform(new Response(wrapped, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    .text()
  const parts: string[] = []
  let rewriter = new HTMLRewriter().on('body', {
    text(text) {
      parts.push(text.text)
    },
  })
  for (const tag of ['br', 'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'blockquote']) {
    rewriter = rewriter.on(tag, {
      element() {
        parts.push('\n')
      },
    })
  }
  await rewriter
    .transform(new Response(sanitized, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    .text()
  return parts
    .join('')
    .replace(/\r/gu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function parsePublicOptions(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

function payloadLimitSummary(channelType: NotificationChannelType): string {
  if (channelType === 'ntfy') return '完整通知正文超过 ntfy 的 4,096 字节上限'
  if (channelType === 'telegram') return '完整通知正文超过 Telegram 的 4,096 字符上限'
  return '完整通知正文超过 WxPusher 的 40,000 字符上限'
}
