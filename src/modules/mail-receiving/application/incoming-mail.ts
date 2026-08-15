import {
  normalizeCompleteEmailAddress,
  normalizeRecipientEmailAddress,
} from '../../addresses/domain/email-address'
import { prepareForwardingWork } from '../../forwarding/public'
import { prepareInitialMessageConversationWork } from '../../mail-conversations/public'
import { prepareInitialMessageSearchWork } from '../../mail-search/public'
import { prepareNotificationWork } from '../../notifications/public'
import {
  commitPlatformCapacityReservation,
  PlatformCapacityUnavailableError,
  releasePlatformCapacityReservation,
  reservePlatformCapacity,
  type PlatformCapacityReservation,
} from '../../platform-resources/public'
import {
  logicalStorageCommitStatements,
  LogicalStorageCapacityError,
  releaseLogicalStorageReservation,
  releaseLogicalStorageReservationByReference,
  reserveLogicalStorage,
  type LogicalStorageReservation,
} from '../../storage-quotas/public'
import type { BackgroundTaskExecutionResult } from '../../tasks/application/background-task-service'
import type { BackgroundTaskMessage } from '../../../shared/contracts/background-task'
import type { StorageMode } from '../../../shared/contracts/storage-mode'
import { bytesToHex, equalBytes, sha256Bytes } from '../domain/content-digest'
import {
  MimeBoundaryError,
  MIME_PARSER_VERSION,
  parseIncomingMime,
  type ParsedIncomingMail,
  type ParsedMailObject,
} from '../domain/mime-parser'
import type { MailObjectStore } from '../infrastructure/object-storage'

const MAX_RAW_MESSAGE_BYTES = 20_000_000
const DEDUPLICATION_WINDOW_MS = 60 * 60 * 1000
const PARSE_TASK_MAX_ATTEMPTS = 5
const ROUTE_COMMIT_TASK_MAX_ATTEMPTS = 5

interface AssignedAcceptedRoute {
  route_kind: 'assigned'
  domain_id: string
  address_id: string
  address_binding_id: string
  owner_type: 'user' | 'organization'
  user_id: string | null
  organization_id: string | null
  display_address: string
}

interface UnallocatedAcceptedRoute {
  route_kind: 'unallocated'
  domain_id: string
  canonical_address: string
  display_address: string
}

type AcceptedRoute = AssignedAcceptedRoute | UnallocatedAcceptedRoute

interface ActiveRejectionRuleRow {
  rule_type: 'sender_address' | 'sender_domain' | 'subject_keyword' | 'body_keyword'
  match_value: string
}

interface ReceiveOperationRow {
  id: string
  deduplication_key_digest: ArrayBuffer
  message_reference: string
  message_id: string | null
  raw_object_id: string | null
  raw_size_bytes: number
  raw_sha256: ArrayBuffer
  operation_status: string
  parser_version: string | null
  error_code: string | null
  accepted_at: number
}

interface ObjectRegistryRow {
  id: string
  object_key: string
  object_status: string
  expected_size_bytes: number
  expected_sha256: ArrayBuffer
  backend_version_reference: string | null
}

interface AssignedReceiveRoute {
  route_kind: 'assigned'
  id: string
  sequence_number: number
  canonical_recipient_address: string
  display_recipient_address: string
  domain_id: string
  address_id: string
  address_binding_id: string
  owner_type: 'user' | 'organization'
  user_id: string | null
  organization_id: string | null
}

interface UnallocatedReceiveRoute {
  route_kind: 'unallocated'
  id: string
  sequence_number: number
  canonical_recipient_address: string
  display_recipient_address: string
  domain_id: string
  unallocated_period_id: string
}

type ReceiveRoute = AssignedReceiveRoute | UnallocatedReceiveRoute

export interface IncomingEmailMessage {
  from: string
  to: string
  rawSize: number
  raw: ReadableStream<Uint8Array>
  setReject(reason: string): void
}

export type ReceiveIncomingMailResult =
  | {
      status: 'rejected'
      reason:
        | 'recipient_unavailable'
        | 'rejection_rule_matched'
        | 'content_inspection_failed'
        | 'message_too_large'
        | 'resource_capacity_unavailable'
        | 'storage_quota_exceeded'
    }
  | { status: 'accepted'; operationId: string; duplicate: boolean }

export async function receiveIncomingMail(options: {
  database: D1Database
  queue: Queue<BackgroundTaskMessage>
  store: MailObjectStore
  message: IncomingEmailMessage
  now?: number
}): Promise<ReceiveIncomingMailResult> {
  const now = options.now ?? Date.now()
  let canonicalRecipient: string
  try {
    canonicalRecipient = normalizeCompleteEmailAddress(options.message.to).canonicalAddress
  } catch {
    options.message.setReject('Recipient address is not available.')
    return { status: 'rejected', reason: 'recipient_unavailable' }
  }

  const route = await findAcceptedRoute(options.database, canonicalRecipient, options.store.mode)
  if (!route) {
    options.message.setReject('Recipient address is not available.')
    return { status: 'rejected', reason: 'recipient_unavailable' }
  }
  if (options.message.rawSize > MAX_RAW_MESSAGE_BYTES) {
    options.message.setReject('Message exceeds the 20 MB limit.')
    return { status: 'rejected', reason: 'message_too_large' }
  }

  const rejectionRules = await readActiveRejectionRules(options.database)
  if (matchesEnvelopeRejectionRule(rejectionRules, options.message.from)) {
    options.message.setReject('Message rejected by the recipient policy.')
    return { status: 'rejected', reason: 'rejection_rule_matched' }
  }

  const raw = await new Response(options.message.raw).arrayBuffer()
  if (raw.byteLength > MAX_RAW_MESSAGE_BYTES) {
    options.message.setReject('Message exceeds the 20 MB limit.')
    return { status: 'rejected', reason: 'message_too_large' }
  }

  if (hasContentRejectionRules(rejectionRules)) {
    let preview: ParsedIncomingMail
    try {
      preview = await parseIncomingMime(raw)
    } catch {
      options.message.setReject('Message could not be safely inspected.')
      return { status: 'rejected', reason: 'content_inspection_failed' }
    }
    if (await matchesContentRejectionRule(rejectionRules, preview)) {
      options.message.setReject('Message rejected by the recipient policy.')
      return { status: 'rejected', reason: 'rejection_rule_matched' }
    }
  }

  const rawSha256 = await sha256Bytes(raw)
  const windowStartedAt = Math.floor(now / DEDUPLICATION_WINDOW_MS) * DEDUPLICATION_WINDOW_MS
  const deduplicationDigest = await sha256Bytes(
    [
      'cloudflare_email_routing',
      String(windowStartedAt),
      options.message.from.trim().toLowerCase(),
      bytesToHex(rawSha256),
    ].join('\n'),
  )
  const existing = await readOperationByDigest(options.database, deduplicationDigest)
  const recordedRoute = existing
    ? await readReceiveRouteState(options.database, existing.id, canonicalRecipient)
    : null
  const routeAlreadyRecorded = Boolean(recordedRoute)
  if (existing && recordedRoute) {
    if (recordedRoute.route_status === 'committed') {
      return { status: 'accepted', operationId: existing.id, duplicate: true }
    }
    if (existing.operation_status === 'visible' && recordedRoute.route_status === 'accepted') {
      const task = await ensureRouteCommitTask(options.database, recordedRoute.id, now)
      await options.queue.send({ taskId: task.id, inputVersion: 1 })
      return { status: 'accepted', operationId: existing.id, duplicate: true }
    }
    if (
      ['parse_failed', 'damaged', 'rejected', 'needs_attention'].includes(existing.operation_status)
    ) {
      return { status: 'accepted', operationId: existing.id, duplicate: true }
    }
  }

  let reservation: PlatformCapacityReservation | null = null
  const logicalReference = `receive:${bytesToHex(deduplicationDigest)}`
  let logicalReservation: LogicalStorageReservation | null = null
  const ownerAlreadyHasVisibleEntry =
    route.route_kind === 'assigned' &&
    existing?.operation_status === 'visible' &&
    (await hasMailboxEntryForRoute(options.database, existing.message_reference, route))
  if (route.route_kind === 'assigned' && !routeAlreadyRecorded && !ownerAlreadyHasVisibleEntry) {
    const logicalOwner =
      route.owner_type === 'user'
        ? { ownerType: 'user' as const, ownerId: route.user_id! }
        : { ownerType: 'organization' as const, ownerId: route.organization_id! }
    try {
      logicalReservation = await reserveLogicalStorage({
        database: options.database,
        storageMode: options.store.mode,
        owner: logicalOwner,
        operationKind: 'receive',
        operationReference: logicalReference,
        bytes: raw.byteLength,
        now,
      })
    } catch (error) {
      if (error instanceof LogicalStorageCapacityError) {
        options.message.setReject('Mailbox storage quota is full.')
        return { status: 'rejected', reason: 'storage_quota_exceeded' }
      }
      throw error
    }
  }
  if (!existing) {
    try {
      reservation = await reservePlatformCapacity({
        database: options.database,
        storageMode: options.store.mode,
        operationKind: 'receive',
        operationReference: logicalReference,
        d1EstimatedBytes: Math.max(128_000, Math.ceil(raw.byteLength * 0.25)),
        objectEstimatedBytes: raw.byteLength * 2 + 128_000,
        now,
      })
    } catch (error) {
      if (error instanceof PlatformCapacityUnavailableError) {
        await releaseCreatedLogicalStorageReservation(options.database, logicalReservation, now)
        options.message.setReject('System storage capacity is unavailable.')
        return { status: 'rejected', reason: 'resource_capacity_unavailable' }
      }
      throw error
    }
  }

  let intent
  try {
    intent = await ensureReceiveIntent({
      database: options.database,
      route,
      canonicalRecipient,
      envelopeSender: options.message.from,
      raw,
      rawSha256,
      deduplicationDigest,
      windowStartedAt,
      now,
      storageMode: options.store.mode,
    })
  } catch (error) {
    if (reservation) {
      await releasePlatformCapacityReservation({ database: options.database, reservation, now })
    }
    await releaseCreatedLogicalStorageReservation(options.database, logicalReservation, now)
    throw error
  }

  if (!intent.routeAdded) {
    if (
      intent.operation.operation_status === 'visible' ||
      ['parse_failed', 'damaged', 'rejected', 'needs_attention'].includes(
        intent.operation.operation_status,
      )
    ) {
      return { status: 'accepted', operationId: intent.operation.id, duplicate: true }
    }
  }

  if (intent.operation.operation_status === 'visible') {
    if (reservation) {
      await releasePlatformCapacityReservation({ database: options.database, reservation, now })
    }
    const task = await ensureRouteCommitTask(options.database, intent.routeId, now)
    await options.queue.send({ taskId: task.id, inputVersion: 1 })
    return { status: 'accepted', operationId: intent.operation.id, duplicate: false }
  }
  if (
    ['parse_failed', 'damaged', 'rejected', 'needs_attention'].includes(
      intent.operation.operation_status,
    )
  ) {
    if (reservation) {
      await releasePlatformCapacityReservation({ database: options.database, reservation, now })
    }
    await releaseCreatedLogicalStorageReservation(options.database, logicalReservation, now)
    return { status: 'accepted', operationId: intent.operation.id, duplicate: false }
  }

  if (reservation) {
    await commitPlatformCapacityReservation({ database: options.database, reservation, now })
  }
  await ensureRawObjectStored({
    database: options.database,
    store: options.store,
    operation: intent.operation,
    rawObject: intent.rawObject,
    raw,
    rawSha256,
    now,
  })
  const task = await ensureParseTask(options.database, intent.operation.id, now)
  await options.queue.send({ taskId: task.id, inputVersion: 1 })
  if (intent.operationExisted && intent.routeAdded) {
    const routeTask = await ensureRouteCommitTask(options.database, intent.routeId, now)
    await options.queue.send({ taskId: routeTask.id, inputVersion: 1 })
  }
  return {
    status: 'accepted',
    operationId: intent.operation.id,
    duplicate: !intent.routeAdded,
  }
}

