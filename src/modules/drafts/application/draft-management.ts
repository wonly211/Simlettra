import type {
  DraftAttachment,
  DraftBodyFormat,
  DraftComposeKind,
  DraftDetail,
  DraftRecipient,
  DraftSenderAddress,
  DraftStatus,
  DraftSummary,
  SaveDraftRequest,
} from '../../../shared/contracts/drafts'
import type { StorageMode } from '../../../shared/contracts/storage-mode'
import {
  normalizeRecipientEmailAddress,
  AddressValidationError,
} from '../../addresses/domain/email-address'
import {
  getMailboxDraftSource,
  MailboxAccessError,
  type MailboxDraftSourceSnapshot,
} from '../../mailbox/public'
import { bytesToHex, equalBytes, sha256Bytes } from '../../mail-receiving/domain/content-digest'
import type { MailObjectStore } from '../../mail-receiving/public'
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
  type LogicalStorageReservation,
} from '../../storage-quotas/public'

const MAX_DRAFT_BYTES = 20_000_000
const MAX_SUBJECT_LENGTH = 998
const MAX_RECIPIENTS = 100
const MAX_DISPLAY_NAME_LENGTH = 200
const MAX_FILE_NAME_LENGTH = 512
const DRAFT_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DRAFT_PRODUCER_VERSION = 'simlettra-draft-v1'

type DraftField =
  | 'draftId'
  | 'sourceMailboxEntryId'
  | 'senderAddressId'
  | 'subject'
  | 'bodyFormat'
  | 'body'
  | 'recipients'
  | 'attachmentIds'
  | 'mutationKey'
  | 'expectedRevisionNumber'
  | 'fileName'
  | 'file'

export class DraftInputError extends Error {
  constructor(
    readonly field: DraftField,
    message: string,
  ) {
    super(message)
  }
}

export class DraftAccessError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_active' | 'sender_unavailable' | 'source_unavailable',
    message: string,
  ) {
    super(message)
  }
}

export class DraftMutationConflictError extends Error {
  constructor(message = '相同变更编号不能用于不同的草稿内容') {
    super(message)
  }
}

interface DraftRow {
  id: string
  owner_user_id: string
  status: string
  sender_address_id: string | null
  compose_kind: string
  source_message_id: string | null
  source_reference: string | null
  conflict_parent_draft_id: string | null
  current_revision_number: number
  trash_due_at: number | null
  updated_at: number
  subject: string
  body_format: string
  body_content_generation: number
  content_digest: ArrayBuffer
  body_size_bytes: number
}

interface AttachmentRow {
  id: string
  draft_id: string
  revision_number: number
  sequence_number: number
  untrusted_file_name: string
  media_type: string
  size_bytes: number
  content_sha256: ArrayBuffer
  content_generation: number
  object_key: string
}

interface RecipientRow {
  recipient_role: string
  display_name: string | null
  address_text: string
  sequence_number: number
}

interface MutationRow {
  input_digest: ArrayBuffer
  result_kind: string
  result_draft_id: string
}

interface ObjectIntent {
  id: string
  key: string
  digest: Uint8Array
  generation: number
}

export async function listDraftWorkspace(options: {
  database: D1Database
  userId: string
  status?: string | null
}): Promise<{ drafts: DraftSummary[]; senderAddresses: DraftSenderAddress[] }> {
  const status = parseDraftStatus(options.status)
  const [rows, senderAddresses] = await Promise.all([
    options.database
      .prepare(
        `SELECT drafts.id, drafts.status, contents.subject,
                drafts.updated_at, drafts.current_revision_number,
                drafts.conflict_parent_draft_id,
                (SELECT COUNT(*) FROM draft_attachments attachment
                 WHERE attachment.draft_id = drafts.id) AS attachment_count,
                COALESCE((SELECT address_text FROM draft_recipients recipient
                 WHERE recipient.draft_id = drafts.id AND recipient.recipient_role = 'to'
                 ORDER BY recipient.sequence_number LIMIT 1), '') AS recipient_preview
         FROM drafts
         JOIN draft_contents contents ON contents.draft_id = drafts.id
         WHERE drafts.owner_user_id = ?1 AND drafts.status = ?2
         ORDER BY drafts.updated_at DESC, drafts.id DESC
         LIMIT 200`,
      )
      .bind(options.userId, status)
      .all<{
        id: string
        status: string
        subject: string
        updated_at: number
        current_revision_number: number
        conflict_parent_draft_id: string | null
        attachment_count: number
        recipient_preview: string
      }>(),
    listAvailableSenderAddresses(options.database, options.userId),
  ])

  return {
    drafts: rows.results.map((row) => ({
      id: row.id,
      status: row.status as DraftStatus,
      subject: row.subject,
      recipientPreview: row.recipient_preview,
      updatedAt: row.updated_at,
      revisionNumber: row.current_revision_number,
      attachmentCount: row.attachment_count,
      conflictCopy: row.conflict_parent_draft_id !== null,
    })),
    senderAddresses,
  }
}

