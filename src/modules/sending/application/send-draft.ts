import { createMimeMessage } from 'mimetext/browser'
import type { BackgroundTaskMessage } from '../../../shared/contracts/background-task'
import type {
  SendDraftRequest,
  SendOperationResult,
  SendRecipientResult,
} from '../../../shared/contracts/sending'
import type { StorageMode } from '../../../shared/contracts/storage-mode'
import { normalizeRecipientEmailAddress } from '../../addresses/domain/email-address'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'
import {
  bytesToHex,
  equalBytes,
  sha256Bytes,
  toArrayBuffer,
} from '../../mail-receiving/domain/content-digest'
import type { MailObjectStore } from '../../mail-receiving/public'
import { prepareNotificationWork } from '../../notifications/public'
import {
  commitPlatformCapacityReservation,
  PlatformCapacityUnavailableError,
  releasePlatformCapacityReservation,
  reservePlatformCapacity,
} from '../../platform-resources/public'
import {
  logicalStorageAdjustmentStatement,
  logicalStorageCommitStatements,
  LogicalStorageCapacityError,
  releaseLogicalStorageReservation,
  reserveLogicalStorage,
  type LogicalStorageOwner,
  type LogicalStorageReservation,
} from '../../storage-quotas/public'

const MAX_MESSAGE_BYTES = 20_000_000
const MIME_GENERATOR_VERSION = 'mimetext-3.0.28-simlettra-v1'
const SEND_TASK_MAX_ATTEMPTS = 5
const INDEX_TASK_MAX_ATTEMPTS = 5
const CONVERSATION_TASK_MAX_ATTEMPTS = 5

type SendField =
  'draftId' | 'requestKey' | 'expectedRevisionNumber' | 'recipients' | 'senderAddressId' | 'message'

export class SendInputError extends Error {
  constructor(
    readonly field: SendField,
    message: string,
  ) {
    super(message)
  }
}

export class SendAccessError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'not_active'
      | 'sender_unavailable'
      | 'external_route_missing'
      | 'recipient_unavailable'
      | 'quota_exceeded',
    message: string,
  ) {
    super(message)
  }
}

export class SendMutationConflictError extends Error {
  constructor(message = '相同发送编号不能用于不同的草稿修订') {
    super(message)
  }
}

interface DraftSendRow {
  id: string
  owner_user_id: string
  status: string
  sender_address_id: string | null
  compose_kind: string
  source_message_id: string | null
  source_reference: string | null
  current_revision_number: number
  subject: string
  body_format: string
  body_content_generation: number
  timezone: string | null
}

interface SourceMessageContext {
  internetMessageId: string | null
  references: string[]
}

interface SenderRow {
  address_id: string
  canonical_address: string
  domain_id: string
  domain_name: string
  binding_id: string
  owner_type: 'user' | 'organization'
  user_id: string | null
  organization_id: string | null
  organization_name: string | null
  display_name: string | null
  signature_format: string | null
  signature_content: string | null
}

interface DraftRecipientRow {
  recipient_role: 'to' | 'cc' | 'bcc'
  sequence_number: number
  display_name: string | null
  address_text: string
}

interface DraftObjectRow {
  id: string
  object_key: string
  object_role: 'draft_body' | 'draft_attachment'
  logical_part_key: string
  sequence_number: number
  media_type: string
  untrusted_file_name: string | null
  expected_size_bytes: number
  expected_sha256: ArrayBuffer
}

interface InternalRouteRow {
  address_id: string
  address_binding_id: string
  canonical_address: string
  owner_type: 'user' | 'organization'
  user_id: string | null
  organization_id: string | null
}

interface RouteEntryRow {
  route_id: string
  route_version: number
  provider_config_id: string
  configuration_key: string
  configuration_version: number
  provider_type: 'resend' | 'smtp2go'
  public_options_json: string
  priority_number: number
  provider_options_digest: Uint8Array
}

interface ResolvedRecipient {
  id: string
  role: 'to' | 'cc' | 'bcc'
  sequenceNumber: number
  displayName: string | null
  address: string
  canonicalAddress: string
  deduplicationKey: Uint8Array
  channel: 'internal' | 'external'
  deliveryId: string | null
  internalRoute: InternalRouteRow | null
  quotaRejected: boolean
}

interface SendStorageOwnerPlan {
  key: string
  owner: LogicalStorageOwner
  includesSender: boolean
  includesDraftOwner: boolean
  recipientIds: string[]
  bytesDelta: number
  reservation: LogicalStorageReservation | null
}

interface StoredMessageObject {
  id: string
  role: 'final_mime' | 'plain_body' | 'html_body' | 'attachment'
  logicalPartKey: string
  bytes: Uint8Array
  digest: Uint8Array
  mediaType: string
  fileName: string | null
  sequenceNumber: number
}

interface SendReplayRow {
  input_digest: ArrayBuffer
  send_operation_id: string
}

