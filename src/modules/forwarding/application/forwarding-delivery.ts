import type { BackgroundTaskMessage } from '../../../shared/contracts/background-task'
import type { ParsedIncomingMail } from '../../mail-receiving/domain/mime-parser'
import { bytesToHex, equalBytes, sha256Bytes } from '../../mail-receiving/domain/content-digest'
import type { MailObjectStore } from '../../mail-receiving/public'
import {
  decryptOutboundCredential,
  submitOutboundProviderMessage,
  type OutboundProviderAttachment,
  type OutboundProviderType,
} from '../../sending/public'
import type { BackgroundTaskExecutionResult } from '../../tasks/application/background-task-service'

const MAX_MESSAGE_BYTES = 20_000_000
const MAX_FORWARD_HOPS = 5
const FORWARD_TASK_MAX_ATTEMPTS = 3

export interface ForwardingDeliveryCandidate {
  deliveryId: string
  messageId: string
  sourceSizeBytes: number
  addressBindingId: string
  addressId: string
  domainId: string
  userId: string | null
  actualAddress: string
}

export interface PreparedForwardingWork {
  statements: D1PreparedStatement[]
  messages: BackgroundTaskMessage[]
}

interface MatchingRuleRow {
  id: string
  rule_version: number
  external_email_target_id: string
  canonical_email_address: string
}

interface RouteEntryRow {
  route_id: string
  route_version: number
  provider_config_id: string
  configuration_key: string
  configuration_version: number
  provider_type: OutboundProviderType
  public_options_json: string
  priority_number: number
}

interface ExecutionRow {
  id: string
  operation_status: string
  source_message_id: string
  message_delivery_id: string
  mail_forwarding_rule_id: string
  rule_version: number
  external_email_target_id: string
  sender_address: string
  target_canonical_email_address: string
  payload_sha256: ArrayBuffer
  payload_size_bytes: number
  forwarding_hop_count: number
  source_size_bytes: number
  subject: string
  user_display_name: string | null
}

interface StoredObjectRow {
  object_key: string
  object_role: 'plain_body' | 'html_body' | 'attachment'
  sequence_number: number
  expected_size_bytes: number
  expected_sha256: ArrayBuffer
  media_type: string
  untrusted_file_name: string | null
}

interface HeaderAddressRow {
  address_role: string
  sequence_number: number
  address_text: string
}

interface AttemptRouteEntryRow {
  id: string
  priority_number: number
  provider_type: OutboundProviderType
  configuration_key: string
  configuration_version: number
  credential_ciphertext: ArrayBuffer
  credential_nonce: ArrayBuffer
  configuration_status: string
}