export async function createDraft(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  userId: string
  senderAddressId?: string | null
  composeKind?: DraftComposeKind
  sourceMailboxEntryId?: string | null
  now?: number
}): Promise<DraftDetail> {
  const now = options.now ?? Date.now()
  const draftId = crypto.randomUUID()
  const composeKind = parseComposeKind(options.composeKind)
  const senders = await listAvailableSenderAddresses(options.database, options.userId)
  const source = await prepareDraftSource({
    database: options.database,
    objectStore: options.objectStore,
    userId: options.userId,
    composeKind,
    ...(options.sourceMailboxEntryId !== undefined
      ? { sourceMailboxEntryId: options.sourceMailboxEntryId }
      : {}),
    now,
  })
  const requestedSenderId = options.senderAddressId ?? selectSourceSender(source, senders)
  const senderAddressId =
    requestedSenderId ?? senders.find((sender) => sender.isDefault)?.id ?? senders[0]?.id ?? null
  if (
    senderAddressId &&
    !senders.some((sender) => sender.id === senderAddressId && sender.canSend)
  ) {
    throw new DraftAccessError('sender_unavailable', '当前不能使用这个发件地址')
  }

  const initial = await prepareInitialDraft(source, composeKind, senders, senderAddressId)
  ensureDraftSize(
    initial.body,
    initial.attachments.map((attachment) => ({ sizeBytes: attachment.bytes.byteLength })),
  )
  const body = new TextEncoder().encode(initial.body)
  const logicalBytes =
    body.byteLength +
    initial.attachments.reduce((sum, attachment) => sum + attachment.bytes.byteLength, 0)
  let logicalReservation: LogicalStorageReservation | null
  try {
    logicalReservation = await reserveLogicalStorage({
      database: options.database,
      storageMode: options.storageMode,
      owner: { ownerType: 'user', ownerId: options.userId },
      operationKind: 'draft',
      operationReference: `draft-create:${draftId}`,
      bytes: logicalBytes,
      now,
    })
  } catch (error) {
    if (error instanceof LogicalStorageCapacityError) {
      throw new DraftInputError('body', '个人存储配额不足，暂时不能建立这份草稿')
    }
    throw error
  }
  const inputDigest = await digestDraftInput({
    senderAddressId,
    subject: initial.subject,
    bodyFormat: 'rich_text',
    body: initial.body,
    recipients: initial.recipients,
    attachmentIds: initial.attachments.map((attachment) => attachment.id),
  })
  let bodyObject: ObjectIntent
  try {
    bodyObject = await storeDraftObject({
      database: options.database,
      store: options.objectStore,
      storageMode: options.storageMode,
      draftId,
      role: 'draft_body',
      logicalPartKey: 'body',
      generation: 1,
      bytes: body,
      mediaType: 'text/html; charset=utf-8',
      fileName: null,
      sequenceNumber: 0,
      now,
    })
    const attachmentObjects: Array<{
      id: string
      fileName: string
      mediaType: string
      bytes: ArrayBuffer
      digest: Uint8Array
      object: ObjectIntent
    }> = []
    for (const [index, attachment] of initial.attachments.entries()) {
      const bytes = new Uint8Array(attachment.bytes)
      attachmentObjects.push({
        ...attachment,
        digest: await sha256Bytes(bytes),
        object: await storeDraftObject({
          database: options.database,
          store: options.objectStore,
          storageMode: options.storageMode,
          draftId,
          role: 'draft_attachment',
          logicalPartKey: attachment.id,
          generation: 1,
          bytes,
          mediaType: attachment.mediaType,
          fileName: attachment.fileName,
          sequenceNumber: index,
          now,
        }),
      })
    }

    const logicalStatements = logicalReservation
      ? await logicalStorageCommitStatements({
          database: options.database,
          reservation: logicalReservation,
          entryKind: 'draft',
          ownerReference: `draft:${draftId}`,
          now,
        })
      : []

    await options.database.batch([
      options.database
        .prepare(
          `INSERT INTO drafts (
           id, owner_user_id, status, sender_address_id, compose_kind,
           source_message_id, source_reference, conflict_parent_draft_id,
           current_revision_number, trashed_at, trash_due_at, consumed_at,
           deleting_at, created_at, updated_at
         ) VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?6, NULL, 1,
                   NULL, NULL, NULL, NULL, ?7, ?7)`,
        )
        .bind(
          draftId,
          options.userId,
          senderAddressId,
          composeKind,
          source?.messageId ?? null,
          source ? `message:${source.messageId}` : null,
          now,
        ),
      activateObjectStatement(options.database, bodyObject.id, now),
      ...attachmentObjects.map((attachment) =>
        activateObjectStatement(options.database, attachment.object.id, now),
      ),
      options.database
        .prepare(
          `INSERT INTO draft_contents (
           draft_id, revision_number, subject, body_format,
           body_content_generation, content_digest, updated_at
         ) VALUES (?1, 1, ?2, 'rich_text', 1, ?3, ?4)`,
        )
        .bind(draftId, initial.subject, inputDigest, now),
      ...recipientInsertStatements(options.database, draftId, 1, initial.recipients, now),
      ...attachmentObjects.map((attachment, index) =>
        options.database
          .prepare(
            `INSERT INTO draft_attachments (
             id, draft_id, revision_number, sequence_number, untrusted_file_name,
             media_type, size_bytes, content_sha256, content_generation,
             integrity_checked_at, created_at
           ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)`,
          )
          .bind(
            attachment.id,
            draftId,
            index,
            attachment.fileName,
            attachment.mediaType,
            attachment.bytes.byteLength,
            attachment.digest,
            now,
          ),
      ),
      ...logicalStatements,
    ])
  } catch (error) {
    await releaseLogicalStorageReservation({
      database: options.database,
      reservation: logicalReservation,
      now,
    })
    throw error
  }

  return getDraftDetail({
    database: options.database,
    objectStore: options.objectStore,
    userId: options.userId,
    draftId,
  })
}

export async function getDraftDetail(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  draftId: string
}): Promise<DraftDetail> {
  const row = await findOwnedDraft(options.database, options.userId, options.draftId)
  if (!row) throw new DraftAccessError('not_found', '草稿不存在')
  if (row.status !== 'active' && row.status !== 'trashed') {
    throw new DraftAccessError('not_found', '草稿不存在')
  }

  const [recipients, attachments, senders, bodyObject] = await Promise.all([
    listRecipients(options.database, row.id),
    listAttachments(options.database, row.id),
    listAvailableSenderAddresses(options.database, options.userId),
    options.database
      .prepare(
        `SELECT object_key FROM object_registry
         WHERE owner_kind = 'draft' AND owner_reference = ?1
           AND object_role = 'draft_body' AND logical_part_key = 'body'
           AND generation = ?2 AND object_status = 'active' AND is_current = 1
         LIMIT 1`,
      )
      .bind(row.id, row.body_content_generation)
      .first<{ object_key: string }>(),
  ])
  if (!bodyObject) throw new DraftAccessError('not_found', '草稿正文暂时不可用')
  const stored = await options.objectStore.get(bodyObject.object_key)
  if (!stored) throw new DraftAccessError('not_found', '草稿正文暂时不可用')

  return draftDetailFromParts(
    row,
    new TextDecoder().decode(stored.bytes),
    recipients,
    attachments,
    senders,
  )
}

export async function saveDraft(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  userId: string
  draftId: string
  input: SaveDraftRequest
  now?: number
}): Promise<{ outcome: 'updated' | 'conflict_copy'; draft: DraftDetail }> {
  const now = options.now ?? Date.now()
  const input = normalizeSaveInput(options.input)
  const current = await findOwnedDraft(options.database, options.userId, options.draftId)
  if (!current) throw new DraftAccessError('not_found', '草稿不存在')
  if (current.status !== 'active')
    throw new DraftAccessError('not_active', '只有草稿箱中的邮件可以编辑')

  await validateSenderSelection(options.database, options.userId, input.senderAddressId)
  const attachments = await listAttachments(options.database, current.id)
  ensureAttachmentSelection(input.attachmentIds, attachments)
  ensureDraftSize(
    input.body,
    attachments
      .filter((item) => input.attachmentIds.includes(item.id))
      .map((item) => ({ sizeBytes: item.size_bytes })),
  )

  const mutationKeyDigest = await sha256Bytes(input.mutationKey)
  const inputDigest = await digestDraftInput(input)
  const replay = await options.database
    .prepare(
      `SELECT input_digest, result_kind, result_draft_id
       FROM draft_mutation_keys WHERE draft_id = ?1 AND mutation_key_digest = ?2 LIMIT 1`,
    )
    .bind(current.id, mutationKeyDigest)
    .first<MutationRow>()
  if (replay) {
    if (!equalBytes(replay.input_digest, inputDigest)) throw new DraftMutationConflictError()
    return {
      outcome: replay.result_kind as 'updated' | 'conflict_copy',
      draft: await getDraftDetail({
        database: options.database,
        objectStore: options.objectStore,
        userId: options.userId,
        draftId: replay.result_draft_id,
      }),
    }
  }

  if (input.expectedRevisionNumber === current.current_revision_number) {
    return saveCurrentRevision({
      ...options,
      input,
      current,
      attachments,
      inputDigest,
      mutationKeyDigest,
      now,
    })
  }

  if (equalBytes(current.content_digest, inputDigest)) {
    await options.database
      .prepare(
        `INSERT INTO draft_mutation_keys (
           draft_id, mutation_key_digest, input_digest, expected_revision_number,
           result_kind, result_draft_id, result_revision_number, created_at
         ) VALUES (?1, ?2, ?3, ?4, 'updated', ?1, ?5, ?6)`,
      )
      .bind(
        current.id,
        mutationKeyDigest,
        inputDigest,
        input.expectedRevisionNumber,
        current.current_revision_number,
        now,
      )
      .run()
    return {
      outcome: 'updated',
      draft: await getDraftDetail({
        database: options.database,
        objectStore: options.objectStore,
        userId: options.userId,
        draftId: current.id,
      }),
    }
  }

  return saveConflictCopy({
    ...options,
    input,
    current,
    attachments,
    inputDigest,
    mutationKeyDigest,
    now,
  })
}