export async function sendDraft(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  queue?: Queue<BackgroundTaskMessage>
  userId: string
  draftId: string
  input: SendDraftRequest
  audit: AuditContext
  now?: number
}): Promise<{ replayed: boolean; send: SendOperationResult }> {
  const now = options.now ?? Date.now()
  const input = normalizeSendInput(options.draftId, options.input)
  const requestKeyDigest = await sha256Bytes(input.requestKey)
  const inputDigest = await sha256Bytes(
    JSON.stringify({ draftId: input.draftId, revision: input.expectedRevisionNumber }),
  )
  const replay = await findReplay(options.database, options.userId, requestKeyDigest)
  if (replay) {
    if (!equalBytes(replay.input_digest, inputDigest)) throw new SendMutationConflictError()
    return {
      replayed: true,
      send: await getSendOperation({
        database: options.database,
        userId: options.userId,
        sendOperationId: replay.send_operation_id,
      }),
    }
  }

  const draft = await loadDraft(options.database, options.userId, input.draftId)
  if (!draft) throw new SendAccessError('not_found', '草稿不存在')
  if (draft.status !== 'active')
    throw new SendAccessError('not_active', '只有草稿箱中的邮件可以发送')
  if (draft.current_revision_number !== input.expectedRevisionNumber) {
    throw new SendAccessError('not_active', '草稿已经在其他设备更新，请先刷新再发送')
  }
  if (!draft.sender_address_id) throw new SendInputError('senderAddressId', '请选择发件地址')
  const sender = await loadAuthorizedSender(
    options.database,
    options.userId,
    draft.sender_address_id,
    now,
  )
  if (!sender) throw new SendAccessError('sender_unavailable', '当前不能使用这个发件地址')

  const [draftRecipients, draftObjects, sourceMessage] = await Promise.all([
    loadDraftRecipients(options.database, draft.id),
    loadDraftObjects(options.database, draft),
    loadSourceMessage(options.database, draft.source_message_id),
  ])
  const normalizedRecipients = await normalizeAndDeduplicateRecipients(draftRecipients)
  if (normalizedRecipients.length === 0) {
    throw new SendInputError('recipients', '请至少填写一名收件人')
  }
  const recipients = await resolveRecipients(options.database, normalizedRecipients)
  const externalCount = recipients.filter((recipient) => recipient.channel === 'external').length
  const routeEntries = externalCount
    ? await loadActiveRouteEntries(options.database, sender.domain_id)
    : []
  if (externalCount > 0 && routeEntries.length === 0) {
    throw new SendAccessError(
      'external_route_missing',
      `发件域名 ${sender.domain_name} 尚未配置可用的域外发信服务`,
    )
  }

  const bodyObject = draftObjects.find((object) => object.object_role === 'draft_body')
  if (!bodyObject) throw new SendInputError('message', '草稿正文暂时不可用')
  const attachmentObjects = draftObjects.filter(
    (object) => object.object_role === 'draft_attachment',
  )
  const bodyStored = await readVerifiedDraftObject(options.objectStore, bodyObject)
  const attachments = await Promise.all(
    attachmentObjects.map(async (object) => ({
      object,
      bytes: await readVerifiedDraftObject(options.objectStore, object),
    })),
  )
  const bodyText = appendSignature(
    new TextDecoder().decode(bodyStored),
    draft.body_format,
    sender.signature_format,
    sender.signature_content,
  )
  const messageId = crypto.randomUUID()
  const internetMessageId = `<${messageId}@${sender.domain_name}>`
  const replySource = isReplyComposeKind(draft.compose_kind) ? sourceMessage : null
  const finalMime = createFinalMime({
    sender,
    recipients,
    subject: normalizeSubject(draft.subject),
    bodyFormat: draft.body_format,
    body: bodyText,
    attachments,
    internetMessageId,
    sourceInternetMessageId: replySource?.internetMessageId ?? null,
    sourceReferences: replySource?.references ?? [],
    now,
  })
  if (finalMime.byteLength > MAX_MESSAGE_BYTES) {
    throw new SendInputError('message', '最终邮件超过 20 MB，尚未发送')
  }

  const operationId = crypto.randomUUID()
  const sentMailboxEntryId = crypto.randomUUID()
  const routeSnapshotId = externalCount > 0 ? crypto.randomUUID() : null
  const draftLogicalBytes = draftObjects.reduce(
    (sum, object) => sum + object.expected_size_bytes,
    0,
  )
  const storagePlans = await prepareSendStoragePlans({
    database: options.database,
    storageMode: options.storageMode,
    userId: options.userId,
    sender,
    recipients,
    operationId,
    messageBytes: finalMime.byteLength,
    draftLogicalBytes,
    now,
  })
  if (
    recipients.every((recipient) => recipient.channel === 'internal' && recipient.quotaRejected)
  ) {
    await releaseSendStoragePlans(options.database, storagePlans, now)
    throw new SendAccessError('quota_exceeded', '所有系统内收件邮箱的存储配额都已用完')
  }
  let capacityReservation
  try {
    capacityReservation = await reservePlatformCapacity({
      database: options.database,
      storageMode: options.storageMode,
      operationKind: 'sent_copy',
      operationReference: `send:${options.userId}:${bytesToHex(requestKeyDigest)}`,
      d1EstimatedBytes: 128_000 + recipients.length * 4_096,
      objectEstimatedBytes:
        finalMime.byteLength +
        new TextEncoder().encode(bodyText).byteLength +
        attachments.reduce((sum, attachment) => sum + attachment.bytes.byteLength, 0),
      now,
    })
  } catch (error) {
    if (error instanceof PlatformCapacityUnavailableError) {
      await releaseSendStoragePlans(options.database, storagePlans, now)
      throw new SendAccessError('quota_exceeded', 'Cloudflare 免费存储容量不足，尚未发送')
    }
    throw error
  }
  let finalObjects: StoredMessageObject[]
  try {
    finalObjects = await storeFinalMessageObjects({
      database: options.database,
      objectStore: options.objectStore,
      storageMode: options.storageMode,
      messageId,
      finalMime,
      bodyFormat: draft.body_format,
      body: new TextEncoder().encode(bodyText),
      attachments,
      now,
    })
  } catch (error) {
    await Promise.all([
      releasePlatformCapacityReservation({
        database: options.database,
        reservation: capacityReservation,
        now,
      }),
      releaseSendStoragePlans(options.database, storagePlans, now),
    ])
    throw error
  }
  await commitPlatformCapacityReservation({
    database: options.database,
    reservation: capacityReservation,
    now,
  })
  const finalMimeObject = finalObjects.find((object) => object.role === 'final_mime')
  if (!finalMimeObject) throw new Error('最终 MIME 对象没有建立')

  const monthlyPolicy = await resolveMonthlyPolicy(options.database, sender.domain_id)
  const month = zonedMonthBounds(now, draft.timezone || 'UTC')
  const monthlyPeriodId = `${sender.domain_id}:${month.startAt}`
  const work = await buildWorkItems(messageId, externalCount > 0)
  const notificationWork = await prepareNotificationWork({
    database: options.database,
    subject: normalizeSubject(draft.subject),
    addresses: [
      {
        role: 'from',
        displayName: sender.display_name,
        address: sender.canonical_address,
      },
      ...recipients.map((recipient) => ({
        role: recipient.role,
        displayName: recipient.displayName,
        address: recipient.address,
      })),
    ],
    bodyFormat: draft.body_format === 'rich_text' ? 'rich_text' : 'plain_text',
    body: bodyText,
    deliveries: recipients
      .filter(
        (
          recipient,
        ): recipient is ResolvedRecipient & {
          deliveryId: string
          internalRoute: InternalRouteRow
        } =>
          recipient.channel === 'internal' &&
          !recipient.quotaRejected &&
          recipient.deliveryId !== null &&
          recipient.internalRoute !== null,
      )
      .map((recipient) => ({
        deliveryId: recipient.deliveryId,
        addressBindingId: recipient.internalRoute.address_binding_id,
        actualAddress: recipient.address,
      })),
    objectSetVersion: 1,
    now,
  })
  const statements = buildAcceptanceStatements({
    database: options.database,
    userId: options.userId,
    draft,
    sender,
    recipients,
    routeEntries,
    routeSnapshotId,
    operationId,
    messageId,
    internetMessageId,
    sentMailboxEntryId,
    subject: normalizeSubject(draft.subject),
    finalObjects,
    finalMimeObject,
    monthlyPolicy,
    monthlyPeriodId,
    month,
    requestKeyDigest,
    inputDigest,
    sourceMessage,
    work,
    audit: options.audit,
    now,
  })
  statements.push(
    ...(await buildSendStorageStatements({
      database: options.database,
      storageMode: options.storageMode,
      userId: options.userId,
      messageId,
      operationId,
      draftId: draft.id,
      draftLogicalBytes,
      messageBytes: finalMime.byteLength,
      plans: storagePlans,
      now,
    })),
  )
  statements.push(...notificationWork.statements)
  try {
    await options.database.batch(statements)
  } catch (error) {
    const concurrentReplay = await findReplay(options.database, options.userId, requestKeyDigest)
    if (concurrentReplay) {
      if (!equalBytes(concurrentReplay.input_digest, inputDigest))
        throw new SendMutationConflictError()
      return {
        replayed: true,
        send: await getSendOperation({
          database: options.database,
          userId: options.userId,
          sendOperationId: concurrentReplay.send_operation_id,
        }),
      }
    }
    await Promise.all([
      releasePlatformCapacityReservation({
        database: options.database,
        reservation: capacityReservation,
        now,
      }),
      releaseSendStoragePlans(options.database, storagePlans, now),
    ])
    if (String(error).includes('过去24小时')) {
      throw new SendAccessError('quota_exceeded', '过去 24 小时的发件额度已经用完')
    }
    if (String(error).includes('域名月度')) {
      throw new SendAccessError('quota_exceeded', '当前域名本月的发件额度已经用完')
    }
    if (String(error).includes('发送操作的权限、MIME或冻结路线无效')) {
      throw new SendMutationConflictError('草稿已经被另一项发送操作使用，请刷新后查看结果')
    }
    throw error
  }
  await wakeTasks(options.queue, [...work.messages, ...notificationWork.messages])
  return {
    replayed: false,
    send: await getSendOperation({
      database: options.database,
      userId: options.userId,
      sendOperationId: operationId,
    }),
  }
}