export async function processReceiveParsingTask(options: {
  database: D1Database
  store: MailObjectStore
  queue?: Queue<BackgroundTaskMessage>
  operationId: string
  now?: number
}): Promise<BackgroundTaskExecutionResult> {
  const now = options.now ?? Date.now()
  let operation = await readReceiveOperation(options.database, options.operationId)
  if (!operation) return { status: 'needs_attention', errorCode: 'receive_operation_missing' }
  if (operation.operation_status === 'visible') {
    await wakePendingMessageTasks(options.database, options.queue, operation.message_reference)
    return { status: 'succeeded' }
  }
  if (
    ['parse_failed', 'damaged', 'rejected', 'needs_attention'].includes(operation.operation_status)
  ) {
    return {
      status: 'needs_attention',
      errorCode: operation.error_code ?? 'receive_operation_needs_attention',
    }
  }

  const rawObject = await readRawObject(options.database, operation.message_reference)
  if (!rawObject) return { status: 'needs_attention', errorCode: 'raw_object_missing' }
  const rawStored = await options.store.get(rawObject.object_key)
  if (!rawStored) throw new Error('原始邮件对象暂时不可用')
  const rawDigest = await sha256Bytes(rawStored.bytes)
  if (
    rawStored.bytes.byteLength !== operation.raw_size_bytes ||
    !equalBytes(rawDigest, operation.raw_sha256)
  ) {
    await markReceiveDamaged(
      options.database,
      operation,
      'raw_object_mismatch',
      rawStored.bytes.byteLength,
      rawDigest,
      now,
    )
    return { status: 'needs_attention', errorCode: 'raw_object_mismatch' }
  }

  if (!['verified', 'active'].includes(rawObject.object_status)) {
    await options.database.batch([
      options.database
        .prepare(
          `UPDATE object_registry
           SET object_status = 'verified', actual_size_bytes = ?1, actual_sha256 = ?2,
               backend_version_reference = ?3, stored_at = COALESCE(stored_at, ?4),
               verified_at = ?4, consistency_checked_at = ?4, updated_at = ?4
           WHERE id = ?5 AND object_status IN ('write_intent', 'stored', 'waiting_consistency')`,
        )
        .bind(
          rawStored.bytes.byteLength,
          rawDigest,
          rawStored.backendVersionReference,
          now,
          rawObject.id,
        ),
      options.database
        .prepare(
          `UPDATE receive_operations
           SET raw_object_id = ?1, operation_status = 'raw_stored', updated_at = ?2
           WHERE id = ?3 AND operation_status = 'intent'`,
        )
        .bind(rawObject.id, now, operation.id),
    ])
    operation = (await readReceiveOperation(options.database, operation.id)) ?? operation
  }

  if (operation.operation_status === 'raw_stored') {
    await options.database
      .prepare(
        `UPDATE receive_operations
         SET operation_status = 'parsing', parser_version = ?1, updated_at = ?2
         WHERE id = ?3 AND operation_status = 'raw_stored'`,
      )
      .bind(MIME_PARSER_VERSION, now, operation.id)
      .run()
    operation = (await readReceiveOperation(options.database, operation.id)) ?? operation
  }

  let parsed: ParsedIncomingMail
  try {
    parsed = await parseIncomingMime(rawStored.bytes)
  } catch (error) {
    const errorCode = error instanceof MimeBoundaryError ? error.code : 'mime_parse_failed'
    await markReceiveParseFailed(options.database, operation, errorCode, now)
    return { status: 'needs_attention', errorCode }
  }

  let waitingForConsistency = false
  for (const part of parsed.objects) {
    const object = await ensureDerivedObjectIntent(
      options.database,
      options.store.mode,
      operation.message_reference,
      part,
      now,
    )
    const ready = await ensureDerivedObjectStored(
      options.store,
      options.database,
      object,
      part,
      now,
    )
    if (!ready) waitingForConsistency = true
  }

  if (operation.operation_status === 'parsing') {
    await options.database
      .prepare(
        `UPDATE receive_operations
         SET operation_status = 'derived_stored', parsed_part_count = ?1, updated_at = ?2
         WHERE id = ?3 AND operation_status = 'parsing'`,
      )
      .bind(parsed.partCount, now, operation.id)
      .run()
    operation = (await readReceiveOperation(options.database, operation.id)) ?? operation
  }

  if (waitingForConsistency) {
    if (operation.operation_status === 'derived_stored') {
      await options.database
        .prepare(
          `UPDATE receive_operations
           SET operation_status = 'waiting_consistency', updated_at = ?1
           WHERE id = ?2 AND operation_status = 'derived_stored'`,
        )
        .bind(now, operation.id)
        .run()
    }
    throw new Error('KV 邮件对象仍在等待一致性复核')
  }

  if (
    operation.operation_status === 'derived_stored' ||
    operation.operation_status === 'waiting_consistency'
  ) {
    await options.database
      .prepare(
        `UPDATE receive_operations
         SET operation_status = 'committing', updated_at = ?1
         WHERE id = ?2 AND operation_status IN ('derived_stored', 'waiting_consistency')`,
      )
      .bind(now, operation.id)
      .run()
  }
  const tasks = await commitVisibleMessage(
    options.database,
    options.store.mode,
    operation,
    parsed,
    now,
  )
  await wakeMessageTasks(options.queue, tasks)
  return { status: 'succeeded' }
}