export async function uploadDraftAttachment(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  userId: string
  draftId: string
  mutationKey: string
  expectedRevisionNumber: number
  fileName: string
  mediaType: string
  bytes: ArrayBuffer
  now?: number
}): Promise<{ attachment: DraftAttachment; draft: DraftDetail }> {
  const now = options.now ?? Date.now()
  if (!isUuid(options.mutationKey)) throw new DraftInputError('mutationKey', '变更编号无效')
  if (!Number.isInteger(options.expectedRevisionNumber) || options.expectedRevisionNumber < 1) {
    throw new DraftInputError('expectedRevisionNumber', '草稿修订号无效')
  }
  const current = await findOwnedDraft(options.database, options.userId, options.draftId)
  if (!current) throw new DraftAccessError('not_found', '草稿不存在')
  if (current.status !== 'active')
    throw new DraftAccessError('not_active', '只有草稿箱中的邮件可以添加附件')
  const fileName = normalizeFileName(options.fileName)
  const mediaType = normalizeMediaType(options.mediaType)
  const mutationDigest = await sha256Bytes(options.mutationKey)
  const fileDigest = await sha256Bytes(options.bytes)
  const inputDigest = await sha256Bytes(
    `${options.expectedRevisionNumber}\n${fileName}\n${mediaType}\n${bytesToHex(fileDigest)}`,
  )
  const replay = await options.database
    .prepare(
      `SELECT input_digest, result_draft_id FROM draft_mutation_keys
       WHERE draft_id = ?1 AND mutation_key_digest = ?2 LIMIT 1`,
    )
    .bind(current.id, mutationDigest)
    .first<MutationRow>()
  if (replay) {
    if (!equalBytes(replay.input_digest, inputDigest)) throw new DraftMutationConflictError()
    const draft = await getDraftDetail({ ...options, draftId: replay.result_draft_id })
    const attachment = draft.attachments.find(
      (item) => item.fileName === fileName && item.sizeBytes === options.bytes.byteLength,
    )
    if (!attachment) throw new DraftMutationConflictError('附件重放结果不存在')
    return { attachment, draft }
  }
  if (options.expectedRevisionNumber !== current.current_revision_number) {
    throw new DraftInputError('expectedRevisionNumber', '草稿已在其他页面更新，请先载入最新内容')
  }
  const attachments = await listAttachments(options.database, current.id)
  const [recipients, body] = await Promise.all([
    listRecipients(options.database, current.id),
    readCurrentBody(options.database, options.objectStore, current),
  ])
  ensureDraftSize('', [
    ...attachments.map((item) => ({ sizeBytes: item.size_bytes })),
    { sizeBytes: options.bytes.byteLength },
  ])
  const currentBodyBytes = new TextEncoder().encode(body).byteLength
  if (
    currentBodyBytes +
      attachments.reduce((sum, item) => sum + item.size_bytes, 0) +
      options.bytes.byteLength >
    MAX_DRAFT_BYTES
  ) {
    throw new DraftInputError('file', '正文和附件合计不能超过 20 MB')
  }

  const attachmentId = crypto.randomUUID()
  let logicalReservation: LogicalStorageReservation | null
  try {
    logicalReservation = await reserveLogicalStorage({
      database: options.database,
      storageMode: options.storageMode,
      owner: { ownerType: 'user', ownerId: options.userId },
      operationKind: 'draft',
      operationReference: `draft-attachment:${current.id}:${options.mutationKey}`,
      bytes: options.bytes.byteLength,
      now,
    })
  } catch (error) {
    if (error instanceof LogicalStorageCapacityError) {
      throw new DraftInputError('file', '个人存储配额不足，暂时不能添加附件')
    }
    throw error
  }
  let reservation
  try {
    reservation = await reservePlatformCapacity({
      database: options.database,
      storageMode: options.storageMode,
      operationKind: 'draft_attachment',
      operationReference: `draft:${current.id}:${options.mutationKey}`,
      d1EstimatedBytes: 64_000,
      objectEstimatedBytes: options.bytes.byteLength,
      now,
    })
  } catch (error) {
    if (error instanceof PlatformCapacityUnavailableError) {
      await releaseLogicalStorageReservation({
        database: options.database,
        reservation: logicalReservation,
        now,
      })
      throw new DraftInputError('file', 'Cloudflare 免费存储容量不足，暂时不能添加附件')
    }
    throw error
  }
  let object: ObjectIntent
  try {
    object = await storeDraftObject({
      database: options.database,
      store: options.objectStore,
      storageMode: options.storageMode,
      draftId: current.id,
      role: 'draft_attachment',
      logicalPartKey: attachmentId,
      generation: 1,
      bytes: new Uint8Array(options.bytes),
      mediaType,
      fileName,
      sequenceNumber: attachments.length,
      now,
    })
  } catch (error) {
    await Promise.all([
      releasePlatformCapacityReservation({ database: options.database, reservation, now }),
      releaseLogicalStorageReservation({
        database: options.database,
        reservation: logicalReservation,
        now,
      }),
    ])
    throw error
  }
  await commitPlatformCapacityReservation({ database: options.database, reservation, now })
  const nextRevision = current.current_revision_number + 1
  const nextContentDigest = await digestDraftInput({
    senderAddressId: current.sender_address_id,
    subject: current.subject,
    bodyFormat: current.body_format as DraftBodyFormat,
    body,
    recipients,
    attachmentIds: [...attachments.map((item) => item.id), attachmentId],
  })
  try {
    const logicalStatements = logicalReservation
      ? await logicalStorageCommitStatements({
          database: options.database,
          reservation: logicalReservation,
          entryKind: 'draft',
          ownerReference: `draft:${current.id}`,
          now,
        })
      : []
    await options.database.batch([
      activateObjectStatement(options.database, object.id, now),
      options.database
        .prepare(
          `UPDATE draft_contents SET revision_number = ?1, content_digest = ?2, updated_at = ?3
           WHERE draft_id = ?4`,
        )
        .bind(nextRevision, nextContentDigest, now, current.id),
      options.database
        .prepare(`UPDATE draft_recipients SET revision_number = ?1 WHERE draft_id = ?2`)
        .bind(nextRevision, current.id),
      options.database
        .prepare(`UPDATE draft_attachments SET revision_number = ?1 WHERE draft_id = ?2`)
        .bind(nextRevision, current.id),
      options.database
        .prepare(
          `INSERT INTO draft_attachments (
             id, draft_id, revision_number, sequence_number, untrusted_file_name,
             media_type, size_bytes, content_sha256, content_generation,
             integrity_checked_at, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)`,
        )
        .bind(
          attachmentId,
          current.id,
          nextRevision,
          attachments.length,
          fileName,
          mediaType,
          options.bytes.byteLength,
          fileDigest,
          now,
        ),
      options.database
        .prepare(
          `UPDATE drafts SET current_revision_number = ?1, updated_at = ?2
           WHERE id = ?3 AND current_revision_number = ?4 AND status = 'active'`,
        )
        .bind(nextRevision, now, current.id, current.current_revision_number),
      options.database
        .prepare(
          `INSERT INTO draft_mutation_keys (
             draft_id, mutation_key_digest, input_digest, expected_revision_number,
             result_kind, result_draft_id, result_revision_number, created_at
           ) VALUES (?1, ?2, ?3, ?4, 'updated', ?1, ?5, ?6)`,
        )
        .bind(
          current.id,
          mutationDigest,
          inputDigest,
          current.current_revision_number,
          nextRevision,
          now,
        ),
      ...logicalStatements,
    ])
  } catch (error) {
    await releaseLogicalStorageReservation({
      database: options.database,
      reservation: logicalReservation,
      now,
    })
    throw error
  }
  const draft = await getDraftDetail({ ...options, draftId: current.id })
  const attachment = draft.attachments.find((item) => item.id === attachmentId)
  if (!attachment) throw new Error('草稿附件保存结果不存在')
  return { attachment, draft }
}