export async function getSendOperation(options: {
  database: D1Database
  userId: string
  sendOperationId: string
}): Promise<SendOperationResult> {
  if (!isUuid(options.sendOperationId)) throw new SendAccessError('not_found', '发送记录不存在')
  const operation = await options.database
    .prepare(
      `SELECT operation.id, operation.message_id, operation.sent_mailbox_entry_id,
              operation.workflow_status, operation.accepted_at,
              operation.payload_size_bytes, message.subject,
              address.canonical_address AS sender_address
       FROM send_operations operation
       JOIN messages message ON message.id = operation.message_id
       JOIN email_addresses address ON address.id = operation.sender_address_id
       WHERE operation.id = ?1 AND operation.operator_user_id = ?2 LIMIT 1`,
    )
    .bind(options.sendOperationId, options.userId)
    .first<{
      id: string
      message_id: string
      sent_mailbox_entry_id: string
      workflow_status: string
      accepted_at: number
      payload_size_bytes: number
      subject: string
      sender_address: string
    }>()
  if (!operation) throw new SendAccessError('not_found', '发送记录不存在')
  const recipientRows = await options.database
    .prepare(
      `SELECT id, recipient_role, sequence_number, address_text, route_channel,
              delivery_status, failure_code
       FROM send_recipients WHERE send_operation_id = ?1
       ORDER BY CASE recipient_role WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END,
                sequence_number, id`,
    )
    .bind(operation.id)
    .all<{
      id: string
      recipient_role: string
      sequence_number: number
      address_text: string
      route_channel: string
      delivery_status: string
      failure_code: string | null
    }>()
  const rejectedRows = await options.database
    .prepare(
      `SELECT id, recipient_role, sequence_number, address_text, failure_code
       FROM internal_delivery_rejections WHERE send_operation_id = ?1
       ORDER BY CASE recipient_role WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END,
                sequence_number, id`,
    )
    .bind(operation.id)
    .all<{
      id: string
      recipient_role: string
      sequence_number: number
      address_text: string
      failure_code: string
    }>()
  const combinedRecipients = [
    ...recipientRows.results.map((row) => ({
      id: row.id,
      role: row.recipient_role as SendRecipientResult['role'],
      sequenceNumber: row.sequence_number,
      address: row.address_text,
      channel: (row.route_channel === 'external' ? 'external' : 'internal') as
        'external' | 'internal',
      status: row.delivery_status as SendRecipientResult['status'],
      failureCode: row.failure_code,
    })),
    ...rejectedRows.results.map((row) => ({
      id: row.id,
      role: row.recipient_role as SendRecipientResult['role'],
      sequenceNumber: row.sequence_number,
      address: row.address_text,
      channel: 'internal' as const,
      status: 'failed' as const,
      failureCode: row.failure_code,
    })),
  ].sort(
    (left, right) =>
      ({ to: 0, cc: 1, bcc: 2 })[left.role] - { to: 0, cc: 1, bcc: 2 }[right.role] ||
      left.sequenceNumber - right.sequenceNumber,
  )
  return {
    id: operation.id,
    messageId: operation.message_id,
    sentMailboxEntryId: operation.sent_mailbox_entry_id,
    workflowStatus: operation.workflow_status as SendOperationResult['workflowStatus'],
    acceptedAt: operation.accepted_at,
    subject: operation.subject,
    senderAddress: operation.sender_address,
    payloadSizeBytes: operation.payload_size_bytes,
    recipients: combinedRecipients.map((recipient) => ({
      id: recipient.id,
      role: recipient.role,
      address: recipient.address,
      channel: recipient.channel,
      status: recipient.status,
      failureCode: recipient.failureCode,
    })),
  }
}

async function findReplay(
  database: D1Database,
  userId: string,
  requestKeyDigest: Uint8Array,
): Promise<SendReplayRow | null> {
  return database
    .prepare(
      `SELECT input_digest, send_operation_id FROM send_idempotency_keys
       WHERE user_id = ?1 AND request_key_digest = ?2 LIMIT 1`,
    )
    .bind(userId, requestKeyDigest)
    .first<SendReplayRow>()
}

async function loadDraft(
  database: D1Database,
  userId: string,
  draftId: string,
): Promise<DraftSendRow | null> {
  return database
    .prepare(
      `SELECT draft.id, draft.owner_user_id, draft.status, draft.sender_address_id,
              draft.compose_kind, draft.source_message_id, draft.source_reference,
              draft.current_revision_number, content.subject, content.body_format,
              content.body_content_generation, system_admin.timezone
       FROM drafts draft
       JOIN draft_contents content ON content.draft_id = draft.id
       JOIN users user ON user.id = draft.owner_user_id AND user.status = 'active'
       JOIN system_instances system ON system.singleton_id = 1
       JOIN users system_admin ON system_admin.id = system.current_admin_user_id
       WHERE draft.id = ?1 AND draft.owner_user_id = ?2 LIMIT 1`,
    )
    .bind(draftId, userId)
    .first<DraftSendRow>()
}

async function loadAuthorizedSender(
  database: D1Database,
  userId: string,
  addressId: string,
  now: number,
): Promise<SenderRow | null> {
  return database
    .prepare(
      `SELECT address.id AS address_id, address.canonical_address,
              domain.id AS domain_id, domain.canonical_name AS domain_name,
              binding.id AS binding_id, binding.owner_type,
              binding.user_id, binding.organization_id,
              organization.name AS organization_name,
              COALESCE(preference.sender_display_name,
                       CASE WHEN binding.owner_type = 'organization' THEN organization.name ELSE user.display_name END)
                AS display_name,
              preference.signature_format, preference.signature_content
       FROM email_addresses address
       JOIN address_claims claim
         ON claim.address_id = address.id AND claim.status = 'active'
       JOIN mail_domains domain
         ON domain.id = address.domain_id AND domain.status = 'active'
       JOIN address_bindings binding
         ON binding.address_id = address.id AND binding.started_at <= ?3
        AND (binding.ended_at IS NULL OR binding.ended_at >= ?3)
       JOIN users user ON user.id = ?1 AND user.status = 'active'
       LEFT JOIN organizations organization
         ON organization.id = binding.organization_id AND organization.status = 'active'
       LEFT JOIN organization_memberships membership
         ON membership.organization_id = organization.id AND membership.user_id = ?1
        AND membership.left_at IS NULL
       LEFT JOIN user_address_preferences preference
         ON preference.user_id = ?1 AND preference.address_id = address.id
       WHERE address.id = ?2 AND address.retired_at IS NULL
         AND (
           (binding.owner_type = 'user' AND binding.user_id = ?1)
           OR (binding.owner_type = 'organization' AND membership.id IS NOT NULL
             AND (organization.creator_user_id = ?1 OR organization.members_can_send = 1))
         )
       LIMIT 1`,
    )
    .bind(userId, addressId, now)
    .first<SenderRow>()
}

async function loadDraftRecipients(
  database: D1Database,
  draftId: string,
): Promise<DraftRecipientRow[]> {
  const rows = await database
    .prepare(
      `SELECT recipient_role, sequence_number, display_name, address_text
       FROM draft_recipients WHERE draft_id = ?1
       ORDER BY CASE recipient_role WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END,
                sequence_number, id`,
    )
    .bind(draftId)
    .all<DraftRecipientRow>()
  return rows.results
}

async function loadDraftObjects(
  database: D1Database,
  draft: DraftSendRow,
): Promise<DraftObjectRow[]> {
  const rows = await database
    .prepare(
      `SELECT object.id, object.object_key, object.object_role,
              object.logical_part_key, object.sequence_number, object.media_type,
              object.untrusted_file_name, object.expected_size_bytes, object.expected_sha256
       FROM object_registry object
       WHERE object.owner_kind = 'draft' AND object.owner_reference = ?1
         AND object.object_status = 'active' AND object.is_current = 1
         AND (
           (object.object_role = 'draft_body' AND object.logical_part_key = 'body'
             AND object.generation = ?2)
           OR (object.object_role = 'draft_attachment' AND EXISTS (
             SELECT 1 FROM draft_attachments attachment
             WHERE attachment.draft_id = ?1 AND attachment.id = object.logical_part_key
               AND attachment.content_generation = object.generation
               AND attachment.revision_number = ?3
           ))
         )
       ORDER BY CASE object.object_role WHEN 'draft_body' THEN 0 ELSE 1 END,
                object.sequence_number, object.id`,
    )
    .bind(draft.id, draft.body_content_generation, draft.current_revision_number)
    .all<DraftObjectRow>()
  return rows.results
}