export async function processReceiveRouteCommitTask(options: {
  database: D1Database
  store: MailObjectStore
  queue?: Queue<BackgroundTaskMessage>
  routeId: string
  now?: number
}): Promise<BackgroundTaskExecutionResult> {
  const now = options.now ?? Date.now()
  const operation = await readReceiveOperationByRouteId(options.database, options.routeId)
  if (!operation) return { status: 'needs_attention', errorCode: 'receive_route_missing' }
  const routes = await readAcceptedReceiveRoutes(options.database, operation.id)
  if (routes.length === 0) return { status: 'succeeded' }
  if (operation.operation_status !== 'visible') {
    if (
      ['parse_failed', 'damaged', 'rejected', 'needs_attention'].includes(
        operation.operation_status,
      )
    ) {
      return {
        status: 'needs_attention',
        errorCode: operation.error_code ?? 'receive_operation_needs_attention',
      }
    }
    throw new Error('物理邮件尚未可见，收信补交付稍后重试')
  }

  const rawObject = await readRawObject(options.database, operation.message_reference)
  if (!rawObject) return { status: 'needs_attention', errorCode: 'raw_object_missing' }
  const rawStored = await options.store.get(rawObject.object_key)
  if (!rawStored) throw new Error('收信补交付暂时无法读取原始邮件')
  const rawDigest = await sha256Bytes(rawStored.bytes)
  if (
    rawStored.bytes.byteLength !== operation.raw_size_bytes ||
    !equalBytes(rawDigest, operation.raw_sha256)
  ) {
    return { status: 'needs_attention', errorCode: 'raw_object_mismatch' }
  }

  let parsed: ParsedIncomingMail
  try {
    parsed = await parseIncomingMime(rawStored.bytes)
  } catch (error) {
    return {
      status: 'needs_attention',
      errorCode: error instanceof MimeBoundaryError ? error.code : 'mime_parse_failed',
    }
  }
  const work = await prepareReceiveRouteCommitWork({
    database: options.database,
    storageMode: options.store.mode,
    operation,
    parsed,
    routes,
    now,
  })
  const results = await options.database.batch([...work.statements, ...work.completionStatements])
  if (results.some((result) => result.meta.changes < 1)) {
    throw new Error('收信补交付事务没有完整提交')
  }
  await wakeMessageTasks(options.queue, work.messages)
  return { status: 'succeeded' }
}

async function findAcceptedRoute(
  database: D1Database,
  canonicalRecipient: string,
  storageMode: StorageMode,
): Promise<AcceptedRoute | null> {
  const assigned = await database
    .prepare(
      `SELECT
        'assigned' AS route_kind,
        domain.id AS domain_id,
        address.id AS address_id,
        binding.id AS address_binding_id,
        binding.owner_type,
        binding.user_id,
        binding.organization_id,
        address.display_address
       FROM email_addresses AS address
       JOIN system_instances AS system
         ON system.singleton_id = 1
        AND system.storage_mode = ?2
       JOIN address_claims AS claim
         ON claim.address_id = address.id
        AND claim.canonical_address = address.canonical_address
        AND claim.status = 'active'
        AND claim.reserved_until IS NULL
       JOIN mail_domains AS domain
         ON domain.id = address.domain_id
        AND domain.status = 'active'
       LEFT JOIN inbound_receive_controls AS domain_control
         ON domain_control.scope_type = 'domain'
        AND domain_control.domain_id = domain.id
       LEFT JOIN inbound_receive_controls AS address_control
         ON address_control.scope_type = 'address'
        AND address_control.address_id = address.id
       JOIN address_bindings AS binding
         ON binding.address_id = address.id
        AND binding.ended_at IS NULL
       LEFT JOIN users AS user ON user.id = binding.user_id
       LEFT JOIN inbound_receive_controls AS user_control
         ON user_control.scope_type = 'user'
        AND user_control.user_id = user.id
       LEFT JOIN organizations AS organization ON organization.id = binding.organization_id
       WHERE address.canonical_address = ?1
         AND address.retired_at IS NULL
         AND COALESCE(domain_control.receive_status, 'accepting') = 'accepting'
         AND COALESCE(address_control.receive_status, 'accepting') = 'accepting'
         AND (
           (binding.owner_type = 'user'
             AND user.status = 'active'
             AND COALESCE(user_control.receive_status, 'accepting') = 'accepting')
           OR (binding.owner_type = 'organization' AND organization.status = 'active')
         )
       LIMIT 1`,
    )
    .bind(canonicalRecipient, storageMode)
    .first<AssignedAcceptedRoute>()
  if (assigned) return assigned

  const unallocated = await database
    .prepare(
      `SELECT
        'unallocated' AS route_kind,
        domain.id AS domain_id,
        ?1 AS canonical_address,
        ?1 AS display_address
       FROM mail_domains AS domain
       JOIN system_instances AS system
         ON system.singleton_id = 1 AND system.storage_mode = ?2
       LEFT JOIN inbound_receive_controls AS domain_control
         ON domain_control.scope_type = 'domain'
        AND domain_control.domain_id = domain.id
       WHERE domain.canonical_name = substr(?1, instr(?1, '@') + 1)
         AND domain.status = 'active'
         AND domain.catch_all_mode = 'unallocated'
         AND COALESCE(domain_control.receive_status, 'accepting') = 'accepting'
         AND NOT EXISTS (
           SELECT 1
           FROM email_addresses AS address
           JOIN address_claims AS claim
             ON claim.address_id = address.id
            AND claim.canonical_address = address.canonical_address
            AND claim.status = 'active'
            AND claim.reserved_until IS NULL
           WHERE address.canonical_address = ?1
             AND address.retired_at IS NULL
         )
       LIMIT 1`,
    )
    .bind(canonicalRecipient, storageMode)
    .first<UnallocatedAcceptedRoute>()
  return unallocated ?? null
}

async function readActiveRejectionRules(database: D1Database): Promise<ActiveRejectionRuleRow[]> {
  const result = await database
    .prepare(
      `SELECT rule_type, match_value
       FROM inbound_rejection_rules
       WHERE rule_status = 'active'
       ORDER BY created_at, id`,
    )
    .all<ActiveRejectionRuleRow>()
  return result.results
}

function matchesEnvelopeRejectionRule(
  rules: ActiveRejectionRuleRow[],
  envelopeSender: string,
): boolean {
  let canonicalAddress: string | null = null
  let canonicalDomain: string | null = null
  try {
    const normalized = normalizeRecipientEmailAddress(envelopeSender)
    canonicalAddress = normalized.canonicalAddress
    canonicalDomain = normalized.canonicalDomain
  } catch {
    // 空退信地址或非标准信封发件人不能命中规范地址规则。
  }
  return rules.some(
    (rule) =>
      (rule.rule_type === 'sender_address' && rule.match_value === canonicalAddress) ||
      (rule.rule_type === 'sender_domain' && rule.match_value === canonicalDomain),
  )
}

function hasContentRejectionRules(rules: ActiveRejectionRuleRow[]): boolean {
  return rules.some(
    (rule) => rule.rule_type === 'subject_keyword' || rule.rule_type === 'body_keyword',
  )
}

async function matchesContentRejectionRule(
  rules: ActiveRejectionRuleRow[],
  parsed: ParsedIncomingMail,
): Promise<boolean> {
  const subject = normalizeRuleText(parsed.subject)
  const subjectRules = rules.filter((rule) => rule.rule_type === 'subject_keyword')
  if (subjectRules.some((rule) => subject.includes(rule.match_value))) return true

  const bodyRules = rules.filter((rule) => rule.rule_type === 'body_keyword')
  if (bodyRules.length === 0) return false
  const bodyParts: string[] = []
  for (const object of parsed.objects) {
    if (object.objectRole === 'plain_body') {
      bodyParts.push(new TextDecoder().decode(object.bytes))
    } else if (object.objectRole === 'html_body') {
      bodyParts.push(await extractVisibleTextFromHtml(new TextDecoder().decode(object.bytes)))
    }
  }
  const body = normalizeRuleText(bodyParts.join('\n'))
  return bodyRules.some((rule) => body.includes(rule.match_value))
}