export async function getDraftAttachmentDownload(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  draftId: string
  attachmentId: string
}): Promise<{ bytes: ArrayBuffer; fileName: string; mediaType: string }> {
  const draft = await findOwnedDraft(options.database, options.userId, options.draftId)
  if (!draft || (draft.status !== 'active' && draft.status !== 'trashed')) {
    throw new DraftAccessError('not_found', '草稿不存在')
  }
  if (!isUuid(options.attachmentId)) throw new DraftAccessError('not_found', '附件不存在')
  const row = await options.database
    .prepare(
      `SELECT attachment.untrusted_file_name, attachment.media_type,
              attachment.size_bytes, attachment.content_sha256, object.object_key
       FROM draft_attachments attachment
       JOIN object_registry object
         ON object.owner_kind = 'draft' AND object.owner_reference = attachment.draft_id
        AND object.object_role = 'draft_attachment'
        AND object.logical_part_key = attachment.id
        AND object.generation = attachment.content_generation
        AND object.object_status = 'active' AND object.is_current = 1
       WHERE attachment.id = ?1 AND attachment.draft_id = ?2 LIMIT 1`,
    )
    .bind(options.attachmentId, draft.id)
    .first<{
      untrusted_file_name: string
      media_type: string
      size_bytes: number
      content_sha256: ArrayBuffer
      object_key: string
    }>()
  if (!row) throw new DraftAccessError('not_found', '附件不存在')
  const stored = await options.objectStore.get(row.object_key)
  if (!stored) throw new DraftAccessError('not_found', '附件暂时不可用')
  const digest = await sha256Bytes(stored.bytes)
  if (stored.bytes.byteLength !== row.size_bytes || !equalBytes(digest, row.content_sha256)) {
    throw new DraftAccessError('not_found', '附件完整性校验失败')
  }
  return { bytes: stored.bytes, fileName: row.untrusted_file_name, mediaType: row.media_type }
}

export async function changeDraftTrashStatus(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  draftId: string
  restore: boolean
  now?: number
}): Promise<DraftDetail> {
  const now = options.now ?? Date.now()
  const current = await findOwnedDraft(options.database, options.userId, options.draftId)
  if (!current) throw new DraftAccessError('not_found', '草稿不存在')
  if (options.restore && current.status !== 'trashed') {
    throw new DraftAccessError('not_active', '只有垃圾箱中的草稿可以恢复')
  }
  if (!options.restore && current.status !== 'active') {
    throw new DraftAccessError('not_active', '只有草稿箱中的邮件可以丢弃')
  }
  const result = await options.database
    .prepare(
      options.restore
        ? `UPDATE drafts SET status = 'active', trashed_at = NULL, trash_due_at = NULL, updated_at = ?1
           WHERE id = ?2 AND owner_user_id = ?3 AND status = 'trashed'`
        : `UPDATE drafts SET status = 'trashed', trashed_at = ?1,
              trash_due_at = ?4, updated_at = ?1
           WHERE id = ?2 AND owner_user_id = ?3 AND status = 'active'`,
    )
    .bind(
      ...(options.restore
        ? [now, current.id, options.userId]
        : [now, current.id, options.userId, now + DRAFT_TRASH_RETENTION_MS]),
    )
    .run()
  if ((result.meta.changes ?? 0) !== 1) throw new DraftAccessError('not_active', '草稿状态已经变化')
  return getDraftDetail({ ...options, draftId: current.id })
}

async function saveCurrentRevision(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  userId: string
  draftId: string
  input: NormalizedSaveInput
  current: DraftRow
  attachments: AttachmentRow[]
  inputDigest: Uint8Array
  mutationKeyDigest: Uint8Array
  now: number
}): Promise<{ outcome: 'updated'; draft: DraftDetail }> {
  const nextRevision = options.current.current_revision_number + 1
  const bodyGeneration = options.current.body_content_generation + 1
  const bodyBytes = new TextEncoder().encode(options.input.body)
  const removed = options.attachments.filter(
    (item) => !options.input.attachmentIds.includes(item.id),
  )
  const bytesDelta =
    bodyBytes.byteLength -
    options.current.body_size_bytes -
    removed.reduce((sum, item) => sum + item.size_bytes, 0)
  let logicalReservation: LogicalStorageReservation | null = null
  if (bytesDelta > 0) {
    try {
      logicalReservation = await reserveLogicalStorage({
        database: options.database,
        storageMode: options.storageMode,
        owner: { ownerType: 'user', ownerId: options.userId },
        operationKind: 'draft',
        operationReference: `draft-save:${options.current.id}:${options.input.mutationKey}`,
        bytes: bytesDelta,
        now: options.now,
      })
    } catch (error) {
      if (error instanceof LogicalStorageCapacityError) {
        throw new DraftInputError('body', '个人存储配额不足，暂时不能保存这次增长')
      }
      throw error
    }
  }
  let bodyObject: ObjectIntent
  try {
    bodyObject = await storeDraftObject({
      database: options.database,
      store: options.objectStore,
      storageMode: options.storageMode,
      draftId: options.current.id,
      role: 'draft_body',
      logicalPartKey: 'body',
      generation: bodyGeneration,
      bytes: bodyBytes,
      mediaType: bodyMediaType(options.input.bodyFormat),
      fileName: null,
      sequenceNumber: 0,
      now: options.now,
    })
  } catch (error) {
    await releaseLogicalStorageReservation({
      database: options.database,
      reservation: logicalReservation,
      now: options.now,
    })
    throw error
  }
  try {
    const usageStatement =
      bytesDelta < 0
        ? await logicalStorageAdjustmentStatement({
            database: options.database,
            storageMode: options.storageMode,
            owner: { ownerType: 'user', ownerId: options.userId },
            entryKind: 'draft',
            ownerReference: `draft:${options.current.id}`,
            bytesDelta,
            idempotencyKey: `draft-save:${options.current.id}:${options.input.mutationKey}`,
            now: options.now,
          })
        : null
    const logicalStatements = logicalReservation
      ? await logicalStorageCommitStatements({
          database: options.database,
          reservation: logicalReservation,
          entryKind: 'draft',
          ownerReference: `draft:${options.current.id}`,
          now: options.now,
        })
      : []
    const statements: D1PreparedStatement[] = [
      options.database
        .prepare(
          `UPDATE object_registry SET object_status = 'superseded', is_current = 0,
           superseded_at = ?1, updated_at = ?1
         WHERE owner_kind = 'draft' AND owner_reference = ?2
           AND object_role = 'draft_body' AND is_current = 1 AND object_status = 'active'`,
        )
        .bind(options.now, options.current.id),
      activateObjectStatement(options.database, bodyObject.id, options.now),
      ...removed.map((item) =>
        options.database
          .prepare(
            `UPDATE object_registry SET object_status = 'pending_delete', is_current = 0,
             delete_after = ?1, updated_at = ?1
           WHERE owner_kind = 'draft' AND owner_reference = ?2
             AND object_role = 'draft_attachment' AND logical_part_key = ?3
             AND is_current = 1 AND object_status = 'active'`,
          )
          .bind(options.now, options.current.id, item.id),
      ),
      ...removed.map((item) =>
        options.database
          .prepare(`DELETE FROM draft_attachments WHERE id = ?1 AND draft_id = ?2`)
          .bind(item.id, options.current.id),
      ),
      options.database
        .prepare(
          `UPDATE draft_contents SET revision_number = ?1, subject = ?2, body_format = ?3,
           body_content_generation = ?4, content_digest = ?5, updated_at = ?6
         WHERE draft_id = ?7 AND revision_number = ?8`,
        )
        .bind(
          nextRevision,
          options.input.subject,
          options.input.bodyFormat,
          bodyGeneration,
          options.inputDigest,
          options.now,
          options.current.id,
          options.current.current_revision_number,
        ),
    ]
    const draftUpdateIndex = statements.length - 1
    statements.push(
      options.database
        .prepare(`DELETE FROM draft_recipients WHERE draft_id = ?1`)
        .bind(options.current.id),
      ...recipientInsertStatements(
        options.database,
        options.current.id,
        nextRevision,
        options.input.recipients,
        options.now,
      ),
      options.database
        .prepare(`UPDATE draft_attachments SET revision_number = ?1 WHERE draft_id = ?2`)
        .bind(nextRevision, options.current.id),
      options.database
        .prepare(
          `UPDATE drafts SET sender_address_id = ?1, current_revision_number = ?2, updated_at = ?3
         WHERE id = ?4 AND owner_user_id = ?5 AND status = 'active' AND current_revision_number = ?6`,
        )
        .bind(
          options.input.senderAddressId,
          nextRevision,
          options.now,
          options.current.id,
          options.userId,
          options.current.current_revision_number,
        ),
      options.database
        .prepare(
          `INSERT INTO draft_mutation_keys (
           draft_id, mutation_key_digest, input_digest, expected_revision_number,
           result_kind, result_draft_id, result_revision_number, created_at
         ) VALUES (?1, ?2, ?3, ?4, 'updated', ?1, ?5, ?6)`,
        )
        .bind(
          options.current.id,
          options.mutationKeyDigest,
          options.inputDigest,
          options.current.current_revision_number,
          nextRevision,
          options.now,
        ),
      ...logicalStatements,
      ...(usageStatement ? [usageStatement] : []),
    )
    const results = await options.database.batch(statements)
    if ((results[draftUpdateIndex]?.meta.changes ?? 0) !== 1) {
      throw new DraftInputError('expectedRevisionNumber', '草稿已在其他页面更新，请载入冲突副本')
    }
  } catch (error) {
    await releaseLogicalStorageReservation({
      database: options.database,
      reservation: logicalReservation,
      now: options.now,
    })
    throw error
  }
  return {
    outcome: 'updated',
    draft: await getDraftDetail({
      database: options.database,
      objectStore: options.objectStore,
      userId: options.userId,
      draftId: options.current.id,
    }),
  }
}