async function loadSourceMessage(
  database: D1Database,
  sourceMessageId: string | null,
): Promise<SourceMessageContext | null> {
  if (!sourceMessageId) return null
  const [message, relationRows] = await Promise.all([
    database
      .prepare(`SELECT internet_message_id FROM messages WHERE id = ?1 LIMIT 1`)
      .bind(sourceMessageId)
      .first<{ internet_message_id: string | null }>(),
    database
      .prepare(
        `SELECT relation_type, sequence_number, target_reference
         FROM message_relations
         WHERE child_message_id = ?1 AND relation_type IN ('reference', 'in_reply_to')
         ORDER BY CASE relation_type WHEN 'reference' THEN 0 ELSE 1 END,
                  sequence_number, id`,
      )
      .bind(sourceMessageId)
      .all<{ relation_type: string; sequence_number: number; target_reference: string }>(),
  ])
  if (!message) return null
  const referenceRows = relationRows.results.filter((row) => row.relation_type === 'reference')
  const ancestry = referenceRows.length
    ? referenceRows.map((row) => row.target_reference)
    : relationRows.results
        .filter((row) => row.relation_type === 'in_reply_to')
        .map((row) => row.target_reference)
  const references = [...new Set([...ancestry, message.internet_message_id].filter(isMessageId))]
  return { internetMessageId: message.internet_message_id, references }
}

async function normalizeAndDeduplicateRecipients(
  rows: DraftRecipientRow[],
): Promise<
  Array<
    Omit<ResolvedRecipient, 'id' | 'channel' | 'deliveryId' | 'internalRoute' | 'quotaRejected'>
  >
> {
  const priority = { to: 0, cc: 1, bcc: 2 } as const
  const sorted = [...rows].sort(
    (left, right) =>
      priority[left.recipient_role] - priority[right.recipient_role] ||
      left.sequence_number - right.sequence_number,
  )
  const seen = new Set<string>()
  const counts = { to: 0, cc: 0, bcc: 0 }
  const result: Array<
    Omit<ResolvedRecipient, 'id' | 'channel' | 'deliveryId' | 'internalRoute' | 'quotaRejected'>
  > = []
  for (const row of sorted) {
    const normalized = normalizeRecipientEmailAddress(row.address_text)
    if (seen.has(normalized.canonicalAddress)) continue
    seen.add(normalized.canonicalAddress)
    result.push({
      role: row.recipient_role,
      sequenceNumber: counts[row.recipient_role]++,
      displayName: row.display_name,
      address: normalized.canonicalAddress,
      canonicalAddress: normalized.canonicalAddress,
      deduplicationKey: await sha256Bytes(normalized.canonicalAddress),
    })
  }
  return result
}

async function resolveRecipients(
  database: D1Database,
  recipients: Array<
    Omit<ResolvedRecipient, 'id' | 'channel' | 'deliveryId' | 'internalRoute' | 'quotaRejected'>
  >,
): Promise<ResolvedRecipient[]> {
  const resolved: ResolvedRecipient[] = []
  for (const recipient of recipients) {
    const domainName = recipient.canonicalAddress.slice(
      recipient.canonicalAddress.lastIndexOf('@') + 1,
    )
    const managedDomain = await database
      .prepare(`SELECT id, status FROM mail_domains WHERE canonical_name = ?1 LIMIT 1`)
      .bind(domainName)
      .first<{ id: string; status: string }>()
    if (!managedDomain) {
      resolved.push({
        ...recipient,
        id: crypto.randomUUID(),
        channel: 'external',
        deliveryId: null,
        internalRoute: null,
        quotaRejected: false,
      })
      continue
    }
    if (managedDomain.status !== 'active') {
      throw new SendAccessError('recipient_unavailable', `收件域名 ${domainName} 当前已经暂停`)
    }
    const route = await database
      .prepare(
        `SELECT address.id AS address_id, binding.id AS address_binding_id,
                address.canonical_address, binding.owner_type,
                binding.user_id, binding.organization_id
         FROM address_claims claim
         JOIN email_addresses address
           ON address.id = claim.address_id AND address.retired_at IS NULL
         JOIN address_bindings binding
           ON binding.address_id = address.id AND binding.ended_at IS NULL
         LEFT JOIN users user
           ON user.id = binding.user_id
         LEFT JOIN organizations organization
           ON organization.id = binding.organization_id
         WHERE claim.canonical_address = ?1 AND claim.status = 'active'
           AND ((binding.owner_type = 'user' AND user.status = 'active')
             OR (binding.owner_type = 'organization' AND organization.status = 'active'))
         LIMIT 1`,
      )
      .bind(recipient.canonicalAddress)
      .first<InternalRouteRow>()
    if (!route) {
      throw new SendAccessError(
        'recipient_unavailable',
        `系统内地址 ${recipient.canonicalAddress} 不存在或已经停用`,
      )
    }
    resolved.push({
      ...recipient,
      id: crypto.randomUUID(),
      channel: 'internal',
      deliveryId: crypto.randomUUID(),
      internalRoute: route,
      quotaRejected: false,
    })
  }
  return resolved
}

async function prepareSendStoragePlans(options: {
  database: D1Database
  storageMode: StorageMode
  userId: string
  sender: SenderRow
  recipients: ResolvedRecipient[]
  operationId: string
  messageBytes: number
  draftLogicalBytes: number
  now: number
}): Promise<SendStorageOwnerPlan[]> {
  const plans = new Map<string, SendStorageOwnerPlan>()
  const senderOwner: LogicalStorageOwner =
    options.sender.owner_type === 'user'
      ? { ownerType: 'user', ownerId: options.sender.user_id! }
      : { ownerType: 'organization', ownerId: options.sender.organization_id! }
  const senderKey = storageOwnerKey(senderOwner)
  plans.set(senderKey, {
    key: senderKey,
    owner: senderOwner,
    includesSender: true,
    includesDraftOwner: senderOwner.ownerType === 'user' && senderOwner.ownerId === options.userId,
    recipientIds: [],
    bytesDelta: 0,
    reservation: null,
  })
  for (const recipient of options.recipients) {
    if (recipient.channel !== 'internal') continue
    const owner = internalStorageOwner(recipient.internalRoute!)
    const key = storageOwnerKey(owner)
    const plan = plans.get(key) ?? {
      key,
      owner,
      includesSender: false,
      includesDraftOwner: owner.ownerType === 'user' && owner.ownerId === options.userId,
      recipientIds: [],
      bytesDelta: 0,
      reservation: null,
    }
    plan.recipientIds.push(recipient.id)
    plans.set(key, plan)
  }

  const draftOwner: LogicalStorageOwner = { ownerType: 'user', ownerId: options.userId }
  const draftOwnerKey = storageOwnerKey(draftOwner)
  if (!plans.has(draftOwnerKey)) {
    plans.set(draftOwnerKey, {
      key: draftOwnerKey,
      owner: draftOwner,
      includesSender: false,
      includesDraftOwner: true,
      recipientIds: [],
      bytesDelta: 0,
      reservation: null,
    })
  }

  for (const plan of plans.values()) {
    const includesMessage = plan.includesSender || plan.recipientIds.length > 0
    plan.bytesDelta =
      (includesMessage ? options.messageBytes : 0) -
      (plan.includesDraftOwner ? options.draftLogicalBytes : 0)
    const netGrowth = Math.max(0, plan.bytesDelta)
    if (netGrowth === 0) continue
    try {
      plan.reservation = await reserveLogicalStorage({
        database: options.database,
        storageMode: options.storageMode,
        owner: plan.owner,
        operationKind: 'sent_copy',
        operationReference: `send:${options.operationId}:${plan.key}`,
        bytes: netGrowth,
        now: options.now,
      })
    } catch (error) {
      if (!(error instanceof LogicalStorageCapacityError) || plan.includesSender) {
        await releaseSendStoragePlans(options.database, [...plans.values()], options.now)
        if (error instanceof LogicalStorageCapacityError) {
          throw new SendAccessError('quota_exceeded', '发件邮箱的存储配额不足，尚未发送')
        }
        throw error
      }
      for (const recipient of options.recipients) {
        if (plan.recipientIds.includes(recipient.id)) recipient.quotaRejected = true
      }
      plan.bytesDelta = plan.includesDraftOwner ? -options.draftLogicalBytes : 0
    }
  }
  return [...plans.values()]
}

async function releaseSendStoragePlans(
  database: D1Database,
  plans: SendStorageOwnerPlan[],
  now: number,
): Promise<void> {
  for (const plan of plans) {
    await releaseLogicalStorageReservation({ database, reservation: plan.reservation, now })
  }
}