export async function prepareForwardingWork(options: {
  database: D1Database
  delivery: ForwardingDeliveryCandidate
  parsed: ParsedIncomingMail
  now: number
}): Promise<PreparedForwardingWork> {
  if (!options.delivery.userId) return { statements: [], messages: [] }
  const rules = await findMatchingRules(options.database, options.delivery)
  if (rules.length === 0) return { statements: [], messages: [] }
  const routeEntries = await loadActiveRouteEntries(options.database, options.delivery.domainId)
  const statements: D1PreparedStatement[] = []
  const messages: BackgroundTaskMessage[] = []
  for (const rule of rules) {
    const operationId = crypto.randomUUID()
    const hopCount = Math.min(MAX_FORWARD_HOPS, options.parsed.forwardingHopCount + 1)
    const rejected =
      options.parsed.sourceMarkedBySimlettra ||
      options.parsed.forwardingHopCount >= MAX_FORWARD_HOPS ||
      (await isManagedTarget(options.database, rule.canonical_email_address))
    const payload = await calculateParsedPayload({
      messageId: options.delivery.messageId,
      deliveryId: options.delivery.deliveryId,
      ruleId: rule.id,
      ruleVersion: rule.rule_version,
      senderAddress: options.delivery.actualAddress,
      targetAddress: rule.canonical_email_address,
      hopCount,
      sourceSizeBytes: options.delivery.sourceSizeBytes,
      parsed: options.parsed,
    })
    const noRoute = routeEntries.length === 0
    const routeSnapshotId = rejected || noRoute ? null : crypto.randomUUID()
    if (routeSnapshotId) {
      const first = routeEntries[0]!
      const routeEntryDigests = await Promise.all(
        routeEntries.map((entry) => sha256Bytes(entry.public_options_json)),
      )
      statements.push(
        options.database
          .prepare(
            `INSERT INTO outbound_route_snapshots (
              id, mail_domain_id, source_route_id, source_route_version,
              execution_kind, execution_reference, payload_sha256,
              payload_size_bytes, created_at
             ) VALUES (?1, ?2, ?3, ?4, 'forward', ?5, ?6, ?7, ?8)`,
          )
          .bind(
            routeSnapshotId,
            options.delivery.domainId,
            first.route_id,
            first.route_version,
            operationId,
            payload.digest,
            payload.size,
            options.now,
          ),
        ...routeEntries.map((entry, index) =>
          options.database
            .prepare(
              `INSERT INTO outbound_route_snapshot_entries (
                id, route_snapshot_id, priority_number, provider_config_id,
                configuration_key, configuration_version, provider_type,
                effective_size_limit_bytes, provider_options_digest, created_at
               ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
            )
            .bind(
              crypto.randomUUID(),
              routeSnapshotId,
              entry.priority_number,
              entry.provider_config_id,
              entry.configuration_key,
              entry.configuration_version,
              entry.provider_type,
              MAX_MESSAGE_BYTES,
              routeEntryDigests[index],
              options.now,
            ),
        ),
      )
    }
    const operationStatus = rejected ? 'rejected_loop' : noRoute ? 'failed' : 'pending'
    const errorCode = rejected
      ? 'forwarding_loop_rejected'
      : noRoute
        ? 'outbound_route_missing'
        : null
    const errorSummary = rejected
      ? '邮件带有转发标记或已经达到转发跳数上限'
      : noRoute
        ? '实际收件地址所在域名没有可用的域外发信路线'
        : null
    statements.push(
      options.database
        .prepare(
          `INSERT INTO mail_forward_operations (
            id, source_message_id, message_delivery_id, mail_forwarding_rule_id,
            rule_version, external_email_target_id, sender_address,
            target_canonical_email_address, payload_sha256, payload_size_bytes,
            forwarding_hop_count, source_marked_by_simlettra,
            outbound_route_snapshot_id, operation_status, provider_reference,
            error_code, error_summary, created_at, updated_at, completed_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     ?13, ?14, NULL, ?15, ?16, ?17, ?17, ?18)`,
        )
        .bind(
          operationId,
          options.delivery.messageId,
          options.delivery.deliveryId,
          rule.id,
          rule.rule_version,
          rule.external_email_target_id,
          options.delivery.actualAddress,
          rule.canonical_email_address,
          payload.digest,
          payload.size,
          hopCount,
          options.parsed.sourceMarkedBySimlettra ? 1 : 0,
          routeSnapshotId,
          operationStatus,
          errorCode,
          errorSummary,
          options.now,
          rejected || noRoute ? options.now : null,
        ),
    )
    if (operationStatus !== 'pending') continue
    const taskId = crypto.randomUUID()
    const taskDigest = await sha256Bytes(`forward_mail\n${operationId}\n1`)
    statements.push(
      options.database
        .prepare(
          `INSERT INTO background_tasks (
            id, task_type, target_type, target_reference, input_version,
            task_key_digest, task_status, priority, attempt_count, max_attempts,
            next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
            last_error_code, last_error_summary, last_error_at, completed_at,
            created_at, updated_at
           ) VALUES (?1, 'forward_mail', 'mail_forward_operation', ?2, 1, ?3,
                     'pending', 5, 0, ?4, ?5, NULL, 0, NULL,
                     NULL, NULL, NULL, NULL, ?5, ?5)`,
        )
        .bind(taskId, operationId, taskDigest, FORWARD_TASK_MAX_ATTEMPTS, options.now),
    )
    messages.push({ taskId, inputVersion: 1 })
  }
  return { statements, messages }
}

export async function processMailForwardTask(options: {
  database: D1Database
  objectStore: MailObjectStore
  encryptionKeyBase64?: string
  operationId: string
  fetcher?: typeof fetch
  now?: number
}): Promise<BackgroundTaskExecutionResult> {
  const now = options.now ?? Date.now()
  const operation = await loadExecution(options.database, options.operationId)
  if (!operation) return { status: 'needs_attention', errorCode: 'forward_operation_missing' }
  if (
    ['submitted', 'failed', 'unknown', 'cancelled', 'rejected_loop'].includes(
      operation.operation_status,
    )
  ) {
    return { status: 'succeeded' }
  }
  if (operation.operation_status === 'submitting') {
    await markInterruptedUnknown(options.database, operation.id, now)
    return { status: 'succeeded' }
  }

  const accessValid = await stillAuthorized(options.database, operation)
  if (!accessValid) {
    await finishOperation(
      options.database,
      operation.id,
      'cancelled',
      null,
      'forwarding_access_lost',
      '转发规则、目标或个人地址已经失效',
      now,
    )
    return { status: 'succeeded' }
  }
  const [objects, addresses] = await Promise.all([
    loadMessageObjects(options.database, operation.source_message_id),
    loadHeaderAddresses(options.database, operation.source_message_id),
  ])
  const loaded = await loadAndVerifyObjects(options.objectStore, objects)
  if (!loaded) throw new Error('转发邮件对象暂时不可用')
  const payload = await calculateStoredPayload({ operation, objects, addresses })
  if (
    payload.size !== operation.payload_size_bytes ||
    !equalBytes(payload.digest, operation.payload_sha256)
  ) {
    await finishOperation(
      options.database,
      operation.id,
      'failed',
      null,
      'forward_payload_changed',
      '转发内容完整性检查失败',
      now,
    )
    return { status: 'needs_attention', errorCode: 'forward_payload_changed' }
  }
  const body = buildBodies(objects, loaded)
  const attachments = buildAttachments(objects, loaded)
  const replyTo =
    addresses.find((address) => address.address_role === 'reply_to')?.address_text ??
    addresses.find((address) => address.address_role === 'from')?.address_text ??
    null
  const routeEntries = await loadAttemptRouteEntries(options.database, operation.id)
  if (routeEntries.length === 0) {
    await finishOperation(
      options.database,
      operation.id,
      'failed',
      null,
      'outbound_route_exhausted',
      '没有剩余可用的域外发信服务',
      now,
    )
    return { status: 'succeeded' }
  }
  const started = await options.database
    .prepare(
      `UPDATE mail_forward_operations SET operation_status = 'submitting', updated_at = ?1
       WHERE id = ?2 AND operation_status = 'pending'`,
    )
    .bind(now, operation.id)
    .run()
  if (started.meta.changes !== 1) throw new Error('转发操作状态已经发生变化')

  for (const [index, entry] of routeEntries.entries()) {
    const attemptId = crypto.randomUUID()
    const selectionKind = index === 0 ? 'initial' : 'fallback'
    await prepareAttempt(options.database, {
      attemptId,
      operationId: operation.id,
      routeEntryId: entry.id,
      attemptNumber: index + 1,
      selectionKind,
      fallbackReason: selectionKind === 'fallback' ? 'temporary_rejection' : null,
      now,
    })
    if (entry.configuration_status === 'disabled') {
      await finishAttempt(
        options.database,
        attemptId,
        'not_accepted',
        null,
        'configuration_disabled',
        now,
      )
      if (index + 1 < routeEntries.length) continue
      await finishOperation(
        options.database,
        operation.id,
        'failed',
        null,
        'configuration_disabled',
        '域外发信服务已经停用',
        now,
      )
      return { status: 'succeeded' }
    }
    let result
    try {
      const credential = await decryptOutboundCredential({
        ...(options.encryptionKeyBase64
          ? { encryptionKeyBase64: options.encryptionKeyBase64 }
          : {}),
        configurationKey: entry.configuration_key,
        configurationVersion: entry.configuration_version,
        ciphertext: entry.credential_ciphertext,
        nonce: entry.credential_nonce,
      })
      result = await submitOutboundProviderMessage({
        fetcher: options.fetcher ?? fetch,
        providerType: entry.provider_type,
        credential,
        idempotencyKey: `simlettra-${attemptId}`,
        message: {
          senderAddress: operation.sender_address,
          senderDisplayName: operation.user_display_name,
          recipientAddress: operation.target_canonical_email_address,
          subject: operation.subject,
          ...body,
          replyTo,
          headers: {
            'X-Simlettra-Forwarded': '1',
            'X-Simlettra-Forward-Hop': String(operation.forwarding_hop_count),
            'X-Simlettra-Forward-Operation': operation.id,
          },
          attachments,
        },
      })
    } catch {
      result = {
        kind: 'not_accepted' as const,
        retryWithFallback: true,
        code: 'configuration_rejected',
      }
    }
    if (result.kind === 'accepted') {
      await options.database.batch([
        finishAttemptStatement(
          options.database,
          attemptId,
          'accepted',
          result.submissionId,
          null,
          now,
        ),
        finishOperationStatement(
          options.database,
          operation.id,
          'submitted',
          result.submissionId,
          null,
          null,
          now,
        ),
      ])
      return { status: 'succeeded' }
    }
    if (result.kind === 'unknown') {
      await options.database.batch([
        finishAttemptStatement(options.database, attemptId, 'unknown', null, result.code, now),
        finishOperationStatement(
          options.database,
          operation.id,
          'unknown',
          null,
          result.code,
          '发信服务是否接受转发邮件暂时无法判断',
          now,
        ),
      ])
      return { status: 'succeeded' }
    }
    await finishAttempt(options.database, attemptId, 'not_accepted', null, result.code, now)
    if (result.retryWithFallback && index + 1 < routeEntries.length) continue
    await finishOperation(
      options.database,
      operation.id,
      'failed',
      null,
      result.code,
      '发信服务明确未接受转发邮件',
      now,
    )
    return { status: 'succeeded' }
  }
  return { status: 'succeeded' }
}

async function findMatchingRules(
  database: D1Database,
  delivery: ForwardingDeliveryCandidate,
): Promise<MatchingRuleRow[]> {
  const rows = await database
    .prepare(
      `SELECT rule.id, rule.rule_version, rule.external_email_target_id,
              target.canonical_email_address
       FROM mail_forwarding_rules rule
       JOIN external_email_targets target
         ON target.id = rule.external_email_target_id AND target.target_status = 'verified'
       WHERE rule.user_id = ?1 AND rule.rule_status = 'active'
         AND (
           rule.scope_kind = 'all_personal'
           OR EXISTS (
             SELECT 1 FROM mail_forwarding_rule_addresses selected
             WHERE selected.mail_forwarding_rule_id = rule.id
               AND selected.email_address_id = ?2
           )
         )
       ORDER BY rule.created_at, rule.id`,
    )
    .bind(delivery.userId, delivery.addressId)
    .all<MatchingRuleRow>()
  return rows.results
}

async function loadActiveRouteEntries(
  database: D1Database,
  domainId: string,
): Promise<RouteEntryRow[]> {
  const rows = await database
    .prepare(
      `SELECT route.id AS route_id, route.route_version,
              config.id AS provider_config_id, config.configuration_key,
              config.configuration_version, config.provider_type,
              config.public_options_json, entry.priority_number
       FROM domain_outbound_routes route
       JOIN domain_outbound_route_entries entry ON entry.route_id = route.id
       JOIN outbound_provider_configs config
         ON config.id = entry.provider_config_id AND config.configuration_status = 'active'
       WHERE route.mail_domain_id = ?1 AND route.route_status = 'active'
       ORDER BY entry.priority_number`,
    )
    .bind(domainId)
    .all<RouteEntryRow>()
  return rows.results.every((entry, index) => entry.priority_number === index) ? rows.results : []
}

async function isManagedTarget(database: D1Database, address: string): Promise<boolean> {
  const domain = address.slice(address.lastIndexOf('@') + 1)
  return Boolean(
    await database
      .prepare(
        `SELECT 1 AS found FROM mail_domains WHERE canonical_name = ?1 AND status <> 'deleted'`,
      )
      .bind(domain)
      .first<{ found: number }>(),
  )
}

async function loadExecution(
  database: D1Database,
  operationId: string,
): Promise<ExecutionRow | null> {
  return database
    .prepare(
      `SELECT operation.id, operation.operation_status, operation.source_message_id,
              operation.message_delivery_id, operation.mail_forwarding_rule_id,
              operation.rule_version, operation.external_email_target_id,
              operation.sender_address, operation.target_canonical_email_address,
              operation.payload_sha256, operation.payload_size_bytes,
              operation.forwarding_hop_count, message.raw_size_bytes AS source_size_bytes,
              message.subject,
              user.display_name AS user_display_name
       FROM mail_forward_operations operation
       JOIN messages message ON message.id = operation.source_message_id
       JOIN mail_forwarding_rules rule ON rule.id = operation.mail_forwarding_rule_id
       JOIN users user ON user.id = rule.user_id
       WHERE operation.id = ?1 LIMIT 1`,
    )
    .bind(operationId)
    .first<ExecutionRow>()
}

async function stillAuthorized(database: D1Database, operation: ExecutionRow): Promise<boolean> {
  return Boolean(
    await database
      .prepare(
        `SELECT 1 AS allowed
         FROM mail_forward_operations operation_target
         JOIN mail_forwarding_rules rule ON rule.id = operation_target.mail_forwarding_rule_id
         JOIN users user ON user.id = rule.user_id AND user.status = 'active'
         JOIN external_email_targets target
           ON target.id = operation_target.external_email_target_id
          AND target.id = rule.external_email_target_id
          AND target.user_id = rule.user_id
          AND target.target_status = 'verified'
         JOIN message_deliveries delivery ON delivery.id = operation_target.message_delivery_id
         JOIN address_bindings binding
           ON binding.id = delivery.address_binding_id
          AND binding.owner_type = 'user'
          AND binding.user_id = rule.user_id
          AND binding.ended_at IS NULL
         WHERE operation_target.id = ?1
           AND rule.id = operation_target.mail_forwarding_rule_id
           AND rule.rule_version = operation_target.rule_version
           AND rule.rule_status = 'active'
           AND (
             rule.scope_kind = 'all_personal'
             OR EXISTS (
               SELECT 1 FROM mail_forwarding_rule_addresses selected
               WHERE selected.mail_forwarding_rule_id = rule.id
                 AND selected.email_address_id = binding.address_id
             )
           ) LIMIT 1`,
      )
      .bind(operation.id)
      .first<{ allowed: number }>(),
  )
}

async function loadMessageObjects(
  database: D1Database,
  messageId: string,
): Promise<StoredObjectRow[]> {
  const rows = await database
    .prepare(
      `SELECT object_key, object_role, sequence_number, expected_size_bytes,
              expected_sha256, media_type, untrusted_file_name
       FROM object_registry
       WHERE message_id = ?1 AND object_role IN ('plain_body', 'html_body', 'attachment')
         AND object_status = 'active' AND is_current = 1
       ORDER BY object_role, sequence_number, id`,
    )
    .bind(messageId)
    .all<StoredObjectRow>()
  return rows.results
}

async function loadHeaderAddresses(
  database: D1Database,
  messageId: string,
): Promise<HeaderAddressRow[]> {
  const rows = await database
    .prepare(
      `SELECT address_role, sequence_number, address_text
       FROM message_header_addresses WHERE message_id = ?1
       ORDER BY address_role, sequence_number, id`,
    )
    .bind(messageId)
    .all<HeaderAddressRow>()
  return rows.results
}

async function loadAndVerifyObjects(
  store: MailObjectStore,
  objects: StoredObjectRow[],
): Promise<Map<string, Uint8Array> | null> {
  const loaded = new Map<string, Uint8Array>()
  for (const object of objects) {
    const stored = await store.get(object.object_key)
    if (!stored) return null
    const digest = await sha256Bytes(stored.bytes)
    if (
      stored.bytes.byteLength !== object.expected_size_bytes ||
      !equalBytes(digest, object.expected_sha256)
    ) {
      throw new Error('转发邮件对象完整性检查失败')
    }
    loaded.set(object.object_key, new Uint8Array(stored.bytes))
  }
  return loaded
}

function buildBodies(
  objects: StoredObjectRow[],
  loaded: Map<string, Uint8Array>,
): { text?: string; html?: string } {
  const plain = objects.find((object) => object.object_role === 'plain_body')
  const html = objects.find((object) => object.object_role === 'html_body')
  return {
    ...(plain ? { text: new TextDecoder().decode(loaded.get(plain.object_key)) } : {}),
    ...(html ? { html: new TextDecoder().decode(loaded.get(html.object_key)) } : {}),
  }
}

function buildAttachments(
  objects: StoredObjectRow[],
  loaded: Map<string, Uint8Array>,
): OutboundProviderAttachment[] {
  return objects
    .filter((object) => object.object_role === 'attachment')
    .map((object) => ({
      fileName: object.untrusted_file_name || 'attachment',
      mediaType: object.media_type,
      content: bytesToBase64(loaded.get(object.object_key) ?? new Uint8Array()),
    }))
}

async function loadAttemptRouteEntries(
  database: D1Database,
  operationId: string,
): Promise<AttemptRouteEntryRow[]> {
  const rows = await database
    .prepare(
      `SELECT entry.id, entry.priority_number, entry.provider_type,
              entry.configuration_key, entry.configuration_version,
              config.credential_ciphertext, config.credential_nonce,
              config.configuration_status
       FROM mail_forward_operations operation
       JOIN outbound_route_snapshot_entries entry
         ON entry.route_snapshot_id = operation.outbound_route_snapshot_id
       JOIN outbound_provider_configs config ON config.id = entry.provider_config_id
       WHERE operation.id = ?1 ORDER BY entry.priority_number`,
    )
    .bind(operationId)
    .all<AttemptRouteEntryRow>()
  return rows.results
}

async function prepareAttempt(
  database: D1Database,
  options: {
    attemptId: string
    operationId: string
    routeEntryId: string
    attemptNumber: number
    selectionKind: 'initial' | 'fallback'
    fallbackReason: 'temporary_rejection' | null
    now: number
  },
): Promise<void> {
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO mail_forward_attempts (
          id, mail_forward_operation_id, route_snapshot_entry_id, attempt_number,
          selection_kind, fallback_reason, attempt_status, provider_submission_id,
          started_at, completed_at, error_code, error_summary, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', NULL, NULL, NULL, NULL, NULL, ?7, ?7)`,
      )
      .bind(
        options.attemptId,
        options.operationId,
        options.routeEntryId,
        options.attemptNumber,
        options.selectionKind,
        options.fallbackReason,
        options.now,
      ),
    database
      .prepare(
        `UPDATE mail_forward_attempts SET attempt_status = 'submitting',
                started_at = ?1, updated_at = ?1
         WHERE id = ?2 AND attempt_status = 'prepared'`,
      )
      .bind(options.now, options.attemptId),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('转发尝试状态已经发生变化')
  }
}

async function finishAttempt(
  database: D1Database,
  attemptId: string,
  status: 'accepted' | 'not_accepted' | 'unknown',
  providerReference: string | null,
  errorCode: string | null,
  now: number,
): Promise<void> {
  const result = await finishAttemptStatement(
    database,
    attemptId,
    status,
    providerReference,
    errorCode,
    now,
  ).run()
  if (result.meta.changes !== 1) throw new Error('转发尝试结果已经发生变化')
}

function finishAttemptStatement(
  database: D1Database,
  attemptId: string,
  status: 'accepted' | 'not_accepted' | 'unknown',
  providerReference: string | null,
  errorCode: string | null,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE mail_forward_attempts
       SET attempt_status = ?1, provider_submission_id = ?2, completed_at = ?3,
           error_code = ?4, error_summary = ?5, updated_at = ?3
       WHERE id = ?6 AND attempt_status = 'submitting'`,
    )
    .bind(
      status,
      providerReference,
      now,
      errorCode,
      errorCode ? '域外发信服务没有明确接受本次转发提交' : null,
      attemptId,
    )
}

async function finishOperation(
  database: D1Database,
  operationId: string,
  status: 'submitted' | 'failed' | 'unknown' | 'cancelled',
  providerReference: string | null,
  errorCode: string | null,
  errorSummary: string | null,
  now: number,
): Promise<void> {
  const result = await finishOperationStatement(
    database,
    operationId,
    status,
    providerReference,
    errorCode,
    errorSummary,
    now,
  ).run()
  if (result.meta.changes !== 1) throw new Error('转发操作结果已经发生变化')
}

function finishOperationStatement(
  database: D1Database,
  operationId: string,
  status: 'submitted' | 'failed' | 'unknown' | 'cancelled',
  providerReference: string | null,
  errorCode: string | null,
  errorSummary: string | null,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE mail_forward_operations
       SET operation_status = ?1, provider_reference = ?2,
           error_code = ?3, error_summary = ?4,
           completed_at = ?5, updated_at = ?5
       WHERE id = ?6 AND operation_status IN ('pending', 'submitting')`,
    )
    .bind(status, providerReference, errorCode, errorSummary, now, operationId)
}

async function markInterruptedUnknown(database: D1Database, operationId: string, now: number) {
  await database.batch([
    database
      .prepare(
        `UPDATE mail_forward_attempts
         SET attempt_status = 'unknown', completed_at = ?1,
             error_code = 'interrupted_submission_result_unknown',
             error_summary = 'Worker 中断后无法判断发信服务是否接受邮件', updated_at = ?1
         WHERE mail_forward_operation_id = ?2 AND attempt_status = 'submitting'`,
      )
      .bind(now, operationId),
    finishOperationStatement(
      database,
      operationId,
      'unknown',
      null,
      'interrupted_submission_result_unknown',
      'Worker 中断后无法判断发信服务是否接受邮件',
      now,
    ),
  ])
}

async function calculateParsedPayload(options: {
  messageId: string
  deliveryId: string
  ruleId: string
  ruleVersion: number
  senderAddress: string
  targetAddress: string
  hopCount: number
  sourceSizeBytes: number
  parsed: ParsedIncomingMail
}) {
  return calculatePayload({
    messageId: options.messageId,
    deliveryId: options.deliveryId,
    ruleId: options.ruleId,
    ruleVersion: options.ruleVersion,
    senderAddress: options.senderAddress,
    targetAddress: options.targetAddress,
    hopCount: options.hopCount,
    sourceSizeBytes: options.sourceSizeBytes,
    subject: options.parsed.subject,
    addresses: options.parsed.headerAddresses.map((address) => ({
      role: address.role,
      sequence: address.sequenceNumber,
      address: address.addressText,
    })),
    objects: options.parsed.objects
      .filter((object) => object.objectRole !== 'inline_resource')
      .map((object) => ({
        role: object.objectRole,
        sequence: object.sequenceNumber,
        size: object.bytes.byteLength,
        digest: bytesToHex(object.sha256),
        mediaType: object.mediaType,
        fileName: object.untrustedFileName,
      })),
  })
}

async function calculateStoredPayload(options: {
  operation: ExecutionRow
  objects: StoredObjectRow[]
  addresses: HeaderAddressRow[]
}) {
  return calculatePayload({
    messageId: options.operation.source_message_id,
    deliveryId: options.operation.message_delivery_id,
    ruleId: options.operation.mail_forwarding_rule_id,
    ruleVersion: options.operation.rule_version,
    senderAddress: options.operation.sender_address,
    targetAddress: options.operation.target_canonical_email_address,
    hopCount: options.operation.forwarding_hop_count,
    sourceSizeBytes: options.operation.source_size_bytes,
    subject: options.operation.subject,
    addresses: options.addresses.map((address) => ({
      role: address.address_role,
      sequence: address.sequence_number,
      address: address.address_text,
    })),
    objects: options.objects.map((object) => ({
      role: object.object_role,
      sequence: object.sequence_number,
      size: object.expected_size_bytes,
      digest: bytesToHex(new Uint8Array(object.expected_sha256)),
      mediaType: object.media_type,
      fileName: object.untrusted_file_name,
    })),
  })
}

async function calculatePayload(options: {
  messageId: string
  deliveryId: string
  ruleId: string
  ruleVersion: number
  senderAddress: string
  targetAddress: string
  hopCount: number
  sourceSizeBytes: number
  subject: string
  addresses: Array<{ role: string; sequence: number; address: string }>
  objects: Array<{
    role: string
    sequence: number
    size: number
    digest: string
    mediaType: string
    fileName: string | null
  }>
}) {
  const addresses = [...options.addresses].sort((left, right) =>
    `${left.role}:${left.sequence}:${left.address}`.localeCompare(
      `${right.role}:${right.sequence}:${right.address}`,
    ),
  )
  const objects = [...options.objects].sort((left, right) =>
    `${left.role}:${left.sequence}:${left.digest}`.localeCompare(
      `${right.role}:${right.sequence}:${right.digest}`,
    ),
  )
  const canonical = JSON.stringify({
    version: 1,
    messageId: options.messageId,
    deliveryId: options.deliveryId,
    ruleId: options.ruleId,
    ruleVersion: options.ruleVersion,
    senderAddress: options.senderAddress,
    targetAddress: options.targetAddress,
    hopCount: options.hopCount,
    subject: options.subject,
    addresses,
    objects,
  })
  return {
    digest: await sha256Bytes(canonical),
    size: options.sourceSizeBytes,
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