async function saveConflictCopy(options: {
  database: D1Database
  objectStore: MailObjectStore
  storageMode: StorageMode
  userId: string
  draftId: string
  input: NormalizedSaveInput
  current: DraftRow
  attachments: AttachmentRow[]
  inputDigest: Uint8Array
  mutationKeyDigest: Uint8Array
  now: number
}): Promise<{ outcome: 'conflict_copy'; draft: DraftDetail }> {
  const conflictId = crypto.randomUUID()
  const bodyBytes = new TextEncoder().encode(options.input.body)
  const selected = options.attachments.filter((item) =>
    options.input.attachmentIds.includes(item.id),
  )
  let logicalReservation: LogicalStorageReservation | null
  try {
    logicalReservation = await reserveLogicalStorage({
      database: options.database,
      storageMode: options.storageMode,
      owner: { ownerType: 'user', ownerId: options.userId },
      operationKind: 'draft',
      operationReference: `draft-conflict:${options.current.id}:${options.input.mutationKey}`,
      bytes: bodyBytes.byteLength + selected.reduce((sum, item) => sum + item.size_bytes, 0),
      now: options.now,
    })
  } catch (error) {
    if (error instanceof LogicalStorageCapacityError) {
      throw new DraftInputError('body', '个人存储配额不足，暂时不能建立冲突副本')
    }
    throw error
  }
  try {
    const bodyObject = await storeDraftObject({
      database: options.database,
      store: options.objectStore,
      storageMode: options.storageMode,
      draftId: conflictId,
      role: 'draft_body',
      logicalPartKey: 'body',
      generation: 1,
      bytes: bodyBytes,
      mediaType: bodyMediaType(options.input.bodyFormat),
      fileName: null,
      sequenceNumber: 0,
      now: options.now,
    })
    const cloned: Array<{ source: AttachmentRow; id: string; object: ObjectIntent }> = []
    for (const [index, source] of selected.entries()) {
      const stored = await options.objectStore.get(source.object_key)
      if (!stored) throw new DraftAccessError('not_found', '草稿附件暂时不可用')
      const id = crypto.randomUUID()
      cloned.push({
        source,
        id,
        object: await storeDraftObject({
          database: options.database,
          store: options.objectStore,
          storageMode: options.storageMode,
          draftId: conflictId,
          role: 'draft_attachment',
          logicalPartKey: id,
          generation: 1,
          bytes: new Uint8Array(stored.bytes),
          mediaType: source.media_type,
          fileName: source.untrusted_file_name,
          sequenceNumber: index,
          now: options.now,
        }),
      })
    }
    const logicalStatements = logicalReservation
      ? await logicalStorageCommitStatements({
          database: options.database,
          reservation: logicalReservation,
          entryKind: 'draft',
          ownerReference: `draft:${conflictId}`,
          now: options.now,
        })
      : []
    const statements: D1PreparedStatement[] = [
      options.database
        .prepare(
          `INSERT INTO drafts (
           id, owner_user_id, status, sender_address_id, compose_kind,
           source_message_id, source_reference, conflict_parent_draft_id,
           current_revision_number, trashed_at, trash_due_at, consumed_at,
           deleting_at, created_at, updated_at
         ) VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?6, ?7, 1,
                   NULL, NULL, NULL, NULL, ?8, ?8)`,
        )
        .bind(
          conflictId,
          options.userId,
          options.input.senderAddressId,
          options.current.compose_kind,
          options.current.source_message_id,
          options.current.source_reference,
          options.current.id,
          options.now,
        ),
      activateObjectStatement(options.database, bodyObject.id, options.now),
      ...cloned.map((item) =>
        activateObjectStatement(options.database, item.object.id, options.now),
      ),
      options.database
        .prepare(
          `INSERT INTO draft_contents (
           draft_id, revision_number, subject, body_format,
           body_content_generation, content_digest, updated_at
         ) VALUES (?1, 1, ?2, ?3, 1, ?4, ?5)`,
        )
        .bind(
          conflictId,
          options.input.subject,
          options.input.bodyFormat,
          options.inputDigest,
          options.now,
        ),
      ...recipientInsertStatements(
        options.database,
        conflictId,
        1,
        options.input.recipients,
        options.now,
      ),
      ...cloned.map((item, index) =>
        options.database
          .prepare(
            `INSERT INTO draft_attachments (
             id, draft_id, revision_number, sequence_number, untrusted_file_name,
             media_type, size_bytes, content_sha256, content_generation,
             integrity_checked_at, created_at
           ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)`,
          )
          .bind(
            item.id,
            conflictId,
            index,
            item.source.untrusted_file_name,
            item.source.media_type,
            item.source.size_bytes,
            item.source.content_sha256,
            options.now,
          ),
      ),
      options.database
        .prepare(
          `INSERT INTO draft_mutation_keys (
           draft_id, mutation_key_digest, input_digest, expected_revision_number,
           result_kind, result_draft_id, result_revision_number, created_at
         ) VALUES (?1, ?2, ?3, ?4, 'conflict_copy', ?5, 1, ?6)`,
        )
        .bind(
          options.current.id,
          options.mutationKeyDigest,
          options.inputDigest,
          options.input.expectedRevisionNumber,
          conflictId,
          options.now,
        ),
      ...logicalStatements,
    ]
    await options.database.batch(statements)
  } catch (error) {
    await releaseLogicalStorageReservation({
      database: options.database,
      reservation: logicalReservation,
      now: options.now,
    })
    throw error
  }
  return {
    outcome: 'conflict_copy',
    draft: await getDraftDetail({
      database: options.database,
      objectStore: options.objectStore,
      userId: options.userId,
      draftId: conflictId,
    }),
  }
}