function normalizeRuleText(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase()
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

async function readReceiveRouteState(
  database: D1Database,
  operationId: string,
  canonicalRecipient: string,
): Promise<{ id: string; route_status: string } | null> {
  return database
    .prepare(
      `SELECT id, route_status FROM receive_operation_routes
       WHERE receive_operation_id = ?1 AND canonical_recipient_address = ?2
       UNION ALL
       SELECT id, route_status FROM receive_operation_unallocated_routes
       WHERE receive_operation_id = ?1 AND canonical_recipient_address = ?2
       LIMIT 1`,
    )
    .bind(operationId, canonicalRecipient)
    .first<{ id: string; route_status: string }>()
}

async function hasMailboxEntryForRoute(
  database: D1Database,
  messageId: string,
  route: AssignedAcceptedRoute,
): Promise<boolean> {
  const ownerColumn = route.owner_type === 'user' ? 'user_id' : 'organization_id'
  const ownerId = route.owner_type === 'user' ? route.user_id : route.organization_id
  const row = await database
    .prepare(
      `SELECT id FROM mailbox_entries
       WHERE message_id = ?1 AND mailbox_type = ?2 AND ${ownerColumn} = ?3
         AND entry_kind = 'received'
       LIMIT 1`,
    )
    .bind(messageId, route.owner_type, ownerId)
    .first<{ id: string }>()
  return Boolean(row)
}

async function releaseCreatedLogicalStorageReservation(
  database: D1Database,
  reservation: LogicalStorageReservation | null,
  now: number,
): Promise<void> {
  if (!reservation?.created) return
  await releaseLogicalStorageReservation({ database, reservation, now })
}

async function ensureReceiveRoute(options: {
  database: D1Database
  operationId: string
  route: AcceptedRoute
  canonicalRecipient: string
  now: number
}): Promise<{ id: string; added: boolean }> {
  const current = await readReceiveRouteIdentity(
    options.database,
    options.operationId,
    options.canonicalRecipient,
  )
  if (current) return { id: current.id, added: false }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const routeId = crypto.randomUUID()
    const sequence = await nextReceiveRouteSequence(options.database, options.operationId)
    try {
      if (options.route.route_kind === 'assigned') {
        await options.database
          .prepare(
            `INSERT INTO receive_operation_routes (
              id, receive_operation_id, sequence_number,
              canonical_recipient_address, display_recipient_address,
              domain_id, address_id, address_binding_id, owner_type,
              user_id, organization_id, route_status, rejection_code,
              delivery_id, created_at, committed_at
             ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
              'accepted', NULL, NULL, ?12, NULL
             )`,
          )
          .bind(
            routeId,
            options.operationId,
            sequence,
            options.canonicalRecipient,
            options.route.display_address,
            options.route.domain_id,
            options.route.address_id,
            options.route.address_binding_id,
            options.route.owner_type,
            options.route.user_id,
            options.route.organization_id,
            options.now,
          )
          .run()
      } else {
        const periodCandidateId = crypto.randomUUID()
        await options.database.batch([
          options.database
            .prepare(
              `INSERT OR IGNORE INTO unallocated_address_periods (
                id, domain_id, canonical_address, display_address, period_status,
                started_at, closed_at, claimed_by_user_id, claimed_address_id,
                claimed_address_binding_id, created_at, updated_at
               ) VALUES (?1, ?2, ?3, ?4, 'open', ?5, NULL, NULL, NULL, NULL, ?5, ?5)`,
            )
            .bind(
              periodCandidateId,
              options.route.domain_id,
              options.route.canonical_address,
              options.route.display_address,
              options.now,
            ),
          options.database
            .prepare(
              `INSERT INTO receive_operation_unallocated_routes (
                id, receive_operation_id, sequence_number,
                canonical_recipient_address, display_recipient_address,
                domain_id, unallocated_period_id, route_status,
                delivery_id, created_at, committed_at
               )
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, period.id,
                      'accepted', NULL, ?7, NULL
               FROM unallocated_address_periods AS period
               WHERE period.canonical_address = ?4
                 AND period.domain_id = ?6
                 AND period.period_status = 'open'
               LIMIT 1`,
            )
            .bind(
              routeId,
              options.operationId,
              sequence,
              options.route.canonical_address,
              options.route.display_address,
              options.route.domain_id,
              options.now,
            ),
        ])
      }
      return { id: routeId, added: true }
    } catch (error) {
      const raced = await readReceiveRouteIdentity(
        options.database,
        options.operationId,
        options.canonicalRecipient,
      )
      if (raced) return { id: raced.id, added: false }
      if (attempt === 2) throw error
    }
  }
  throw new Error('收信路由没有建立')
}

async function readReceiveRouteIdentity(
  database: D1Database,
  operationId: string,
  canonicalRecipient: string,
): Promise<{ id: string } | null> {
  return database
    .prepare(
      `SELECT id FROM receive_operation_routes
       WHERE receive_operation_id = ?1 AND canonical_recipient_address = ?2
       UNION ALL
       SELECT id FROM receive_operation_unallocated_routes
       WHERE receive_operation_id = ?1 AND canonical_recipient_address = ?2
       LIMIT 1`,
    )
    .bind(operationId, canonicalRecipient)
    .first<{ id: string }>()
}