async function buildSendStorageStatements(options: {
  database: D1Database
  storageMode: StorageMode
  userId: string
  messageId: string
  operationId: string
  draftId: string
  draftLogicalBytes: number
  messageBytes: number
  plans: SendStorageOwnerPlan[]
  now: number
}): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = []
  for (const plan of options.plans) {
    if (plan.reservation) {
      statements.push(
        ...(await logicalStorageCommitStatements({
          database: options.database,
          reservation: plan.reservation,
          entryKind: plan.includesSender ? 'sent_copy' : 'message',
          ownerReference: `message:${options.messageId}`,
          now: options.now,
        })),
      )
    }
    if (plan.bytesDelta < 0) {
      const decrease = await logicalStorageAdjustmentStatement({
        database: options.database,
        storageMode: options.storageMode,
        owner: plan.owner,
        entryKind: plan.includesDraftOwner ? 'draft' : 'message',
        ownerReference: plan.includesDraftOwner
          ? `draft:${options.draftId}`
          : `message:${options.messageId}`,
        bytesDelta: plan.bytesDelta,
        idempotencyKey: `send-storage-decrease:${options.operationId}:${plan.key}`,
        now: options.now,
      })
      if (decrease) statements.push(decrease)
    }
  }
  return statements
}

function internalStorageOwner(route: InternalRouteRow): LogicalStorageOwner {
  return route.owner_type === 'user'
    ? { ownerType: 'user', ownerId: route.user_id! }
    : { ownerType: 'organization', ownerId: route.organization_id! }
}

function storageOwnerKey(owner: LogicalStorageOwner): string {
  return `${owner.ownerType}:${owner.ownerId}`
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
    .all<Omit<RouteEntryRow, 'provider_options_digest'>>()
  if (rows.results.length && rows.results.some((row, index) => row.priority_number !== index)) {
    throw new SendAccessError('external_route_missing', '域外发信路线顺序无效，请由管理员重新保存')
  }
  return Promise.all(
    rows.results.map(async (row) => ({
      ...row,
      provider_options_digest: await sha256Bytes(row.public_options_json),
    })),
  )
}

async function readVerifiedDraftObject(
  store: MailObjectStore,
  object: DraftObjectRow,
): Promise<Uint8Array> {
  const stored = await store.get(object.object_key)
  if (!stored) throw new SendInputError('message', '草稿正文或附件暂时不可用')
  const digest = await sha256Bytes(stored.bytes)
  if (
    stored.bytes.byteLength !== object.expected_size_bytes ||
    !equalBytes(digest, object.expected_sha256)
  ) {
    throw new SendInputError('message', '草稿正文或附件完整性校验失败')
  }
  return new Uint8Array(stored.bytes)
}

function createFinalMime(options: {
  sender: SenderRow
  recipients: ResolvedRecipient[]
  subject: string
  bodyFormat: string
  body: string
  attachments: Array<{ object: DraftObjectRow; bytes: Uint8Array }>
  internetMessageId: string
  sourceInternetMessageId: string | null
  sourceReferences: string[]
  now: number
}): Uint8Array {
  const message = createMimeMessage()
  message.setSender(
    options.sender.display_name
      ? { addr: options.sender.canonical_address, name: options.sender.display_name }
      : { addr: options.sender.canonical_address },
  )
  const to = mailboxRecipients(options.recipients, 'to')
  const cc = mailboxRecipients(options.recipients, 'cc')
  if (to.length) message.setTo(to)
  if (cc.length) message.setCc(cc)
  message.setSubject(options.subject)
  message.setHeader('Date', new Date(options.now).toUTCString())
  message.setHeader('Message-ID', options.internetMessageId)
  if (options.sourceInternetMessageId) {
    message.setHeader('In-Reply-To', options.sourceInternetMessageId)
    message.setHeader(
      'References',
      (options.sourceReferences.length
        ? options.sourceReferences
        : [options.sourceInternetMessageId]
      ).join(' '),
    )
  }
  message.addMessage({
    contentType: options.bodyFormat === 'rich_text' ? 'text/html' : 'text/plain',
    charset: 'UTF-8',
    data: options.body,
  })
  for (const attachment of options.attachments) {
    message.addAttachment({
      filename: attachment.object.untrusted_file_name || 'attachment',
      contentType: attachment.object.media_type || 'application/octet-stream',
      data: bytesToBase64(attachment.bytes),
    })
  }
  return new TextEncoder().encode(message.asRaw())
}

function mailboxRecipients(recipients: ResolvedRecipient[], role: 'to' | 'cc') {
  return recipients
    .filter((recipient) => recipient.role === role)
    .map((recipient) =>
      recipient.displayName
        ? { addr: recipient.address, name: recipient.displayName }
        : { addr: recipient.address },
    )
}

async function storeFinalMessageObjects(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  messageId: string
  finalMime: Uint8Array
  bodyFormat: string
  body: Uint8Array
  attachments: Array<{ object: DraftObjectRow; bytes: Uint8Array }>
  now: number
}): Promise<StoredMessageObject[]> {
  const definitions: Array<{
    role: StoredMessageObject['role']
    logicalPartKey: string
    bytes: Uint8Array
    mediaType: string
    fileName: string | null
    sequenceNumber: number
  }> = [
    {
      role: 'final_mime',
      logicalPartKey: 'final',
      bytes: options.finalMime,
      mediaType: 'message/rfc822',
      fileName: null,
      sequenceNumber: 0,
    },
    {
      role: options.bodyFormat === 'rich_text' ? 'html_body' : 'plain_body',
      logicalPartKey: 'body',
      bytes: options.body,
      mediaType:
        options.bodyFormat === 'rich_text'
          ? 'text/html; charset=utf-8'
          : 'text/plain; charset=utf-8',
      fileName: null,
      sequenceNumber: 0,
    },
    ...options.attachments.map((attachment, index) => ({
      role: 'attachment' as const,
      logicalPartKey: crypto.randomUUID(),
      bytes: attachment.bytes,
      mediaType: attachment.object.media_type || 'application/octet-stream',
      fileName: attachment.object.untrusted_file_name || 'attachment',
      sequenceNumber: index,
    })),
  ]
  const stored: StoredMessageObject[] = []
  for (const definition of definitions) {
    stored.push(
      await storeMessageObject({
        ...options,
        ...definition,
      }),
    )
  }
  return stored
}

async function storeMessageObject(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  messageId: string
  role: StoredMessageObject['role']
  logicalPartKey: string
  bytes: Uint8Array
  mediaType: string
  fileName: string | null
  sequenceNumber: number
  now: number
}): Promise<StoredMessageObject> {
  const id = crypto.randomUUID()
  const digest = await sha256Bytes(options.bytes)
  const key = `mail/messages/${options.messageId}/${options.role}/${options.logicalPartKey}/v1-${id}`
  await options.database
    .prepare(
      `INSERT INTO object_registry (
        id, storage_mode, object_key, owner_kind, owner_reference, message_id,
        object_role, logical_part_key, sequence_number, generation,
        required_for_visibility, is_current, expected_size_bytes, expected_sha256,
        actual_size_bytes, actual_sha256, media_type, untrusted_file_name,
        content_disposition, content_id, producer_version, backend_version_reference,
        object_status, stored_at, verified_at, consistency_checked_at,
        activated_at, superseded_at, delete_after, deleted_at, created_at, updated_at
       ) VALUES (
        ?1, ?2, ?3, 'message', ?4, NULL, ?5, ?6, ?7, 1,
        1, 0, ?8, ?9, NULL, NULL, ?10, ?11, ?12, NULL, ?13, NULL,
        'write_intent', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?14, ?14
       )`,
    )
    .bind(
      id,
      options.storageMode,
      key,
      options.messageId,
      options.role,
      options.logicalPartKey,
      options.sequenceNumber,
      options.bytes.byteLength,
      digest,
      options.mediaType,
      options.fileName,
      options.role === 'attachment' ? 'attachment' : null,
      MIME_GENERATOR_VERSION,
      options.now,
    )
    .run()
  const backendVersionReference = await options.objectStore.put({
    key,
    bytes: toArrayBuffer(options.bytes),
    mediaType: options.mediaType,
    sha256Hex: bytesToHex(digest),
  })
  let stored = await options.objectStore.get(key)
  if (!stored && options.storageMode === 'kv') {
    await new Promise((resolve) => setTimeout(resolve, 50))
    stored = await options.objectStore.get(key)
  }
  if (!stored) throw new Error('邮件对象写入后暂时不可读取')
  const storedDigest = await sha256Bytes(stored.bytes)
  if (stored.bytes.byteLength !== options.bytes.byteLength || !equalBytes(storedDigest, digest)) {
    throw new Error('邮件对象写入校验失败')
  }
  const verified = await options.database
    .prepare(
      `UPDATE object_registry
       SET object_status = 'verified', actual_size_bytes = ?1, actual_sha256 = ?2,
           backend_version_reference = ?3, stored_at = ?4, verified_at = ?4,
           consistency_checked_at = ?4, updated_at = ?4
       WHERE id = ?5 AND object_status = 'write_intent'`,
    )
    .bind(
      stored.bytes.byteLength,
      storedDigest,
      backendVersionReference ?? stored.backendVersionReference,
      options.now,
      id,
    )
    .run()
  if (verified.meta.changes !== 1) throw new Error('邮件对象登记状态已经发生变化')
  return {
    id,
    role: options.role,
    logicalPartKey: options.logicalPartKey,
    bytes: options.bytes,
    digest,
    mediaType: options.mediaType,
    fileName: options.fileName,
    sequenceNumber: options.sequenceNumber,
  }
}