async function storeDraftObject(options: {
  database: D1Database
  store: MailObjectStore
  storageMode: StorageMode
  draftId: string
  role: 'draft_body' | 'draft_attachment'
  logicalPartKey: string
  generation: number
  bytes: Uint8Array
  mediaType: string
  fileName: string | null
  sequenceNumber: number
  now: number
}): Promise<ObjectIntent> {
  const id = crypto.randomUUID()
  const digest = await sha256Bytes(options.bytes)
  const key = `mail/drafts/${options.draftId}/${options.role}/${options.logicalPartKey}/v${options.generation}-${id}`
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
         ?1, ?2, ?3, 'draft', ?4, NULL, ?5, ?6, ?7, ?8,
         0, 0, ?9, ?10, NULL, NULL, ?11, ?12, ?13, NULL, ?14, NULL,
         'write_intent', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?15, ?15
       )`,
    )
    .bind(
      id,
      options.storageMode,
      key,
      options.draftId,
      options.role,
      options.logicalPartKey,
      options.sequenceNumber,
      options.generation,
      options.bytes.byteLength,
      digest,
      options.mediaType,
      options.fileName,
      options.role === 'draft_attachment' ? 'attachment' : null,
      DRAFT_PRODUCER_VERSION,
      options.now,
    )
    .run()

  const backendVersionReference = await options.store.put({
    key,
    bytes: options.bytes.buffer.slice(
      options.bytes.byteOffset,
      options.bytes.byteOffset + options.bytes.byteLength,
    ) as ArrayBuffer,
    mediaType: options.mediaType,
    sha256Hex: bytesToHex(digest),
  })
  const stored = await options.store.get(key)
  if (!stored) throw new Error('草稿对象写入后暂时不可读取')
  const storedDigest = await sha256Bytes(stored.bytes)
  if (stored.bytes.byteLength !== options.bytes.byteLength || !equalBytes(storedDigest, digest)) {
    throw new Error('草稿对象写入校验失败')
  }
  await options.database
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
  return { id, key, digest, generation: options.generation }
}

function activateObjectStatement(database: D1Database, objectId: string, now: number) {
  return database
    .prepare(
      `UPDATE object_registry SET object_status = 'active', is_current = 1,
         activated_at = ?1, updated_at = ?1
       WHERE id = ?2 AND object_status = 'verified' AND is_current = 0`,
    )
    .bind(now, objectId)
}

async function findOwnedDraft(database: D1Database, userId: string, draftId: string) {
  if (!isUuid(draftId)) return null
  return database
    .prepare(
      `SELECT drafts.*, contents.subject, contents.body_format,
              contents.body_content_generation, contents.content_digest,
              body.expected_size_bytes AS body_size_bytes
       FROM drafts JOIN draft_contents contents ON contents.draft_id = drafts.id
       JOIN object_registry body
         ON body.owner_kind = 'draft' AND body.owner_reference = drafts.id
        AND body.object_role = 'draft_body' AND body.logical_part_key = 'body'
        AND body.generation = contents.body_content_generation
        AND body.object_status = 'active' AND body.is_current = 1
       WHERE drafts.id = ?1 AND drafts.owner_user_id = ?2 LIMIT 1`,
    )
    .bind(draftId, userId)
    .first<DraftRow>()
}

async function listRecipients(database: D1Database, draftId: string): Promise<DraftRecipient[]> {
  const result = await database
    .prepare(
      `SELECT recipient_role, display_name, address_text, sequence_number
       FROM draft_recipients WHERE draft_id = ?1
       ORDER BY CASE recipient_role WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END, sequence_number`,
    )
    .bind(draftId)
    .all<RecipientRow>()
  return result.results.map((row) => ({
    role: row.recipient_role as DraftRecipient['role'],
    displayName: row.display_name,
    address: row.address_text,
  }))
}

async function listAttachments(database: D1Database, draftId: string): Promise<AttachmentRow[]> {
  const result = await database
    .prepare(
      `SELECT attachment.*, object.object_key
       FROM draft_attachments attachment
       JOIN object_registry object
         ON object.owner_kind = 'draft' AND object.owner_reference = attachment.draft_id
        AND object.object_role = 'draft_attachment'
        AND object.logical_part_key = attachment.id
        AND object.generation = attachment.content_generation
        AND object.object_status = 'active' AND object.is_current = 1
       WHERE attachment.draft_id = ?1 ORDER BY attachment.sequence_number, attachment.id`,
    )
    .bind(draftId)
    .all<AttachmentRow>()
  return result.results
}

export async function listAvailableSenderAddresses(
  database: D1Database,
  userId: string,
): Promise<DraftSenderAddress[]> {
  const personal = await database
    .prepare(
      `SELECT address.id, address.canonical_address, preference.custom_label,
              preference.is_default_sender
       FROM address_bindings binding
       JOIN email_addresses address ON address.id = binding.address_id AND address.retired_at IS NULL
       JOIN address_claims claim ON claim.address_id = address.id AND claim.status = 'active'
       JOIN mail_domains domain ON domain.id = address.domain_id AND domain.status = 'active'
       LEFT JOIN user_address_preferences preference
         ON preference.user_id = ?1 AND preference.address_id = address.id
       WHERE binding.owner_type = 'user' AND binding.user_id = ?1 AND binding.ended_at IS NULL
       ORDER BY COALESCE(preference.is_default_sender, 0) DESC,
                COALESCE(preference.is_pinned, 0) DESC,
                COALESCE(preference.sort_order, 0), address.canonical_address`,
    )
    .bind(userId)
    .all<{
      id: string
      canonical_address: string
      custom_label: string | null
      is_default_sender: number | null
    }>()
  const organization = await database
    .prepare(
      `SELECT address.id, address.canonical_address, organization.name
       FROM organization_memberships membership
       JOIN organizations organization
         ON organization.id = membership.organization_id AND organization.status = 'active'
       JOIN address_bindings binding
         ON binding.owner_type = 'organization' AND binding.organization_id = organization.id
        AND binding.address_role = 'shared' AND binding.ended_at IS NULL
       JOIN email_addresses address ON address.id = binding.address_id AND address.retired_at IS NULL
       JOIN address_claims claim ON claim.address_id = address.id AND claim.status = 'active'
       JOIN mail_domains domain ON domain.id = address.domain_id AND domain.status = 'active'
       WHERE membership.user_id = ?1 AND membership.left_at IS NULL
         AND (organization.creator_user_id = ?1 OR organization.members_can_send = 1)
       ORDER BY organization.name, address.canonical_address`,
    )
    .bind(userId)
    .all<{ id: string; canonical_address: string; name: string }>()

  return [
    ...personal.results.map((row) => ({
      id: row.id,
      address: row.canonical_address,
      displayName: row.custom_label,
      ownerType: 'user' as const,
      organizationName: null,
      isDefault: row.is_default_sender === 1,
      canSend: true,
    })),
    ...organization.results.map((row) => ({
      id: row.id,
      address: row.canonical_address,
      displayName: row.name,
      ownerType: 'organization' as const,
      organizationName: row.name,
      isDefault: false,
      canSend: true,
    })),
  ]
}

async function validateSenderSelection(
  database: D1Database,
  userId: string,
  addressId: string | null,
) {
  if (addressId === null) return
  const senders = await listAvailableSenderAddresses(database, userId)
  if (!senders.some((sender) => sender.id === addressId && sender.canSend)) {
    throw new DraftAccessError('sender_unavailable', '当前不能使用这个发件地址')
  }
}

async function prepareDraftSource(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  composeKind: DraftComposeKind
  sourceMailboxEntryId?: string | null
  now: number
}): Promise<MailboxDraftSourceSnapshot | null> {
  if (options.composeKind === 'new') {
    if (options.sourceMailboxEntryId) {
      throw new DraftInputError('sourceMailboxEntryId', '新邮件不能指定来源邮件')
    }
    return null
  }
  if (!options.sourceMailboxEntryId || !isUuid(options.sourceMailboxEntryId)) {
    throw new DraftInputError('sourceMailboxEntryId', '回复或转发必须指定来源邮件')
  }
  try {
    return await getMailboxDraftSource({
      database: options.database,
      objectStore: options.objectStore,
      userId: options.userId,
      entryId: options.sourceMailboxEntryId,
      includeAttachments: options.composeKind === 'forward',
      now: options.now,
    })
  } catch (error) {
    if (error instanceof MailboxAccessError) {
      throw new DraftAccessError('source_unavailable', '来源邮件不存在、无权读取或内容暂时不可用')
    }
    throw error
  }
}

function selectSourceSender(
  source: MailboxDraftSourceSnapshot | null,
  senders: DraftSenderAddress[],
): string | null {
  if (!source) return null
  const deliveredTo = new Set(
    source.actualDeliveryAddresses.map((address) => address.trim().toLowerCase()),
  )
  return senders.find((sender) => deliveredTo.has(sender.address.toLowerCase()))?.id ?? null
}

async function prepareInitialDraft(
  source: MailboxDraftSourceSnapshot | null,
  composeKind: DraftComposeKind,
  senders: DraftSenderAddress[],
  senderAddressId: string | null,
): Promise<{
  subject: string
  body: string
  recipients: DraftRecipient[]
  attachments: Array<{ id: string; fileName: string; mediaType: string; bytes: ArrayBuffer }>
}> {
  if (!source) return { subject: '', body: '', recipients: [], attachments: [] }
  const sourceText =
    source.plainTextBody ?? (await extractVisibleTextFromHtml(source.untrustedHtmlBody ?? ''))
  const subject = prefixedSubject(source.subject, composeKind)
  const recipients = buildRelatedDraftRecipients(source, composeKind, senders, senderAddressId)
  const body = buildQuotedBody(source, sourceText, composeKind)
  const attachments =
    composeKind === 'forward'
      ? source.attachments.map((attachment) => ({ id: crypto.randomUUID(), ...attachment }))
      : []
  return { subject, body, recipients, attachments }
}

function buildRelatedDraftRecipients(
  source: MailboxDraftSourceSnapshot,
  composeKind: DraftComposeKind,
  senders: DraftSenderAddress[],
  senderAddressId: string | null,
): DraftRecipient[] {
  if (composeKind === 'forward' || composeKind === 'new') return []
  const replyTo = source.addresses.filter((address) => address.role === 'reply_to')
  const from = source.addresses.filter(
    (address) => address.role === 'from' || address.role === 'sender',
  )
  const replyTargets = replyTo.length > 0 ? replyTo : from.slice(0, 1)
  const excluded = new Set(
    senders
      .filter((sender) => sender.ownerType === 'user' || sender.id === senderAddressId)
      .map((sender) => sender.address.toLowerCase()),
  )
  const candidates: DraftRecipient[] = replyTargets.map((address) => ({
    role: 'to',
    displayName: address.displayName,
    address: address.address,
  }))
  if (composeKind === 'reply_all') {
    candidates.push(
      ...source.addresses
        .filter((address) => address.role === 'to' || address.role === 'cc')
        .map((address) => ({
          role: 'cc' as const,
          displayName: address.displayName,
          address: address.address,
        })),
    )
  }
  const seen = new Set<string>()
  const recipients: DraftRecipient[] = []
  for (const candidate of candidates) {
    try {
      const normalized = normalizeRecipientEmailAddress(candidate.address).canonicalAddress
      if (excluded.has(normalized) || seen.has(normalized)) continue
      seen.add(normalized)
      recipients.push({ ...candidate, address: normalized })
    } catch (error) {
      if (!(error instanceof AddressValidationError)) throw error
    }
  }
  return recipients
}

function prefixedSubject(subject: string, composeKind: DraftComposeKind): string {
  const trimmed = subject.trim()
  if (composeKind === 'reply' || composeKind === 'reply_all') {
    return (/^re\s*:/iu.test(trimmed) ? trimmed : `Re: ${trimmed}`).slice(0, MAX_SUBJECT_LENGTH)
  }
  if (composeKind === 'forward') {
    return (/^fwd?\s*:/iu.test(trimmed) ? trimmed : `Fwd: ${trimmed}`).slice(0, MAX_SUBJECT_LENGTH)
  }
  return trimmed.slice(0, MAX_SUBJECT_LENGTH)
}

function buildQuotedBody(
  source: MailboxDraftSourceSnapshot,
  sourceText: string,
  composeKind: DraftComposeKind,
): string {
  const sender = source.addresses.find(
    (address) => address.role === 'from' || address.role === 'sender',
  )
  const senderLabel = formatQuotedAddress(sender)
  const date = new Date(source.occurredAt).toISOString()
  const quoted = escapeHtml(sourceText.trim())
  if (composeKind === 'forward') {
    const to = source.addresses
      .filter((address) => address.role === 'to')
      .map(formatQuotedAddress)
      .join('、')
    const cc = source.addresses
      .filter((address) => address.role === 'cc')
      .map(formatQuotedAddress)
      .join('、')
    return `<p><br></p><p>---------- 转发邮件 ----------</p><p>发件人：${escapeHtml(senderLabel)}<br>日期：${escapeHtml(date)}<br>主题：${escapeHtml(source.subject || '（无主题）')}<br>收件人：${escapeHtml(to || '（无）')}${cc ? `<br>抄送：${escapeHtml(cc)}` : ''}</p><blockquote><pre>${quoted}</pre></blockquote>`
  }
  return `<p><br></p><p>在 ${escapeHtml(date)}，${escapeHtml(senderLabel)} 写道：</p><blockquote><pre>${quoted}</pre></blockquote>`
}

function formatQuotedAddress(
  address: MailboxDraftSourceSnapshot['addresses'][number] | undefined,
): string {
  if (!address) return '未知发件人'
  return address.displayName ? `${address.displayName} <${address.address}>` : address.address
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
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

interface NormalizedSaveInput extends Omit<SaveDraftRequest, 'recipients'> {
  recipients: DraftRecipient[]
}

function normalizeSaveInput(input: SaveDraftRequest): NormalizedSaveInput {
  if (!isUuid(input.mutationKey)) throw new DraftInputError('mutationKey', '变更编号无效')
  if (!Number.isInteger(input.expectedRevisionNumber) || input.expectedRevisionNumber < 1) {
    throw new DraftInputError('expectedRevisionNumber', '草稿修订号无效')
  }
  if (input.senderAddressId !== null && !isUuid(input.senderAddressId)) {
    throw new DraftInputError('senderAddressId', '发件地址无效')
  }
  if (typeof input.subject !== 'string' || input.subject.length > MAX_SUBJECT_LENGTH) {
    throw new DraftInputError('subject', '主题不能超过 998 个字符')
  }
  if (input.bodyFormat !== 'rich_text' && input.bodyFormat !== 'plain_text') {
    throw new DraftInputError('bodyFormat', '正文格式无效')
  }
  if (typeof input.body !== 'string') throw new DraftInputError('body', '正文格式无效')
  if (!Array.isArray(input.recipients) || input.recipients.length > MAX_RECIPIENTS) {
    throw new DraftInputError('recipients', '收件人、抄送和密送合计不能超过 100 个')
  }
  if (
    !Array.isArray(input.attachmentIds) ||
    new Set(input.attachmentIds).size !== input.attachmentIds.length
  ) {
    throw new DraftInputError('attachmentIds', '附件列表无效')
  }
  const recipients = input.recipients.map((recipient) => {
    if (recipient.role !== 'to' && recipient.role !== 'cc' && recipient.role !== 'bcc') {
      throw new DraftInputError('recipients', '收件人类型无效')
    }
    if (
      recipient.displayName !== null &&
      (typeof recipient.displayName !== 'string' ||
        recipient.displayName.length > MAX_DISPLAY_NAME_LENGTH)
    ) {
      throw new DraftInputError('recipients', '收件人显示名称过长')
    }
    try {
      return {
        role: recipient.role,
        displayName: recipient.displayName?.trim() || null,
        address: normalizeRecipientEmailAddress(recipient.address).canonicalAddress,
      }
    } catch (error) {
      if (error instanceof AddressValidationError)
        throw new DraftInputError('recipients', '请填写有效的收件人地址')
      throw error
    }
  })
  return { ...input, subject: input.subject.trimEnd(), recipients }
}

async function digestDraftInput(input: {
  senderAddressId: string | null
  subject: string
  bodyFormat: DraftBodyFormat
  body: string
  recipients: DraftRecipient[]
  attachmentIds: string[]
}) {
  return sha256Bytes(
    JSON.stringify({
      senderAddressId: input.senderAddressId,
      subject: input.subject,
      bodyFormat: input.bodyFormat,
      body: input.body,
      recipients: input.recipients,
      attachmentIds: input.attachmentIds,
    }),
  )
}

function ensureAttachmentSelection(ids: string[], attachments: AttachmentRow[]) {
  const available = new Set(attachments.map((item) => item.id))
  if (ids.some((id) => !isUuid(id) || !available.has(id))) {
    throw new DraftInputError('attachmentIds', '附件不属于当前草稿或已经移除')
  }
}

function ensureDraftSize(body: string, attachments: Array<{ sizeBytes: number }>) {
  const size =
    new TextEncoder().encode(body).byteLength +
    attachments.reduce((sum, item) => sum + item.sizeBytes, 0)
  if (size > MAX_DRAFT_BYTES) throw new DraftInputError('body', '正文和附件合计不能超过 20 MB')
}

async function readCurrentBody(
  database: D1Database,
  store: MailObjectStore,
  draft: DraftRow,
): Promise<string> {
  const row = await database
    .prepare(
      `SELECT object_key FROM object_registry
       WHERE owner_kind = 'draft' AND owner_reference = ?1
         AND object_role = 'draft_body' AND logical_part_key = 'body'
         AND generation = ?2 AND object_status = 'active' AND is_current = 1
       LIMIT 1`,
    )
    .bind(draft.id, draft.body_content_generation)
    .first<{ object_key: string }>()
  if (!row) throw new DraftAccessError('not_found', '草稿正文暂时不可用')
  const stored = await store.get(row.object_key)
  if (!stored) throw new DraftAccessError('not_found', '草稿正文暂时不可用')
  return new TextDecoder().decode(stored.bytes)
}

function recipientInsertStatements(
  database: D1Database,
  draftId: string,
  revision: number,
  recipients: DraftRecipient[],
  now: number,
) {
  const counts = { to: 0, cc: 0, bcc: 0 }
  return recipients.map((recipient) => {
    const sequence = counts[recipient.role]++
    return database
      .prepare(
        `INSERT INTO draft_recipients (
           id, draft_id, revision_number, recipient_role, sequence_number,
           display_name, address_text, canonical_address, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`,
      )
      .bind(
        crypto.randomUUID(),
        draftId,
        revision,
        recipient.role,
        sequence,
        recipient.displayName,
        recipient.address,
        now,
      )
  })
}

function draftDetailFromParts(
  row: DraftRow,
  body: string,
  recipients: DraftRecipient[],
  attachments: AttachmentRow[],
  senders: DraftSenderAddress[],
): DraftDetail {
  return {
    id: row.id,
    status: row.status as DraftStatus,
    subject: row.subject,
    recipientPreview: recipients.find((item) => item.role === 'to')?.address ?? '',
    updatedAt: row.updated_at,
    revisionNumber: row.current_revision_number,
    attachmentCount: attachments.length,
    conflictCopy: row.conflict_parent_draft_id !== null,
    senderAddressId: row.sender_address_id,
    senderAvailable:
      row.sender_address_id === null ||
      senders.some((sender) => sender.id === row.sender_address_id),
    composeKind: row.compose_kind as DraftComposeKind,
    sourceMessageId: row.source_message_id,
    bodyFormat: row.body_format as DraftBodyFormat,
    body,
    recipients,
    attachments: attachments.map((item) => ({
      id: item.id,
      fileName: item.untrusted_file_name,
      mediaType: item.media_type,
      sizeBytes: item.size_bytes,
    })),
    trashDueAt: row.trash_due_at,
  }
}

function parseDraftStatus(value?: string | null): DraftStatus {
  if (!value || value === 'active') return 'active'
  if (value === 'trashed') return 'trashed'
  throw new DraftInputError('draftId', '草稿列表状态无效')
}

function parseComposeKind(value?: DraftComposeKind): DraftComposeKind {
  if (!value) return 'new'
  if (value === 'new' || value === 'reply' || value === 'reply_all' || value === 'forward')
    return value
  throw new DraftInputError('draftId', '写信类型无效')
}

function normalizeFileName(value: string): string {
  const normalized = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && codePoint !== 127
    })
    .join('')
    .trim()
  if (!normalized || normalized.length > MAX_FILE_NAME_LENGTH) {
    throw new DraftInputError('fileName', '附件名称必须为 1 至 512 个字符')
  }
  return normalized
}

function normalizeMediaType(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (
    !normalized ||
    normalized.length > 255 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
  ) {
    return 'application/octet-stream'
  }
  return normalized
}

function bodyMediaType(format: DraftBodyFormat): string {
  return format === 'rich_text' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