async function nextReceiveRouteSequence(
  database: D1Database,
  operationId: string,
): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COALESCE(MAX(sequence_number), -1) + 1 AS next_sequence
       FROM (
         SELECT sequence_number FROM receive_operation_routes WHERE receive_operation_id = ?1
         UNION ALL
         SELECT sequence_number FROM receive_operation_unallocated_routes WHERE receive_operation_id = ?1
       )`,
    )
    .bind(operationId)
    .first<{ next_sequence: number }>()
  return row?.next_sequence ?? 0
}

async function ensureReceiveIntent(options: {
  database: D1Database
  route: AcceptedRoute
  canonicalRecipient: string
  envelopeSender: string
  raw: ArrayBuffer
  rawSha256: Uint8Array
  deduplicationDigest: Uint8Array
  windowStartedAt: number
  now: number
  storageMode: StorageMode
}): Promise<{
  operation: ReceiveOperationRow
  rawObject: ObjectRegistryRow
  routeId: string
  routeAdded: boolean
  operationExisted: boolean
}> {
  const existing = await readOperationByDigest(options.database, options.deduplicationDigest)
  if (existing) {
    const rawObject = await readRawObject(options.database, existing.message_reference)
    if (!rawObject) throw new Error('重复收信操作缺少原始对象登记')
    const route = await ensureReceiveRoute({
      database: options.database,
      operationId: existing.id,
      route: options.route,
      canonicalRecipient: options.canonicalRecipient,
      now: options.now,
    })
    return {
      operation: existing,
      rawObject,
      routeId: route.id,
      routeAdded: route.added,
      operationExisted: true,
    }
  }

  const operationId = crypto.randomUUID()
  const messageReference = crypto.randomUUID()
  const rawObjectId = crypto.randomUUID()
  const routeId = crypto.randomUUID()
  const periodCandidateId = crypto.randomUUID()
  const objectKey = `mail/messages/${messageReference}/raw_mime/body/v1`
  try {
    const statements: D1PreparedStatement[] = [
      options.database
        .prepare(
          `INSERT INTO receive_operations (
            id, source_kind, source_event_reference, deduplication_kind,
            deduplication_key_digest, deduplication_window_started_at,
            deduplication_expires_at, message_reference, message_id,
            raw_object_id, raw_size_bytes, raw_sha256, envelope_sender_text,
            operation_status, parser_version, parsed_part_count,
            error_code, error_summary, accepted_at, visible_at,
            completed_at, created_at, updated_at
           ) VALUES (
            ?1, 'cloudflare_email_routing', NULL, 'bounded_fingerprint',
            ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7, ?8,
            'intent', NULL, NULL, NULL, NULL, ?9, NULL, NULL, ?9, ?9
           )`,
        )
        .bind(
          operationId,
          options.deduplicationDigest,
          options.windowStartedAt,
          options.windowStartedAt + DEDUPLICATION_WINDOW_MS,
          messageReference,
          options.raw.byteLength,
          options.rawSha256,
          options.envelopeSender,
          options.now,
        ),
      options.database
        .prepare(
          `INSERT INTO object_registry (
            id, storage_mode, object_key, owner_kind, owner_reference, message_id,
            object_role, logical_part_key, sequence_number, generation,
            required_for_visibility, is_current, expected_size_bytes,
            expected_sha256, actual_size_bytes, actual_sha256, media_type,
            untrusted_file_name, content_disposition, content_id, producer_version,
            backend_version_reference, object_status, stored_at, verified_at,
            consistency_checked_at, activated_at, superseded_at, delete_after,
            deleted_at, created_at, updated_at
           ) VALUES (
            ?1, ?2, ?3, 'message', ?4, NULL, 'raw_mime', 'body', 0, 1,
            1, 0, ?5, ?6, NULL, NULL, 'message/rfc822', NULL, NULL, NULL,
            'cloudflare-email-handler-v1', NULL, 'write_intent', NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, ?7, ?7
           )`,
        )
        .bind(
          rawObjectId,
          options.storageMode,
          objectKey,
          messageReference,
          options.raw.byteLength,
          options.rawSha256,
          options.now,
        ),
    ]
    if (options.route.route_kind === 'assigned') {
      statements.push(
        options.database
          .prepare(
            `INSERT INTO receive_operation_routes (
              id, receive_operation_id, sequence_number,
              canonical_recipient_address, display_recipient_address,
              domain_id, address_id, address_binding_id, owner_type,
              user_id, organization_id, route_status, rejection_code,
              delivery_id, created_at, committed_at
             ) VALUES (
              ?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
              'accepted', NULL, NULL, ?11, NULL
             )`,
          )
          .bind(
            routeId,
            operationId,
            options.canonicalRecipient,
            options.route.display_address,
            options.route.domain_id,
            options.route.address_id,
            options.route.address_binding_id,
            options.route.owner_type,
            options.route.user_id,
            options.route.organization_id,
            options.now,
          ),
      )
    } else {
      statements.push(
        options.database
          .prepare(
            `INSERT OR IGNORE INTO unallocated_address_periods (
              id, domain_id, canonical_address, display_address, period_status,
              started_at, closed_at, claimed_by_user_id, claimed_address_id,
              claimed_address_binding_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'open', ?5, NULL, NULL, NULL, NULL, ?5, ?5)`,
          )
          .bind(
            periodCandidateId,
            options.route.domain_id,
            options.route.canonical_address,
            options.route.display_address,
            options.now,
          ),
        options.database
          .prepare(
            `INSERT INTO receive_operation_unallocated_routes (
              id, receive_operation_id, sequence_number,
              canonical_recipient_address, display_recipient_address,
              domain_id, unallocated_period_id, route_status,
              delivery_id, created_at, committed_at
             )
             SELECT ?1, ?2, 0, ?3, ?4, ?5, period.id,
                    'accepted', NULL, ?6, NULL
             FROM unallocated_address_periods AS period
             WHERE period.canonical_address = ?3
               AND period.domain_id = ?5
               AND period.period_status = 'open'
             LIMIT 1`,
          )
          .bind(
            routeId,
            operationId,
            options.route.canonical_address,
            options.route.display_address,
            options.route.domain_id,
            options.now,
          ),
      )
    }
    await options.database.batch(statements)
  } catch (error) {
    const raced = await readOperationByDigest(options.database, options.deduplicationDigest)
    if (!raced) throw error
    const rawObject = await readRawObject(options.database, raced.message_reference)
    if (!rawObject) throw error
    const route = await ensureReceiveRoute({
      database: options.database,
      operationId: raced.id,
      route: options.route,
      canonicalRecipient: options.canonicalRecipient,
      now: options.now,
    })
    return {
      operation: raced,
      rawObject,
      routeId: route.id,
      routeAdded: route.added,
      operationExisted: true,
    }
  }

  const operation = await readReceiveOperation(options.database, operationId)
  const rawObject = await readRawObject(options.database, messageReference)
  if (!operation || !rawObject) throw new Error('收信意图没有完整建立')
  return {
    operation,
    rawObject,
    routeId,
    routeAdded: true,
    operationExisted: false,
  }
}

async function ensureRawObjectStored(options: {
  database: D1Database
  store: MailObjectStore
  operation: ReceiveOperationRow
  rawObject: ObjectRegistryRow
  raw: ArrayBuffer
  rawSha256: Uint8Array
  now: number
}): Promise<void> {
  if (['verified', 'active'].includes(options.rawObject.object_status)) return
  let stored = await options.store.get(options.rawObject.object_key)
  let backendVersionReference = stored?.backendVersionReference ?? null
  if (!stored) {
    backendVersionReference = await options.store.put({
      key: options.rawObject.object_key,
      bytes: options.raw,
      mediaType: 'message/rfc822',
      sha256Hex: bytesToHex(options.rawSha256),
    })
    stored = await options.store.get(options.rawObject.object_key)
  }
  if (!stored) throw new Error('原始邮件对象写入后暂时不可读取')
  const storedDigest = await sha256Bytes(stored.bytes)
  if (
    stored.bytes.byteLength !== options.raw.byteLength ||
    !equalBytes(storedDigest, options.rawSha256)
  ) {
    throw new Error('原始邮件对象写入校验失败')
  }

  if (options.store.mode === 'kv') {
    await options.database
      .prepare(
        `UPDATE object_registry
         SET object_status = 'waiting_consistency', actual_size_bytes = ?1,
             actual_sha256 = ?2, backend_version_reference = ?3,
             stored_at = COALESCE(stored_at, ?4), consistency_checked_at = ?4,
             updated_at = ?4
         WHERE id = ?5 AND object_status IN ('write_intent', 'stored')`,
      )
      .bind(
        stored.bytes.byteLength,
        storedDigest,
        backendVersionReference ?? stored.backendVersionReference,
        options.now,
        options.rawObject.id,
      )
      .run()
    return
  }

  await options.database.batch([
    options.database
      .prepare(
        `UPDATE object_registry
         SET object_status = 'verified', actual_size_bytes = ?1,
             actual_sha256 = ?2, backend_version_reference = ?3,
             stored_at = COALESCE(stored_at, ?4), verified_at = ?4,
             consistency_checked_at = ?4, updated_at = ?4
         WHERE id = ?5 AND object_status IN ('write_intent', 'stored', 'waiting_consistency')`,
      )
      .bind(
        stored.bytes.byteLength,
        storedDigest,
        backendVersionReference ?? stored.backendVersionReference,
        options.now,
        options.rawObject.id,
      ),
    options.database
      .prepare(
        `UPDATE receive_operations
         SET raw_object_id = ?1, operation_status = 'raw_stored', updated_at = ?2
         WHERE id = ?3 AND operation_status = 'intent'`,
      )
      .bind(options.rawObject.id, options.now, options.operation.id),
  ])
}

async function ensureParseTask(
  database: D1Database,
  operationId: string,
  now: number,
): Promise<{ id: string }> {
  const taskDigest = await sha256Bytes(`receive_parse\n${operationId}\n1`)
  const taskId = crypto.randomUUID()
  await database
    .prepare(
      `INSERT OR IGNORE INTO background_tasks (
        id, task_type, target_type, target_reference, input_version,
        task_key_digest, task_status, priority, attempt_count, max_attempts,
        next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
        last_error_code, last_error_summary, last_error_at, completed_at,
        created_at, updated_at
       ) VALUES (
        ?1, 'receive_parse', 'receive_operation', ?2, 1,
        ?3, 'pending', 2, 0, ?4, ?5, NULL, 0, NULL,
        NULL, NULL, NULL, NULL, ?5, ?5
       )`,
    )
    .bind(taskId, operationId, taskDigest, PARSE_TASK_MAX_ATTEMPTS, now)
    .run()
  const task = await database
    .prepare(
      `SELECT id FROM background_tasks
       WHERE task_type = 'receive_parse' AND target_reference = ?1 AND input_version = 1
       LIMIT 1`,
    )
    .bind(operationId)
    .first<{ id: string }>()
  if (!task) throw new Error('收信解析任务没有建立')
  return task
}

async function ensureRouteCommitTask(
  database: D1Database,
  routeId: string,
  now: number,
): Promise<{ id: string }> {
  const taskDigest = await sha256Bytes(`receive_route_commit\n${routeId}\n1`)
  const taskId = crypto.randomUUID()
  await database
    .prepare(
      `INSERT OR IGNORE INTO background_tasks (
        id, task_type, target_type, target_reference, input_version,
        task_key_digest, task_status, priority, attempt_count, max_attempts,
        next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
        last_error_code, last_error_summary, last_error_at, completed_at,
        created_at, updated_at
       ) VALUES (
        ?1, 'receive_route_commit', 'receive_route', ?2, 1,
        ?3, 'pending', 2, 0, ?4, ?5, NULL, 0, NULL,
        NULL, NULL, NULL, NULL, ?5, ?5
       )`,
    )
    .bind(taskId, routeId, taskDigest, ROUTE_COMMIT_TASK_MAX_ATTEMPTS, now)
    .run()
  const task = await database
    .prepare(
      `SELECT id FROM background_tasks
       WHERE task_type = 'receive_route_commit'
         AND target_reference = ?1 AND input_version = 1
       LIMIT 1`,
    )
    .bind(routeId)
    .first<{ id: string }>()
  if (!task) throw new Error('收信补交付任务没有建立')
  return task
}

async function ensureDerivedObjectIntent(
  database: D1Database,
  storageMode: StorageMode,
  messageReference: string,
  part: ParsedMailObject,
  now: number,
): Promise<ObjectRegistryRow> {
  const existing = await database
    .prepare(
      `SELECT id, object_key, object_status, expected_size_bytes,
              expected_sha256, backend_version_reference
       FROM object_registry
       WHERE owner_reference = ?1 AND object_role = ?2
         AND logical_part_key = ?3 AND generation = 1
       LIMIT 1`,
    )
    .bind(messageReference, part.objectRole, part.logicalPartKey)
    .first<ObjectRegistryRow>()
  if (existing) {
    if (
      existing.expected_size_bytes !== part.bytes.byteLength ||
      !equalBytes(existing.expected_sha256, part.sha256)
    ) {
      throw new Error('重复解析产生了不同的邮件对象')
    }
    return existing
  }

  const id = crypto.randomUUID()
  const objectKey = `mail/messages/${messageReference}/${part.objectRole}/${part.logicalPartKey}/v1`
  await database
    .prepare(
      `INSERT INTO object_registry (
        id, storage_mode, object_key, owner_kind, owner_reference, message_id,
        object_role, logical_part_key, sequence_number, generation,
        required_for_visibility, is_current, expected_size_bytes,
        expected_sha256, actual_size_bytes, actual_sha256, media_type,
        untrusted_file_name, content_disposition, content_id, producer_version,
        backend_version_reference, object_status, stored_at, verified_at,
        consistency_checked_at, activated_at, superseded_at, delete_after,
        deleted_at, created_at, updated_at
       ) VALUES (
        ?1, ?2, ?3, 'message', ?4, NULL, ?5, ?6, ?7, 1,
        1, 0, ?8, ?9, NULL, NULL, ?10, ?11, ?12, ?13, ?14,
        NULL, 'write_intent', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?15, ?15
       )`,
    )
    .bind(
      id,
      storageMode,
      objectKey,
      messageReference,
      part.objectRole,
      part.logicalPartKey,
      part.sequenceNumber,
      part.bytes.byteLength,
      part.sha256,
      part.mediaType,
      part.untrustedFileName,
      part.contentDisposition,
      part.contentId,
      MIME_PARSER_VERSION,
      now,
    )
    .run()
  const result = await database
    .prepare(
      `SELECT id, object_key, object_status, expected_size_bytes,
              expected_sha256, backend_version_reference
       FROM object_registry WHERE id = ?1`,
    )
    .bind(id)
    .first<ObjectRegistryRow>()
  if (!result) throw new Error('衍生邮件对象登记没有建立')
  return result
}

async function ensureDerivedObjectStored(
  store: MailObjectStore,
  database: D1Database,
  object: ObjectRegistryRow,
  part: ParsedMailObject,
  now: number,
): Promise<boolean> {
  if (['verified', 'active'].includes(object.object_status)) return true
  let stored = await store.get(object.object_key)
  let backendVersionReference = stored?.backendVersionReference ?? null
  if (!stored) {
    backendVersionReference = await store.put({
      key: object.object_key,
      bytes: part.bytes,
      mediaType: part.mediaType,
      sha256Hex: bytesToHex(part.sha256),
    })
    stored = await store.get(object.object_key)
  }
  if (!stored) throw new Error('衍生邮件对象写入后暂时不可读取')
  const digest = await sha256Bytes(stored.bytes)
  if (stored.bytes.byteLength !== part.bytes.byteLength || !equalBytes(digest, part.sha256)) {
    throw new Error('衍生邮件对象写入校验失败')
  }

  if (store.mode === 'kv' && object.object_status !== 'waiting_consistency') {
    await database
      .prepare(
        `UPDATE object_registry
         SET object_status = 'waiting_consistency', actual_size_bytes = ?1,
             actual_sha256 = ?2, backend_version_reference = ?3,
             stored_at = COALESCE(stored_at, ?4), consistency_checked_at = ?4,
             updated_at = ?4
         WHERE id = ?5 AND object_status IN ('write_intent', 'stored')`,
      )
      .bind(
        stored.bytes.byteLength,
        digest,
        backendVersionReference ?? stored.backendVersionReference,
        now,
        object.id,
      )
      .run()
    return false
  }

  await database
    .prepare(
      `UPDATE object_registry
       SET object_status = 'verified', actual_size_bytes = ?1,
           actual_sha256 = ?2, backend_version_reference = ?3,
           stored_at = COALESCE(stored_at, ?4), verified_at = ?4,
           consistency_checked_at = ?4, updated_at = ?4
       WHERE id = ?5 AND object_status IN ('write_intent', 'stored', 'waiting_consistency')`,
    )
    .bind(
      stored.bytes.byteLength,
      digest,
      backendVersionReference ?? stored.backendVersionReference,
      now,
      object.id,
    )
    .run()
  return true
}

async function commitVisibleMessage(
  database: D1Database,
  storageMode: StorageMode,
  operation: ReceiveOperationRow,
  parsed: ParsedIncomingMail,
  now: number,
): Promise<BackgroundTaskMessage[]> {
  const current = await readReceiveOperation(database, operation.id)
  if (!current) throw new Error('收信操作不存在')
  if (current.operation_status === 'visible') {
    return readPendingMessageTasks(database, operation.message_reference)
  }
  if (current.operation_status !== 'committing') throw new Error('收信操作尚未进入提交阶段')
  const routes = await readAcceptedReceiveRoutes(database, operation.id)
  if (routes.length === 0) throw new Error('收信操作缺少冻结路由')

  const messageId = operation.message_reference
  const searchWork = await prepareInitialMessageSearchWork({
    database,
    messageId,
    objectSetVersion: 1,
    now,
  })
  const conversationWork = await prepareInitialMessageConversationWork({
    database,
    messageId,
    relations: parsed.relations,
    now,
  })
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO messages (
          id, origin_type, authored_by_user_id, internet_message_id,
          subject, header_date_text, header_date_at, accepted_at, sort_at,
          raw_size_bytes, attachment_count, has_attachments, created_at, updated_at
         ) VALUES (?1, 'received', NULL, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?6, ?6)`,
      )
      .bind(
        messageId,
        parsed.internetMessageId,
        parsed.subject,
        parsed.headerDateText,
        parsed.headerDateAt,
        operation.accepted_at,
        operation.raw_size_bytes,
        parsed.attachmentCount,
        parsed.attachmentCount > 0 ? 1 : 0,
      ),
    database
      .prepare(
        `UPDATE object_registry
         SET message_id = owner_reference, object_status = 'active', is_current = 1,
             activated_at = ?1, updated_at = ?1
         WHERE owner_reference = ?2 AND message_id IS NULL AND object_status = 'verified'`,
      )
      .bind(now, messageId),
    database
      .prepare(
        `INSERT INTO message_integrity_states (
          message_id, source_completeness, integrity_status, object_set_version,
          ready_at, hidden_since, damage_code, damage_summary, created_at, updated_at
         ) VALUES (?1, 'raw_mime', 'ready', 1, ?2, NULL, NULL, NULL, ?2, ?2)`,
      )
      .bind(messageId, now),
  ]

  for (const address of parsed.headerAddresses) {
    statements.push(
      database
        .prepare(
          `INSERT INTO message_header_addresses (
            id, message_id, address_role, sequence_number, display_name,
            address_text, canonical_address, visibility_scope, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          crypto.randomUUID(),
          messageId,
          address.role,
          address.sequenceNumber,
          address.displayName,
          address.addressText,
          address.canonicalAddress,
          address.role === 'bcc' ? 'sender_only' : 'header',
          now,
        ),
    )
  }

  const routeWork = await prepareReceiveRouteCommitWork({
    database,
    storageMode,
    operation: current,
    parsed,
    routes,
    now,
  })
  statements.push(...routeWork.statements)
  const resultTasks: BackgroundTaskMessage[] = [
    searchWork.task,
    conversationWork.task,
    ...routeWork.messages,
  ]

  statements.push(
    database
      .prepare(
        `INSERT INTO message_deduplication_keys (
          source_kind, key_digest, receive_operation_id, message_id, created_at
         ) VALUES ('cloudflare_email_routing', ?1, ?2, ?3, ?4)`,
      )
      .bind(current.deduplication_key_digest, operation.id, messageId, now),
    ...conversationWork.statements,
    ...searchWork.statements,
    database
      .prepare(
        `UPDATE receive_operations
         SET message_id = ?1, operation_status = 'visible',
             visible_at = ?2, completed_at = ?2, error_code = NULL,
             error_summary = NULL, updated_at = ?2
         WHERE id = ?3 AND operation_status = 'committing'`,
      )
      .bind(messageId, now, operation.id),
    ...routeWork.completionStatements,
  )

  const results = await database.batch(statements)
  if (results.some((result) => result.meta.changes < 1)) {
    throw new Error('邮件最终可见事务没有完整提交')
  }
  return resultTasks
}

async function prepareReceiveRouteCommitWork(options: {
  database: D1Database
  storageMode: StorageMode
  operation: ReceiveOperationRow
  parsed: ParsedIncomingMail
  routes: ReceiveRoute[]
  now: number
}): Promise<{
  statements: D1PreparedStatement[]
  completionStatements: D1PreparedStatement[]
  messages: BackgroundTaskMessage[]
}> {
  const statements: D1PreparedStatement[] = []
  const completionStatements: D1PreparedStatement[] = []
  const messages: BackgroundTaskMessage[] = []
  const mailboxEntries = new Map<string, string>()
  const notificationDeliveries: Array<{
    deliveryId: string
    addressBindingId: string
    actualAddress: string
  }> = []
  const operationReference = `receive:${bytesToHex(
    new Uint8Array(options.operation.deduplication_key_digest),
  )}`

  for (const route of options.routes) {
    const deliveryId = crypto.randomUUID()
    if (route.route_kind === 'unallocated') {
      statements.push(
        options.database
          .prepare(
            `INSERT INTO unallocated_message_deliveries (
              id, message_id, unallocated_period_id, canonical_recipient_address,
              display_recipient_address, delivery_source, delivered_at, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'external_receive', ?6, ?6)`,
          )
          .bind(
            deliveryId,
            options.operation.message_reference,
            route.unallocated_period_id,
            route.canonical_recipient_address,
            route.display_recipient_address,
            options.operation.accepted_at,
          ),
      )
      completionStatements.push(
        options.database
          .prepare(
            `UPDATE receive_operation_unallocated_routes
             SET route_status = 'committed', delivery_id = ?1, committed_at = ?2
             WHERE id = ?3 AND route_status = 'accepted'`,
          )
          .bind(deliveryId, options.now, route.id),
      )
      continue
    }

    const ownerId = route.owner_type === 'user' ? route.user_id! : route.organization_id!
    const ownerKey = `${route.owner_type}:${ownerId}`
    let mailboxEntryId = mailboxEntries.get(ownerKey)
    if (!mailboxEntryId) {
      mailboxEntryId = await readReceivedMailboxEntryId(
        options.database,
        options.operation.message_reference,
        route,
      )
      if (!mailboxEntryId) {
        const owner =
          route.owner_type === 'user'
            ? { ownerType: 'user' as const, ownerId }
            : { ownerType: 'organization' as const, ownerId }
        const logicalReservation = await reserveLogicalStorage({
          database: options.database,
          storageMode: options.storageMode,
          owner,
          operationKind: 'receive',
          operationReference,
          bytes: options.operation.raw_size_bytes,
          now: options.now,
        })
        if (!logicalReservation) throw new Error('收信路由缺少逻辑存储配额预留')
        mailboxEntryId = crypto.randomUUID()
        statements.push(
          route.owner_type === 'user'
            ? options.database
                .prepare(
                  `INSERT INTO mailbox_entries (
                    id, message_id, mailbox_type, user_id, organization_id,
                    entry_kind, base_location, occurred_at, created_at
                   ) VALUES (?1, ?2, 'user', ?3, NULL, 'received', 'inbox', ?4, ?4)`,
                )
                .bind(
                  mailboxEntryId,
                  options.operation.message_reference,
                  ownerId,
                  options.operation.accepted_at,
                )
            : options.database
                .prepare(
                  `INSERT INTO mailbox_entries (
                    id, message_id, mailbox_type, user_id, organization_id,
                    entry_kind, base_location, occurred_at, created_at
                   ) VALUES (?1, ?2, 'organization', NULL, ?3, 'received', 'inbox', ?4, ?4)`,
                )
                .bind(
                  mailboxEntryId,
                  options.operation.message_reference,
                  ownerId,
                  options.operation.accepted_at,
                ),
          ...(await logicalStorageCommitStatements({
            database: options.database,
            reservation: logicalReservation,
            entryKind: 'message',
            ownerReference: `message:${options.operation.message_reference}`,
            now: options.now,
          })),
        )
      }
      mailboxEntries.set(ownerKey, mailboxEntryId)
    }

    statements.push(
      options.database
        .prepare(
          `INSERT INTO message_deliveries (
            id, message_id, address_binding_id, canonical_recipient_address,
            display_recipient_address, delivery_source, delivered_at, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, 'external_receive', ?6, ?6)`,
        )
        .bind(
          deliveryId,
          options.operation.message_reference,
          route.address_binding_id,
          route.canonical_recipient_address,
          route.display_recipient_address,
          options.operation.accepted_at,
        ),
      options.database
        .prepare(
          `INSERT INTO mailbox_entry_deliveries (mailbox_entry_id, delivery_id, created_at)
           VALUES (?1, ?2, ?3)`,
        )
        .bind(mailboxEntryId, deliveryId, options.now),
    )
    notificationDeliveries.push({
      deliveryId,
      addressBindingId: route.address_binding_id,
      actualAddress: route.display_recipient_address,
    })
    const forwardingWork = await prepareForwardingWork({
      database: options.database,
      delivery: {
        deliveryId,
        messageId: options.operation.message_reference,
        sourceSizeBytes: options.operation.raw_size_bytes,
        addressBindingId: route.address_binding_id,
        addressId: route.address_id,
        domainId: route.domain_id,
        userId: route.user_id,
        actualAddress: route.canonical_recipient_address,
      },
      parsed: options.parsed,
      now: options.now,
    })
    statements.push(...forwardingWork.statements)
    completionStatements.push(
      options.database
        .prepare(
          `UPDATE receive_operation_routes
           SET route_status = 'committed', delivery_id = ?1, committed_at = ?2
           WHERE id = ?3 AND route_status = 'accepted'`,
        )
        .bind(deliveryId, options.now, route.id),
    )
    messages.push(...forwardingWork.messages)
  }

  if (notificationDeliveries.length > 0) {
    const notificationBody =
      options.parsed.objects.find((object) => object.objectRole === 'plain_body') ??
      options.parsed.objects.find((object) => object.objectRole === 'html_body')
    if (!notificationBody) throw new Error('邮件缺少可用于通知的正文对象')
    const notificationWork = await prepareNotificationWork({
      database: options.database,
      subject: options.parsed.subject,
      addresses: options.parsed.headerAddresses.map((address) => ({
        role: address.role,
        displayName: address.displayName,
        address: address.addressText,
      })),
      bodyFormat: notificationBody.objectRole === 'plain_body' ? 'plain_text' : 'rich_text',
      body: new TextDecoder().decode(notificationBody.bytes),
      deliveries: notificationDeliveries,
      objectSetVersion: 1,
      now: options.now,
    })
    statements.push(...notificationWork.statements)
    messages.push(...notificationWork.messages)
  }

  return { statements, completionStatements, messages }
}

async function readReceivedMailboxEntryId(
  database: D1Database,
  messageId: string,
  route: AssignedReceiveRoute,
): Promise<string | undefined> {
  const ownerColumn = route.owner_type === 'user' ? 'user_id' : 'organization_id'
  const ownerId = route.owner_type === 'user' ? route.user_id : route.organization_id
  const row = await database
    .prepare(
      `SELECT id FROM mailbox_entries
       WHERE message_id = ?1 AND mailbox_type = ?2 AND ${ownerColumn} = ?3
         AND entry_kind = 'received'
       LIMIT 1`,
    )
    .bind(messageId, route.owner_type, ownerId)
    .first<{ id: string }>()
  return row?.id
}

async function readAcceptedReceiveRoutes(
  database: D1Database,
  operationId: string,
): Promise<ReceiveRoute[]> {
  const assigned = await database
    .prepare(
      `SELECT 'assigned' AS route_kind, id, sequence_number, canonical_recipient_address,
              display_recipient_address, domain_id, address_id,
              address_binding_id, owner_type, user_id, organization_id
       FROM receive_operation_routes
       WHERE receive_operation_id = ?1 AND route_status = 'accepted'
       ORDER BY sequence_number`,
    )
    .bind(operationId)
    .all<AssignedReceiveRoute>()
  const unallocated = await database
    .prepare(
      `SELECT 'unallocated' AS route_kind, id, sequence_number, canonical_recipient_address,
              display_recipient_address, domain_id, unallocated_period_id
       FROM receive_operation_unallocated_routes
       WHERE receive_operation_id = ?1 AND route_status = 'accepted'
       ORDER BY sequence_number`,
    )
    .bind(operationId)
    .all<UnallocatedReceiveRoute>()
  return [...assigned.results, ...unallocated.results].sort(
    (left, right) => left.sequence_number - right.sequence_number,
  )
}

async function wakePendingMessageTasks(
  database: D1Database,
  queue: Queue<BackgroundTaskMessage> | undefined,
  messageId: string,
): Promise<void> {
  if (!queue) return
  const tasks = await readPendingMessageTasks(database, messageId)
  await wakeMessageTasks(queue, tasks)
}

async function readPendingMessageTasks(
  database: D1Database,
  messageId: string,
): Promise<BackgroundTaskMessage[]> {
  const rows = await database
    .prepare(
      `SELECT id AS task_id, input_version
       FROM background_tasks
       WHERE (
           (target_reference = ?1 AND (
             (task_type = 'index_message' AND target_type = 'message_search')
             OR (task_type = 'rebuild_conversation' AND target_type = 'message_conversation')
           ))
           OR (
             task_type = 'send_notification' AND target_type = 'notification_operation'
             AND target_reference IN (
               SELECT operation.id
               FROM notification_operations operation
               JOIN message_deliveries delivery
                 ON delivery.id = operation.message_delivery_id
               WHERE delivery.message_id = ?1
             )
           )
           OR (
             task_type = 'forward_mail' AND target_type = 'mail_forward_operation'
             AND target_reference IN (
               SELECT operation.id
               FROM mail_forward_operations operation
               JOIN message_deliveries delivery
                 ON delivery.id = operation.message_delivery_id
               WHERE delivery.message_id = ?1
             )
           )
         )
         AND task_status IN ('pending', 'retry_wait')
       ORDER BY priority, created_at, id`,
    )
    .bind(messageId)
    .all<{ task_id: string; input_version: number }>()
  return rows.results.map((row) => ({ taskId: row.task_id, inputVersion: row.input_version }))
}

async function wakeMessageTasks(
  queue: Queue<BackgroundTaskMessage> | undefined,
  tasks: BackgroundTaskMessage[],
): Promise<void> {
  if (!queue || tasks.length === 0) return
  try {
    for (const task of tasks) await queue.send(task)
  } catch {
    // D1 中的待执行任务仍会由定时维护重新唤醒。
  }
}

async function markReceiveParseFailed(
  database: D1Database,
  operation: ReceiveOperationRow,
  errorCode: string,
  now: number,
): Promise<void> {
  await database
    .prepare(
      `UPDATE receive_operations
       SET operation_status = 'parse_failed', error_code = ?1,
           error_summary = '邮件格式或结构无法安全解析',
           completed_at = ?2, updated_at = ?2
       WHERE id = ?3 AND operation_status = 'parsing'`,
    )
    .bind(errorCode, now, operation.id)
    .run()
  await releaseReceiveLogicalStorage(database, operation, now)
}

async function markReceiveDamaged(
  database: D1Database,
  operation: ReceiveOperationRow,
  errorCode: string,
  actualSizeBytes: number,
  actualSha256: Uint8Array,
  now: number,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE object_registry
         SET object_status = 'damaged', is_current = 1,
             actual_size_bytes = COALESCE(actual_size_bytes, ?1),
             actual_sha256 = COALESCE(actual_sha256, ?2),
             stored_at = COALESCE(stored_at, ?3),
             activated_at = COALESCE(activated_at, ?3), updated_at = ?3
         WHERE owner_reference = ?4
           AND object_role = 'raw_mime'
           AND object_status IN ('write_intent', 'stored', 'waiting_consistency', 'verified', 'active')`,
      )
      .bind(actualSizeBytes, actualSha256, now, operation.message_reference),
    database
      .prepare(
        `UPDATE receive_operations
         SET operation_status = 'damaged', error_code = ?1,
             error_summary = '原始邮件对象完整性校验失败',
             completed_at = ?2, updated_at = ?2
         WHERE id = ?3 AND operation_status IN ('intent', 'raw_stored', 'parsing')`,
      )
      .bind(errorCode, now, operation.id),
  ])
  await releaseReceiveLogicalStorage(database, operation, now)
}