interface MonthlyPolicy {
  id: string
  limit: number | null
}

interface MonthBounds {
  startAt: number
  endAt: number
  timezone: string
}

interface WorkItems {
  messages: BackgroundTaskMessage[]
  searchTask: { id: string; digest: Uint8Array }
  conversationTask: { id: string; digest: Uint8Array }
  outboundTask: { id: string; digest: Uint8Array } | null
}

async function resolveMonthlyPolicy(
  database: D1Database,
  domainId: string,
): Promise<MonthlyPolicy> {
  const row = await database
    .prepare(
      `SELECT id, limit_value FROM quota_policies
       WHERE quota_kind = 'domain_monthly_send_recipients' AND policy_status = 'active'
         AND ((scope_type = 'domain' AND mail_domain_id = ?1)
           OR scope_type = 'system_default')
       ORDER BY CASE scope_type WHEN 'domain' THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .bind(domainId)
    .first<{ id: string; limit_value: number | null }>()
  if (!row) throw new Error('域名月度发件配额策略不存在')
  return { id: row.id, limit: row.limit_value }
}

async function buildWorkItems(messageId: string, needsOutbound: boolean): Promise<WorkItems> {
  const searchTask = {
    id: crypto.randomUUID(),
    digest: await sha256Bytes(`index_message\n${messageId}\n1`),
  }
  const conversationTask = {
    id: crypto.randomUUID(),
    digest: await sha256Bytes(`rebuild_conversation\n${messageId}\n1`),
  }
  const outboundTask = needsOutbound
    ? {
        id: crypto.randomUUID(),
        digest: await sha256Bytes(`submit_outbound_send\n${messageId}\n1`),
      }
    : null
  return {
    searchTask,
    conversationTask,
    outboundTask,
    messages: [
      { taskId: searchTask.id, inputVersion: 1 },
      { taskId: conversationTask.id, inputVersion: 1 },
      ...(outboundTask ? [{ taskId: outboundTask.id, inputVersion: 1 }] : []),
    ],
  }
}

function buildAcceptanceStatements(options: {
  database: D1Database
  userId: string
  draft: DraftSendRow
  sender: SenderRow
  recipients: ResolvedRecipient[]
  routeEntries: RouteEntryRow[]
  routeSnapshotId: string | null
  operationId: string
  messageId: string
  internetMessageId: string
  sentMailboxEntryId: string
  subject: string
  finalObjects: StoredMessageObject[]
  finalMimeObject: StoredMessageObject
  monthlyPolicy: MonthlyPolicy
  monthlyPeriodId: string
  month: MonthBounds
  requestKeyDigest: Uint8Array
  inputDigest: Uint8Array
  sourceMessage: SourceMessageContext | null
  work: WorkItems
  audit: AuditContext
  now: number
}): D1PreparedStatement[] {
  const internalRecipients = options.recipients.filter(
    (recipient) => recipient.channel === 'internal' && !recipient.quotaRejected,
  )
  const externalRecipients = options.recipients.filter(
    (recipient) => recipient.channel === 'external',
  )
  const quotaRejectedRecipients = options.recipients.filter((recipient) => recipient.quotaRejected)
  const acceptedRecipientCount = internalRecipients.length + externalRecipients.length
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO messages (
          id, origin_type, authored_by_user_id, internet_message_id, subject,
          header_date_text, header_date_at, accepted_at, sort_at, raw_size_bytes,
          attachment_count, has_attachments, created_at, updated_at
         ) VALUES (
          ?1, 'composed', ?2, ?3, ?4, ?5, ?6, ?6, ?6, ?7, ?8, ?9, ?6, ?6
         )`,
      )
      .bind(
        options.messageId,
        options.userId,
        options.internetMessageId,
        options.subject,
        new Date(options.now).toUTCString(),
        options.now,
        options.finalMimeObject.bytes.byteLength,
        options.finalObjects.filter((object) => object.role === 'attachment').length,
        options.finalObjects.some((object) => object.role === 'attachment') ? 1 : 0,
      ),
    ...messageHeaderStatements(options),
    ...options.finalObjects.map((object) =>
      options.database
        .prepare(
          `UPDATE object_registry
           SET message_id = ?1, object_status = 'active', is_current = 1,
               activated_at = ?2, updated_at = ?2
           WHERE id = ?3 AND owner_kind = 'message' AND owner_reference = ?1
             AND message_id IS NULL AND object_status = 'verified' AND is_current = 0`,
        )
        .bind(options.messageId, options.now, object.id),
    ),
    options.database
      .prepare(
        `INSERT INTO message_integrity_states (
          message_id, source_completeness, integrity_status, object_set_version,
          ready_at, hidden_since, damage_code, damage_summary, created_at, updated_at
         ) VALUES (?1, 'final_mime', 'ready', 1, ?2, NULL, NULL, NULL, ?2, ?2)`,
      )
      .bind(options.messageId, options.now),
    options.database
      .prepare(
        `INSERT INTO message_search_states (
          message_id, object_set_version, index_generation, index_status,
          chunk_count, last_error_code, indexed_at, created_at, updated_at
         ) VALUES (?1, 1, 1, 'pending', 0, NULL, NULL, ?2, ?2)`,
      )
      .bind(options.messageId, options.now),
    backgroundTaskStatement(
      options.database,
      options.work.searchTask,
      'index_message',
      'message_search',
      options.messageId,
      INDEX_TASK_MAX_ATTEMPTS,
      3,
      options.now,
    ),
    backgroundTaskStatement(
      options.database,
      options.work.conversationTask,
      'rebuild_conversation',
      'message_conversation',
      options.messageId,
      CONVERSATION_TASK_MAX_ATTEMPTS,
      3,
      options.now,
    ),
  ]

  if (isReplyComposeKind(options.draft.compose_kind) && options.draft.source_message_id) {
    statements.push(
      options.database
        .prepare(
          `INSERT INTO message_relations (
            id, child_message_id, relation_type, sequence_number,
            target_reference, target_message_id, created_at
           ) VALUES (?1, ?2, 'internal_reply', 0, ?3, ?4, ?5)`,
        )
        .bind(
          crypto.randomUUID(),
          options.messageId,
          options.draft.source_reference || `message:${options.draft.source_message_id}`,
          options.draft.source_message_id,
          options.now,
        ),
    )
    if (options.sourceMessage?.internetMessageId) {
      statements.push(
        options.database
          .prepare(
            `INSERT INTO message_relations (
              id, child_message_id, relation_type, sequence_number,
              target_reference, target_message_id, created_at
             ) VALUES (?1, ?2, 'in_reply_to', 0, ?3, ?4, ?5)`,
          )
          .bind(
            crypto.randomUUID(),
            options.messageId,
            options.sourceMessage.internetMessageId,
            options.draft.source_message_id,
            options.now,
          ),
        ...options.sourceMessage.references.map((reference, index) =>
          options.database
            .prepare(
              `INSERT INTO message_relations (
                id, child_message_id, relation_type, sequence_number,
                target_reference, target_message_id, created_at
               ) VALUES (?1, ?2, 'reference', ?3, ?4, ?5, ?6)`,
            )
            .bind(
              crypto.randomUUID(),
              options.messageId,
              index,
              reference,
              reference === options.sourceMessage?.internetMessageId
                ? options.draft.source_message_id
                : null,
              options.now,
            ),
        ),
      )
    }
  }

  statements.push(
    options.database
      .prepare(
        `INSERT INTO mailbox_entries (
          id, message_id, mailbox_type, user_id, organization_id,
          entry_kind, base_location, occurred_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'sent', 'sent', ?6, ?6)`,
      )
      .bind(
        options.sentMailboxEntryId,
        options.messageId,
        options.sender.owner_type,
        options.sender.owner_type === 'user' ? options.sender.user_id : null,
        options.sender.owner_type === 'organization' ? options.sender.organization_id : null,
        options.now,
      ),
  )

  const receivedEntries = createReceivedMailboxEntries(internalRecipients)
  for (const recipient of internalRecipients) {
    const route = recipient.internalRoute!
    statements.push(
      options.database
        .prepare(
          `INSERT INTO message_deliveries (
            id, message_id, address_binding_id, canonical_recipient_address,
            display_recipient_address, delivery_source, delivered_at, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, 'internal_delivery', ?6, ?6)`,
        )
        .bind(
          recipient.deliveryId,
          options.messageId,
          route.address_binding_id,
          recipient.canonicalAddress,
          recipient.address,
          options.now,
        ),
    )
  }
  for (const entry of receivedEntries.values()) {
    statements.push(
      options.database
        .prepare(
          `INSERT INTO mailbox_entries (
            id, message_id, mailbox_type, user_id, organization_id,
            entry_kind, base_location, occurred_at, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, 'received', 'inbox', ?6, ?6)`,
        )
        .bind(
          entry.id,
          options.messageId,
          entry.ownerType,
          entry.userId,
          entry.organizationId,
          options.now,
        ),
    )
  }
  for (const recipient of internalRecipients) {
    statements.push(
      options.database
        .prepare(
          `INSERT INTO mailbox_entry_deliveries (mailbox_entry_id, delivery_id, created_at)
           VALUES (?1, ?2, ?3)`,
        )
        .bind(
          receivedEntries.get(internalOwnerKey(recipient.internalRoute!))!.id,
          recipient.deliveryId,
          options.now,
        ),
    )
  }

  if (options.routeSnapshotId) {
    const route = options.routeEntries[0]
    if (!route) throw new Error('域外发信路线快照缺少来源路线')
    statements.push(
      options.database
        .prepare(
          `INSERT INTO outbound_route_snapshots (
            id, mail_domain_id, source_route_id, source_route_version,
            execution_kind, execution_reference, payload_sha256,
            payload_size_bytes, created_at
           ) VALUES (?1, ?2, ?3, ?4, 'send', ?5, ?6, ?7, ?8)`,
        )
        .bind(
          options.routeSnapshotId,
          options.sender.domain_id,
          route.route_id,
          route.route_version,
          options.operationId,
          options.finalMimeObject.digest,
          options.finalMimeObject.bytes.byteLength,
          options.now,
        ),
      ...options.routeEntries.map((entry) =>
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
            options.routeSnapshotId,
            entry.priority_number,
            entry.provider_config_id,
            entry.configuration_key,
            entry.configuration_version,
            entry.provider_type,
            MAX_MESSAGE_BYTES,
            entry.provider_options_digest,
            options.now,
          ),
      ),
    )
  }

  statements.push(
    options.database
      .prepare(
        `INSERT INTO send_operations (
          id, operator_user_id, source_draft_id, source_draft_reference,
          source_draft_revision_number, message_id, sent_mailbox_entry_id,
          sender_address_id, sender_address_binding_id, sent_mailbox_type,
          sent_user_id, sent_organization_id, compose_kind, source_message_id,
          source_reference, recipient_count, internal_recipient_count,
          external_recipient_count, quota_recipient_units, payload_sha256,
          payload_size_bytes, effective_size_limit_bytes, outbound_route_snapshot_id,
          workflow_status, accepted_at, created_at, updated_at,
          final_mime_object_id, payload_generator_version
         ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
          ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?16, ?19,
          ?20, ?21, ?22, ?23, ?24, ?24, ?24, ?25, ?26
         )`,
      )
      .bind(
        options.operationId,
        options.userId,
        options.draft.id,
        `draft:${options.draft.id}`,
        options.draft.current_revision_number,
        options.messageId,
        options.sentMailboxEntryId,
        options.sender.address_id,
        options.sender.binding_id,
        options.sender.owner_type,
        options.sender.owner_type === 'user' ? options.sender.user_id : null,
        options.sender.owner_type === 'organization' ? options.sender.organization_id : null,
        options.draft.compose_kind,
        options.draft.source_message_id,
        options.draft.source_reference,
        acceptedRecipientCount,
        internalRecipients.length,
        externalRecipients.length,
        options.finalMimeObject.digest,
        options.finalMimeObject.bytes.byteLength,
        MAX_MESSAGE_BYTES,
        options.routeSnapshotId,
        externalRecipients.length ? 'processing' : 'finished',
        options.now,
        options.finalMimeObject.id,
        MIME_GENERATOR_VERSION,
      ),
  )

  for (const recipient of options.recipients) {
    if (recipient.quotaRejected) continue
    const deliveryStatus = recipient.channel === 'internal' ? 'delivered' : 'waiting'
    statements.push(
      options.database
        .prepare(
          `INSERT INTO send_recipients (
            id, send_operation_id, recipient_role, sequence_number,
            display_name, address_text, canonical_address, deduplication_key,
            route_channel, message_delivery_id, delivery_status, status_version,
            status_updated_at, failure_code, failure_detail, complained_at,
            last_provider_reference, created_at, updated_at
           ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
            ?11, 1, ?12, NULL, NULL, NULL, NULL, ?12, ?12
           )`,
        )
        .bind(
          recipient.id,
          options.operationId,
          recipient.role,
          recipient.sequenceNumber,
          recipient.displayName,
          recipient.address,
          recipient.canonicalAddress,
          recipient.deduplicationKey,
          recipient.channel === 'internal' ? 'internal_assigned' : 'external',
          recipient.deliveryId,
          deliveryStatus,
          options.now,
        ),
      options.database
        .prepare(
          `INSERT INTO send_recipient_status_history (
            id, send_recipient_id, previous_status, new_status, status_version,
            source_type, source_reference, occurred_at, created_at
           ) VALUES (?1, ?2, NULL, ?3, 1, 'send_acceptance', ?4, ?5, ?5)`,
        )
        .bind(crypto.randomUUID(), recipient.id, deliveryStatus, options.operationId, options.now),
    )
    if (recipient.channel === 'external') {
      statements.push(
        options.database
          .prepare(
            `INSERT INTO send_recipient_route_progress (
              send_recipient_id, route_snapshot_id, next_priority_number,
              selected_route_snapshot_entry_id, progress_status, last_attempt_id,
              last_switch_reason, created_at, updated_at
             ) VALUES (?1, ?2, 0, NULL, 'ready', NULL, NULL, ?3, ?3)`,
          )
          .bind(recipient.id, options.routeSnapshotId, options.now),
      )
    }
  }

  statements.push(
    options.database
      .prepare(
        `INSERT OR IGNORE INTO domain_monthly_usage_periods (
          id, mail_domain_id, period_start_at, period_end_at, timezone_name,
          quota_policy_id, quota_limit_snapshot, committed_units, reserved_units,
          unknown_held_units, period_status, closed_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, 'open', NULL, ?8, ?8)`,
      )
      .bind(
        options.monthlyPeriodId,
        options.sender.domain_id,
        options.month.startAt,
        options.month.endAt,
        options.month.timezone,
        options.monthlyPolicy.id,
        options.monthlyPolicy.limit,
        options.now,
      ),
    ...options.recipients
      .filter((recipient) => !recipient.quotaRejected)
      .map((recipient) =>
        options.database
          .prepare(
            `INSERT INTO domain_monthly_usage_reservations (
            id, domain_monthly_usage_period_id, send_recipient_id,
            usage_status, reserved_at, committed_at, released_at, unknown_at,
            created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?5, ?5)`,
          )
          .bind(
            crypto.randomUUID(),
            options.monthlyPeriodId,
            recipient.id,
            recipient.channel === 'internal' ? 'committed' : 'reserved',
            options.now,
            recipient.channel === 'internal' ? options.now : null,
          ),
      ),
    options.database
      .prepare(
        `INSERT INTO send_idempotency_keys (
          user_id, request_key_digest, input_digest, send_operation_id,
          accepted_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      )
      .bind(
        options.userId,
        options.requestKeyDigest,
        options.inputDigest,
        options.operationId,
        options.now,
      ),
  )
  for (const recipient of quotaRejectedRecipients) {
    const route = recipient.internalRoute!
    statements.push(
      options.database
        .prepare(
          `INSERT INTO internal_delivery_rejections (
             id, send_operation_id, recipient_role, sequence_number,
             address_text, canonical_address, owner_type, user_id,
             organization_id, failure_code, failure_detail, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                     'storage_quota_exceeded', '目标邮箱存储配额不足', ?10)`,
        )
        .bind(
          crypto.randomUUID(),
          options.operationId,
          recipient.role,
          recipient.sequenceNumber,
          recipient.address,
          recipient.canonicalAddress,
          route.owner_type,
          route.user_id,
          route.organization_id,
          options.now,
        ),
    )
  }
  if (options.work.outboundTask) {
    statements.push(
      backgroundTaskStatement(
        options.database,
        options.work.outboundTask,
        'submit_outbound_send',
        'send_operation',
        options.operationId,
        SEND_TASK_MAX_ATTEMPTS,
        1,
        options.now,
      ),
    )
  }
  statements.push(
    options.database
      .prepare(
        `UPDATE drafts
         SET status = 'consumed', consumed_at = ?1, trashed_at = NULL,
             trash_due_at = NULL, updated_at = ?1
         WHERE id = ?2 AND owner_user_id = ?3 AND status = 'active'
           AND current_revision_number = ?4`,
      )
      .bind(options.now, options.draft.id, options.userId, options.draft.current_revision_number),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName: 'message_sent',
      targetType: 'send_operation',
      targetReference: options.operationId,
      outcome: 'succeeded',
      occurredAt: options.now,
    }),
  )
  return statements
}

function messageHeaderStatements(options: {
  database: D1Database
  messageId: string
  sender: SenderRow
  recipients: ResolvedRecipient[]
  now: number
}): D1PreparedStatement[] {
  const values = [
    {
      role: 'from',
      sequence: 0,
      displayName: options.sender.display_name,
      address: options.sender.canonical_address,
      visibility: 'header',
    },
    ...options.recipients.map((recipient) => ({
      role: recipient.role,
      sequence: recipient.sequenceNumber,
      displayName: recipient.displayName,
      address: recipient.address,
      visibility: recipient.role === 'bcc' ? 'sender_only' : 'header',
    })),
  ]
  return values.map((value) =>
    options.database
      .prepare(
        `INSERT INTO message_header_addresses (
          id, message_id, address_role, sequence_number, display_name,
          address_text, canonical_address, visibility_scope, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)`,
      )
      .bind(
        crypto.randomUUID(),
        options.messageId,
        value.role,
        value.sequence,
        value.displayName,
        value.address,
        value.visibility,
        options.now,
      ),
  )
}

function createReceivedMailboxEntries(recipients: ResolvedRecipient[]) {
  const entries = new Map<
    string,
    {
      id: string
      ownerType: 'user' | 'organization'
      userId: string | null
      organizationId: string | null
    }
  >()
  for (const recipient of recipients) {
    const route = recipient.internalRoute!
    const key = internalOwnerKey(route)
    if (!entries.has(key)) {
      entries.set(key, {
        id: crypto.randomUUID(),
        ownerType: route.owner_type,
        userId: route.owner_type === 'user' ? route.user_id : null,
        organizationId: route.owner_type === 'organization' ? route.organization_id : null,
      })
    }
  }
  return entries
}

function internalOwnerKey(route: InternalRouteRow): string {
  return route.owner_type === 'user'
    ? `user:${route.user_id}`
    : `organization:${route.organization_id}`
}

function backgroundTaskStatement(
  database: D1Database,
  task: { id: string; digest: Uint8Array },
  taskType: string,
  targetType: string,
  targetReference: string,
  maxAttempts: number,
  priority: number,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO background_tasks (
        id, task_type, target_type, target_reference, input_version,
        task_key_digest, task_status, priority, attempt_count, max_attempts,
        next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
        last_error_code, last_error_summary, last_error_at, completed_at,
        created_at, updated_at
       ) VALUES (
        ?1, ?2, ?3, ?4, 1, ?5, 'pending', ?6, 0, ?7,
        ?8, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?8, ?8
       )`,
    )
    .bind(task.id, taskType, targetType, targetReference, task.digest, priority, maxAttempts, now)
}