async function releaseReceiveLogicalStorage(
  database: D1Database,
  operation: ReceiveOperationRow,
  now: number,
): Promise<void> {
  const routes = await database
    .prepare(
      `SELECT route.owner_type, route.user_id, route.organization_id, system.storage_mode
       FROM receive_operation_routes AS route
       JOIN system_instances AS system ON system.singleton_id = 1
       WHERE route.receive_operation_id = ?1
       ORDER BY route.sequence_number`,
    )
    .bind(operation.id)
    .all<{
      owner_type: 'user' | 'organization'
      user_id: string | null
      organization_id: string | null
      storage_mode: StorageMode
    }>()
  const releasedOwners = new Set<string>()
  for (const route of routes.results) {
    const ownerId = route.owner_type === 'user' ? route.user_id! : route.organization_id!
    const ownerKey = `${route.owner_type}:${ownerId}`
    if (releasedOwners.has(ownerKey)) continue
    releasedOwners.add(ownerKey)
    await releaseLogicalStorageReservationByReference({
      database,
      storageMode: route.storage_mode,
      owner: { ownerType: route.owner_type, ownerId },
      operationKind: 'receive',
      operationReference: `receive:${bytesToHex(
        new Uint8Array(operation.deduplication_key_digest),
      )}`,
      now,
    })
  }
}