async function wakeTasks(
  queue: Queue<BackgroundTaskMessage> | undefined,
  messages: BackgroundTaskMessage[],
): Promise<void> {
  if (!queue) return
  try {
    for (const message of messages) await queue.send(message)
  } catch {
    // D1 中的权威待办仍会由定时任务重新唤醒。
  }
}

function appendSignature(
  body: string,
  bodyFormat: string,
  signatureFormat: string | null,
  signatureContent: string | null,
): string {
  if (!signatureContent) return body
  if (bodyFormat === 'rich_text') {
    const signature =
      signatureFormat === 'plain_text'
        ? escapeHtml(signatureContent).replace(/\r?\n/g, '<br>')
        : signatureContent
    return `${body}<br><br>--<br>${signature}`
  }
  const signature = signatureFormat === 'rich_text' ? stripHtml(signatureContent) : signatureContent
  return `${body}\n\n--\n${signature}`
}

function normalizeSubject(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/p\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&amp;/giu, '&')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function zonedMonthBounds(now: number, timezone: string): MonthBounds {
  let safeTimezone = timezone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: safeTimezone }).format(now)
  } catch {
    safeTimezone = 'UTC'
  }
  const parts = zonedParts(now, safeTimezone)
  const startAt = zonedLocalToEpoch(parts.year, parts.month, 1, safeTimezone)
  const nextMonth =
    parts.month === 12
      ? { year: parts.year + 1, month: 1 }
      : { year: parts.year, month: parts.month + 1 }
  const endAt = zonedLocalToEpoch(nextMonth.year, nextMonth.month, 1, safeTimezone)
  return { startAt, endAt, timezone: safeTimezone }
}

function zonedLocalToEpoch(year: number, month: number, day: number, timezone: string): number {
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0)
  let guess = desired
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(guess, timezone)
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    )
    guess += desired - actualAsUtc
  }
  return guess
}

function zonedParts(value: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour: number('hour'),
    minute: number('minute'),
    second: number('second'),
  }
}

function normalizeSendInput(draftId: string, input: SendDraftRequest) {
  if (!isUuid(draftId)) throw new SendInputError('draftId', '草稿编号无效')
  if (!isUuid(input.requestKey)) throw new SendInputError('requestKey', '发送编号无效')
  if (!Number.isInteger(input.expectedRevisionNumber) || input.expectedRevisionNumber < 1) {
    throw new SendInputError('expectedRevisionNumber', '草稿修订号无效')
  }
  return {
    draftId,
    requestKey: input.requestKey,
    expectedRevisionNumber: input.expectedRevisionNumber,
  }
}

function isReplyComposeKind(value: string): boolean {
  return value === 'reply' || value === 'reply_all'
}

function isMessageId(value: string | null): value is string {
  return value !== null && /^<[^<>\s]{1,996}>$/u.test(value)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