async function readOperationByDigest(
  database: D1Database,
  digest: Uint8Array,
): Promise<ReceiveOperationRow | null> {
  return database
    .prepare(
      `SELECT id, deduplication_key_digest, message_reference, message_id,
              raw_object_id, raw_size_bytes, raw_sha256, operation_status,
              parser_version, error_code, accepted_at
       FROM receive_operations
       WHERE source_kind = 'cloudflare_email_routing' AND deduplication_key_digest = ?1
       LIMIT 1`,
    )
    .bind(digest)
    .first<ReceiveOperationRow>()
}

async function readReceiveOperationByRouteId(
  database: D1Database,
  routeId: string,
): Promise<ReceiveOperationRow | null> {
  return database
    .prepare(
      `SELECT operation.id, operation.deduplication_key_digest,
              operation.message_reference, operation.message_id,
              operation.raw_object_id, operation.raw_size_bytes,
              operation.raw_sha256, operation.operation_status,
              operation.parser_version, operation.error_code,
              operation.accepted_at
       FROM receive_operations AS operation
       JOIN (
         SELECT receive_operation_id FROM receive_operation_routes WHERE id = ?1
         UNION ALL
         SELECT receive_operation_id FROM receive_operation_unallocated_routes WHERE id = ?1
       ) AS route ON route.receive_operation_id = operation.id
       LIMIT 1`,
    )
    .bind(routeId)
    .first<ReceiveOperationRow>()
}

async function readReceiveOperation(
  database: D1Database,
  operationId: string,
): Promise<ReceiveOperationRow | null> {
  return database
    .prepare(
      `SELECT id, deduplication_key_digest, message_reference, message_id,
              raw_object_id, raw_size_bytes, raw_sha256, operation_status,
              parser_version, error_code, accepted_at
       FROM receive_operations WHERE id = ?1 LIMIT 1`,
    )
    .bind(operationId)
    .first<ReceiveOperationRow>()
}

async function readRawObject(
  database: D1Database,
  messageReference: string,
): Promise<ObjectRegistryRow | null> {
  return database
    .prepare(
      `SELECT id, object_key, object_status, expected_size_bytes,
              expected_sha256, backend_version_reference
       FROM object_registry
       WHERE owner_reference = ?1 AND object_role = 'raw_mime'
         AND logical_part_key = 'body' AND generation = 1
       LIMIT 1`,
    )
    .bind(messageReference)
    .first<ObjectRegistryRow>()
}
