import type {
  MailboxAttachment,
  MailboxConversationSummary,
  MailboxHeaderAddress,
  MailboxListItem,
  MailboxLocation,
  MailboxMessageDetail,
  MailboxOrganizeAction,
  MailboxOrganizationScope,
  MailboxSearchIndexState,
  MailboxScope,
  MailboxSort,
  MailboxView,
  RemoteImagePermissionMode,
} from '../../../shared/contracts/mailbox'
import { BodySearchInputError, prepareBodySearchPlan } from '../../mail-search/public'
import { bytesToHex, sha256Bytes } from '../../mail-receiving/domain/content-digest'
import type { MailObjectStore } from '../../mail-receiving/infrastructure/object-storage'
import { listSentEntrySenderAddresses } from '../../sending/public'

const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 50
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SAFE_PREVIEW_MEDIA_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])

interface MailboxListRow {
  entry_id: string
  message_id: string
  entry_kind: string
  base_location: string
  mailbox_type: string
  organization_id: string | null
  organization_name: string | null
  subject: string
  occurred_at: number
  attachment_count: number
  has_attachments: number
  sender_display_name: string | null
  sender_address_text: string | null
  state_is_read: number | null
  state_is_starred: number | null
  state_is_archived: number | null
  state_location_override: string | null
  state_trash_due_at: number | null
  membership_joined_at: number | null
  sort_value: number
  conversation_message_count: number
  conversation_unread_count: number
}

interface MailboxAccessRow extends MailboxListRow {
  header_date_text: string | null
  header_date_at: number | null
  accepted_at: number
  authored_by_user_id: string | null
  state_remote_images_allowed: number | null
  state_previous_location: string | null
  state_trashed_at: number | null
  state_hidden_at: number | null
  sender_canonical_address: string | null
  sender_trusted: number
  organization_creator_user_id: string | null
}

interface MailboxOrganizeRow {
  entry_id: string
  entry_kind: string
  base_location: string
  occurred_at: number
  mailbox_type: string
  organization_id: string | null
  state_is_read: number | null
  state_is_starred: number | null
  state_is_archived: number | null
  state_location_override: string | null
  state_previous_location: string | null
  state_remote_images_allowed: number | null
  state_trashed_at: number | null
  state_trash_due_at: number | null
  state_hidden_at: number | null
  membership_joined_at: number | null
}

interface HeaderAddressRow {
  address_role: string
  display_name: string | null
  address_text: string
}

interface DeliveryAddressRow {
  mailbox_entry_id: string
  display_recipient_address: string
}

interface MessageObjectRow {
  id: string
  object_key: string
  object_role: string
  sequence_number: number
  expected_size_bytes: number
  actual_size_bytes: number | null
  verified_sha256: string
  media_type: string
  untrusted_file_name: string | null
  content_disposition: string | null
}

export interface MailboxDraftSourceAttachment {
  fileName: string
  mediaType: string
  bytes: ArrayBuffer
}

export interface MailboxDraftSourceSnapshot {
  mailboxEntryId: string
  messageId: string
  mailboxType: 'user' | 'organization'
  subject: string
  occurredAt: number
  addresses: MailboxHeaderAddress[]
  actualDeliveryAddresses: string[]
  plainTextBody: string | null
  untrustedHtmlBody: string | null
  attachments: MailboxDraftSourceAttachment[]
}

interface OrganizationScopeRow {
  id: string
  name: string
}

interface ConversationSummaryRow {
  entry_id: string
  message_id: string
  entry_kind: string
  mailbox_type: string
  subject: string
  occurred_at: number
  attachment_count: number
  has_attachments: number
  sender_display_name: string | null
  sender_address_text: string | null
  state_is_read: number | null
  membership_joined_at: number | null
}

interface ParsedCursor {
  sort: MailboxSort
  sortValue: number
  occurredAt: number
  entryId: string
}

export interface MailboxListResult {
  items: MailboxListItem[]
  organizations: MailboxOrganizationScope[]
  nextCursor: string | null
  searchIndex: MailboxSearchIndexState | null
}

export interface AttachmentDownload {
  bytes: ArrayBuffer
  fileName: string
  mediaType: string
  previewable: boolean
}

export class MailboxInputError extends Error {
  constructor(
    readonly field:
      | 'scope'
      | 'view'
      | 'organizationId'
      | 'cursor'
      | 'limit'
      | 'isRead'
      | 'mode'
      | 'action'
      | 'entryIds'
      | 'body'
      | 'subject'
      | 'sender'
      | 'recipient'
      | 'mailboxAddress'
      | 'dateFrom'
      | 'dateTo'
      | 'attachment'
      | 'read'
      | 'starred'
      | 'archived'
      | 'sort',
    message: string,
  ) {
    super(message)
  }
}

export class MailboxAccessError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'object_unavailable'
      | 'sender_unavailable'
      | 'invalid_transition'
      | 'permission_denied',
    message: string,
  ) {
    super(message)
  }
}

export async function listInbox(options: {
  database: D1Database
  userId: string
  scope?: string | null | undefined
  view?: string | null | undefined
  organizationId?: string | null | undefined
  cursor?: string | null | undefined
  limit?: string | number | null | undefined
  body?: string | null | undefined
  subject?: string | null | undefined
  sender?: string | null | undefined
  recipient?: string | null | undefined
  mailboxAddress?: string | null | undefined
  dateFrom?: string | number | null | undefined
  dateTo?: string | number | null | undefined
  attachment?: string | null | undefined
  read?: string | null | undefined
  starred?: string | null | undefined
  archived?: string | null | undefined
  sort?: string | null | undefined
  now?: number
}): Promise<MailboxListResult> {
  const scope = parseScope(options.scope)
  const view = parseView(options.view)
  const organizationId = parseOrganizationId(scope, options.organizationId)
  const sort = parseSort(options.sort)
  const cursor = parseCursor(options.cursor, sort)
  const limit = parseLimit(options.limit)
  const now = options.now ?? Date.now()
  const viewCondition = mailboxViewCondition(view)
  const body = parseOptionalSearchText('body', options.body, 200)
  const subject = parseOptionalSearchText('subject', options.subject, 320)
  const sender = parseOptionalSearchText('sender', options.sender, 320)
  const recipient = parseOptionalSearchText('recipient', options.recipient, 320)
  const mailboxAddress = parseOptionalSearchText('mailboxAddress', options.mailboxAddress, 320)
  const dateFrom = parseSearchTimestamp('dateFrom', options.dateFrom)
  const dateTo = parseSearchTimestamp('dateTo', options.dateTo)
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    throw new MailboxInputError('dateTo', '结束日期不能早于开始日期')
  }
  const attachment = parseSearchChoice('attachment', options.attachment, [
    'all',
    'with',
    'without',
  ] as const)
  const read = parseSearchChoice('read', options.read, ['all', 'read', 'unread'] as const)
  const starred = parseSearchChoice('starred', options.starred, [
    'all',
    'starred',
    'unstarred',
  ] as const)
  const archived = parseSearchChoice('archived', options.archived, [
    'all',
    'archived',
    'unarchived',
  ] as const)
  const organizations = await listOrganizationScopes(options.database, options.userId)
  let searchIndex: MailboxSearchIndexState | null = null
  let bodyMatchExpression: string | null = null
  if (body) {
    try {
      const plan = await prepareBodySearchPlan({
        database: options.database,
        userId: options.userId,
        scope,
        organizationId,
        body,
      })
      searchIndex = plan.indexState
      bodyMatchExpression = plan.matchExpression
    } catch (error) {
      if (error instanceof BodySearchInputError) {
        throw new MailboxInputError('body', error.message)
      }
      throw error
    }
  }
  if (searchIndex && searchIndex.status !== 'ready') {
    return { items: [], organizations, nextCursor: null, searchIndex }
  }

  const parameters: unknown[] = []
  const bind = (value: unknown): string => {
    parameters.push(value)
    return `?${parameters.length}`
  }
  const userParameter = bind(options.userId)
  const nowParameter = bind(now)
  const scopeParameter = bind(scope)
  const organizationParameter = bind(organizationId)
  const readExpression = resolvedReadSql()
  const sortExpression = mailboxSortValueSql(sort, readExpression)
  const conditions = [
    viewCondition,
    `(state.location_override IS NULL
      OR state.location_override <> 'trash'
      OR state.trash_due_at IS NULL
      OR state.trash_due_at > ${nowParameter})`,
    `((entry.mailbox_type = 'user' AND entry.user_id = ${userParameter})
      OR (entry.mailbox_type = 'organization' AND membership.id IS NOT NULL
          AND organization.status = 'active'))`,
    `(${scopeParameter} = 'all'
      OR (${scopeParameter} = 'personal' AND entry.mailbox_type = 'user')
      OR (${scopeParameter} = 'organization' AND entry.mailbox_type = 'organization'
          AND entry.organization_id = ${organizationParameter}))`,
  ]
  if (subject) {
    conditions.push(`instr(lower(message.subject), lower(${bind(subject)})) > 0`)
  }
  if (sender) {
    const senderParameter = bind(sender)
    conditions.push(
      `EXISTS (
         SELECT 1 FROM message_header_addresses AS search_sender
         WHERE search_sender.message_id = message.id
           AND search_sender.address_role IN ('from', 'sender')
           AND instr(lower(COALESCE(search_sender.display_name, '') || ' ' ||
                           search_sender.address_text), lower(${senderParameter})) > 0
       )`,
    )
  }
  if (recipient) {
    const recipientParameter = bind(recipient)
    conditions.push(
      `EXISTS (
         SELECT 1 FROM message_header_addresses AS search_recipient
         WHERE search_recipient.message_id = message.id
           AND search_recipient.address_role IN ('to', 'cc', 'bcc')
           AND (search_recipient.visibility_scope = 'header'
                OR message.authored_by_user_id = ${userParameter})
           AND instr(lower(COALESCE(search_recipient.display_name, '') || ' ' ||
                           search_recipient.address_text), lower(${recipientParameter})) > 0
       )`,
    )
  }
  if (mailboxAddress) {
    const mailboxParameter = bind(mailboxAddress)
    conditions.push(
      `EXISTS (
         SELECT 1
         FROM mailbox_entry_deliveries AS search_relation
         JOIN message_deliveries AS search_delivery
           ON search_delivery.id = search_relation.delivery_id
         WHERE search_relation.mailbox_entry_id = entry.id
           AND instr(lower(search_delivery.display_recipient_address),
                     lower(${mailboxParameter})) > 0
       )`,
    )
  }
  if (dateFrom !== null) conditions.push(`entry.occurred_at >= ${bind(dateFrom)}`)
  if (dateTo !== null) conditions.push(`entry.occurred_at <= ${bind(dateTo)}`)
  if (attachment === 'with') conditions.push('message.has_attachments = 1')
  if (attachment === 'without') conditions.push('message.has_attachments = 0')
  if (read === 'read') conditions.push(`${readExpression} = 1`)
  if (read === 'unread') conditions.push(`${readExpression} = 0`)
  if (starred === 'starred') conditions.push('COALESCE(state.is_starred, 0) = 1')
  if (starred === 'unstarred') conditions.push('COALESCE(state.is_starred, 0) = 0')
  if (archived === 'archived') conditions.push('COALESCE(state.is_archived, 0) = 1')
  if (archived === 'unarchived') conditions.push('COALESCE(state.is_archived, 0) = 0')
  if (bodyMatchExpression) {
    conditions.push(
      `EXISTS (
         SELECT 1
         FROM message_search_index
         JOIN message_search_chunks AS search_chunk
           ON search_chunk.id = message_search_index.rowid
         WHERE search_chunk.message_id = message.id
           AND message_search_index MATCH ${bind(bodyMatchExpression)}
       )`,
    )
  }
  const cursorCondition = cursor ? mailboxResultCursorCondition(sort, cursor, bind) : '1 = 1'
  const orderBy = mailboxResultOrderBy(sort)
  const conversationSortExpression = conversationSortValueSql(sort)
  const limitParameter = bind(limit + 1)

  const rows = await options.database
    .prepare(
      `WITH filtered_mailbox AS (
         SELECT
           entry.id AS entry_id,
           entry.message_id,
           entry.entry_kind,
           entry.base_location,
           entry.mailbox_type,
           entry.organization_id,
           organization.name AS organization_name,
           message.subject,
           entry.occurred_at,
           message.attachment_count,
           message.has_attachments,
           sender.display_name AS sender_display_name,
           sender.address_text AS sender_address_text,
           state.is_read AS state_is_read,
           state.is_starred AS state_is_starred,
           state.is_archived AS state_is_archived,
           state.location_override AS state_location_override,
           state.trash_due_at AS state_trash_due_at,
           membership.joined_at AS membership_joined_at,
           ${readExpression} AS resolved_is_read,
           ${sortExpression} AS message_sort_value,
           COALESCE(conversation_member.conversation_id, 'entry:' || entry.id)
             AS conversation_key
         FROM mailbox_entries AS entry
         JOIN messages AS message ON message.id = entry.message_id
         JOIN message_integrity_states AS integrity
           ON integrity.message_id = message.id
          AND integrity.integrity_status = 'ready'
         LEFT JOIN organizations AS organization ON organization.id = entry.organization_id
         LEFT JOIN organization_memberships AS membership
           ON membership.organization_id = entry.organization_id
          AND membership.user_id = ${userParameter}
          AND membership.left_at IS NULL
         LEFT JOIN mailbox_user_states AS state
           ON state.mailbox_entry_id = entry.id
          AND state.user_id = ${userParameter}
         LEFT JOIN mailbox_conversation_entries AS conversation_member
           ON conversation_member.mailbox_entry_id = entry.id
         LEFT JOIN message_header_addresses AS sender
           ON sender.id = (
             SELECT address.id
             FROM message_header_addresses AS address
             WHERE address.message_id = message.id
               AND address.address_role IN ('from', 'sender')
             ORDER BY CASE address.address_role WHEN 'from' THEN 0 ELSE 1 END,
                      address.sequence_number,
                      address.id
             LIMIT 1
           )
         WHERE ${conditions.join('\n           AND ')}
       ), ranked_mailbox AS (
         SELECT
           filtered_mailbox.*,
           COUNT(*) OVER (PARTITION BY conversation_key) AS conversation_message_count,
           SUM(CASE WHEN resolved_is_read = 0 THEN 1 ELSE 0 END)
             OVER (PARTITION BY conversation_key) AS conversation_unread_count,
           ROW_NUMBER() OVER (
             PARTITION BY conversation_key ORDER BY occurred_at DESC, entry_id DESC
           ) AS conversation_rank,
           ${conversationSortExpression} AS conversation_sort_value
         FROM filtered_mailbox
       )
       SELECT
         entry_id, message_id, entry_kind, base_location, mailbox_type,
         organization_id, organization_name, subject, occurred_at,
         attachment_count, has_attachments, sender_display_name,
         sender_address_text, state_is_read, state_is_starred,
         state_is_archived, state_location_override, state_trash_due_at,
         membership_joined_at, conversation_sort_value AS sort_value,
         conversation_message_count, conversation_unread_count
       FROM ranked_mailbox
       WHERE conversation_rank = 1 AND ${cursorCondition}
       ORDER BY ${orderBy}
       LIMIT ${limitParameter}`,
    )
    .bind(...parameters)
    .all<MailboxListRow>()

  const pageRows = rows.results.slice(0, limit)
  const deliveryAddresses = await listDeliveryAddresses(
    options.database,
    pageRows.map((row) => row.entry_id),
  )
  const lastRow = pageRows.at(-1)

  return {
    items: pageRows.map((row) => mapListRow(row, deliveryAddresses.get(row.entry_id) ?? [])),
    organizations,
    searchIndex,
    nextCursor:
      rows.results.length > limit && lastRow
        ? encodeCursor({
            sort,
            sortValue: lastRow.sort_value,
            occurredAt: lastRow.occurred_at,
            entryId: lastRow.entry_id,
          })
        : null,
  }
}

export async function getMessageDetail(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  entryId: string
  now?: number
}): Promise<MailboxMessageDetail> {
  const access = await requireMailboxAccess(
    options.database,
    options.userId,
    options.entryId,
    options.now,
  )
  const [addresses, deliveryAddresses, objects] = await Promise.all([
    listHeaderAddresses(options.database, access.message_id, options.userId),
    listDeliveryAddresses(options.database, [options.entryId]),
    listMessageObjects(options.database, access.message_id),
  ])

  const plainObject = objects.find((object) => object.object_role === 'plain_body')
  const htmlObject = objects.find((object) => object.object_role === 'html_body')
  const [plainTextBody, untrustedHtmlBody] = await Promise.all([
    plainObject ? readTextObject(options.objectStore, plainObject) : Promise.resolve(null),
    htmlObject ? readTextObject(options.objectStore, htmlObject) : Promise.resolve(null),
  ])
  const permission = resolveRemoteImagePermission(access)

  return {
    id: access.entry_id,
    mailboxType: access.mailbox_type === 'organization' ? 'organization' : 'user',
    entryKind: access.entry_kind === 'sent' ? 'sent' : 'received',
    organization: mapOrganization(access),
    subject: access.subject,
    headerDateText: access.header_date_text,
    headerDateAt: access.header_date_at,
    acceptedAt: access.accepted_at,
    occurredAt: access.occurred_at,
    addresses,
    actualDeliveryAddresses: deliveryAddresses.get(options.entryId) ?? [],
    plainTextBody,
    untrustedHtmlBody,
    attachments: objects
      .filter(
        (object) => object.object_role === 'attachment' || object.object_role === 'inline_resource',
      )
      .map(mapAttachment),
    isRead: resolveIsRead(access),
    isStarred: access.state_is_starred === 1,
    isArchived: access.state_is_archived === 1,
    location: resolveLocation(access),
    trashDueAt: access.state_trash_due_at,
    remoteImagesAllowed: permission === 'message' || permission === 'sender',
    remoteImagePermission: permission,
    trustedSenderAddress: access.sender_trusted === 1 ? access.sender_canonical_address : null,
    canPermanentlyDelete:
      resolveLocation(access) === 'trash' &&
      (access.mailbox_type === 'user' || access.organization_creator_user_id === options.userId),
  }
}

export async function getMailboxDraftSource(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  entryId: string
  includeAttachments: boolean
  now?: number
}): Promise<MailboxDraftSourceSnapshot> {
  const access = await requireMailboxAccess(
    options.database,
    options.userId,
    options.entryId,
    options.now,
  )
  const [addresses, deliveryAddresses, objects] = await Promise.all([
    listHeaderAddresses(options.database, access.message_id, options.userId),
    listDeliveryAddresses(options.database, [options.entryId]),
    listMessageObjects(options.database, access.message_id),
  ])
  const plainObject = objects.find((object) => object.object_role === 'plain_body')
  const htmlObject = objects.find((object) => object.object_role === 'html_body')
  const attachments = options.includeAttachments
    ? objects.filter((object) => object.object_role === 'attachment')
    : []
  const [plainTextBody, untrustedHtmlBody, attachmentSnapshots] = await Promise.all([
    plainObject ? readTextObject(options.objectStore, plainObject) : Promise.resolve(null),
    htmlObject ? readTextObject(options.objectStore, htmlObject) : Promise.resolve(null),
    Promise.all(
      attachments.map(async (object) => ({
        fileName: safeDisplayFileName(object.untrusted_file_name, object.sequence_number),
        mediaType: object.media_type,
        bytes: await readVerifiedObject(options.objectStore, object, '附件暂时无法读取'),
      })),
    ),
  ])
  return {
    mailboxEntryId: access.entry_id,
    messageId: access.message_id,
    mailboxType: access.mailbox_type === 'organization' ? 'organization' : 'user',
    subject: access.subject,
    occurredAt: access.occurred_at,
    addresses,
    actualDeliveryAddresses: deliveryAddresses.get(options.entryId) ?? [],
    plainTextBody,
    untrustedHtmlBody,
    attachments: attachmentSnapshots,
  }
}

export async function getMessageConversation(options: {
  database: D1Database
  userId: string
  entryId: string
  now?: number
}): Promise<MailboxConversationSummary> {
  const now = options.now ?? Date.now()
  await requireMailboxAccess(options.database, options.userId, options.entryId, now)
  const membership = await options.database
    .prepare(
      `SELECT conversation_id
       FROM mailbox_conversation_entries
       WHERE mailbox_entry_id = ?1`,
    )
    .bind(options.entryId)
    .first<{ conversation_id: string }>()
  if (!membership) {
    const message = await readConversationEntry(
      options.database,
      options.userId,
      options.entryId,
      now,
    )
    return { entries: message ? [mapConversationEntry(message)] : [] }
  }

  const rows = await options.database
    .prepare(
      `SELECT
         entry.id AS entry_id,
         entry.message_id,
         entry.entry_kind,
         entry.mailbox_type,
         message.subject,
         entry.occurred_at,
         message.attachment_count,
         message.has_attachments,
         sender.display_name AS sender_display_name,
         sender.address_text AS sender_address_text,
         state.is_read AS state_is_read,
         organization_membership.joined_at AS membership_joined_at
       FROM mailbox_conversation_entries AS conversation_entry
       JOIN mailbox_entries AS entry ON entry.id = conversation_entry.mailbox_entry_id
       JOIN messages AS message ON message.id = entry.message_id
       JOIN message_integrity_states AS integrity
         ON integrity.message_id = message.id
        AND integrity.integrity_status = 'ready'
       LEFT JOIN organizations AS organization ON organization.id = entry.organization_id
       LEFT JOIN organization_memberships AS organization_membership
         ON organization_membership.organization_id = entry.organization_id
        AND organization_membership.user_id = ?1
        AND organization_membership.left_at IS NULL
       LEFT JOIN mailbox_user_states AS state
         ON state.mailbox_entry_id = entry.id
        AND state.user_id = ?1
       LEFT JOIN message_header_addresses AS sender
         ON sender.id = (
           SELECT address.id FROM message_header_addresses AS address
           WHERE address.message_id = message.id
             AND address.address_role IN ('from', 'sender')
           ORDER BY CASE address.address_role WHEN 'from' THEN 0 ELSE 1 END,
                    address.sequence_number, address.id
           LIMIT 1
         )
       WHERE conversation_entry.conversation_id = ?2
         AND COALESCE(state.location_override, entry.base_location) <> 'hidden'
         AND (
           state.location_override IS NULL
           OR state.location_override <> 'trash'
           OR state.trash_due_at IS NULL
           OR state.trash_due_at > ?3
         )
         AND (
           (entry.mailbox_type = 'user' AND entry.user_id = ?1)
           OR (entry.mailbox_type = 'organization'
               AND organization_membership.id IS NOT NULL
               AND organization.status = 'active')
         )
       ORDER BY entry.occurred_at, entry.id
       LIMIT 1001`,
    )
    .bind(options.userId, membership.conversation_id, now)
    .all<ConversationSummaryRow>()
  if (rows.results.length > 1_000) {
    throw new MailboxAccessError('object_unavailable', '会话邮件数量超过单次读取上限')
  }
  const physicalMessages = new Map<string, ConversationSummaryRow>()
  for (const row of rows.results) {
    const existing = physicalMessages.get(row.message_id)
    if (!existing || row.entry_id === options.entryId) physicalMessages.set(row.message_id, row)
  }
  return { entries: [...physicalMessages.values()].map(mapConversationEntry) }
}

async function readConversationEntry(
  database: D1Database,
  userId: string,
  entryId: string,
  now: number,
): Promise<ConversationSummaryRow | null> {
  return database
    .prepare(
      `SELECT
         entry.id AS entry_id,
         entry.message_id,
         entry.entry_kind,
         entry.mailbox_type,
         message.subject,
         entry.occurred_at,
         message.attachment_count,
         message.has_attachments,
         sender.display_name AS sender_display_name,
         sender.address_text AS sender_address_text,
         state.is_read AS state_is_read,
         membership.joined_at AS membership_joined_at
       FROM mailbox_entries AS entry
       JOIN messages AS message ON message.id = entry.message_id
       LEFT JOIN organization_memberships AS membership
         ON membership.organization_id = entry.organization_id
        AND membership.user_id = ?1
        AND membership.left_at IS NULL
       LEFT JOIN mailbox_user_states AS state
         ON state.mailbox_entry_id = entry.id AND state.user_id = ?1
       LEFT JOIN message_header_addresses AS sender
         ON sender.id = (
           SELECT address.id FROM message_header_addresses AS address
           WHERE address.message_id = message.id
             AND address.address_role IN ('from', 'sender')
           ORDER BY CASE address.address_role WHEN 'from' THEN 0 ELSE 1 END,
                    address.sequence_number, address.id
           LIMIT 1
         )
       WHERE entry.id = ?2
         AND COALESCE(state.location_override, entry.base_location) <> 'hidden'
         AND (state.trash_due_at IS NULL OR state.trash_due_at > ?3)
         AND (
           (entry.mailbox_type = 'user' AND entry.user_id = ?1)
           OR (entry.mailbox_type = 'organization' AND membership.id IS NOT NULL)
         )
       LIMIT 1`,
    )
    .bind(userId, entryId, now)
    .first<ConversationSummaryRow>()
}

export async function updateReadState(options: {
  database: D1Database
  userId: string
  entryId: string
  isRead: boolean
  now?: number
}): Promise<boolean> {
  const access = await requireMailboxAccess(
    options.database,
    options.userId,
    options.entryId,
    options.now,
  )
  const defaultIsRead = resolveDefaultIsRead(access)
  const value = options.isRead === defaultIsRead ? null : options.isRead ? 1 : 0
  await writeSparseMailboxState({
    database: options.database,
    userId: options.userId,
    entryId: options.entryId,
    field: 'is_read',
    value,
    now: options.now ?? Date.now(),
  })
  return options.isRead
}

export async function organizeMailboxEntries(options: {
  database: D1Database
  userId: string
  entryIds: unknown
  action: unknown
  now?: number
}): Promise<{ entryIds: string[]; action: MailboxOrganizeAction }> {
  const entryIds = parseEntryIds(options.entryIds)
  const action = parseOrganizeAction(options.action)
  const now = options.now ?? Date.now()
  const rows = await listOrganizeRows(options.database, options.userId, entryIds, now)
  if (rows.length !== entryIds.length) {
    throw new MailboxAccessError('not_found', '部分邮件不存在、已经到期或无权处理')
  }

  const rowsById = new Map(rows.map((row) => [row.entry_id, row]))
  const orderedRows = entryIds.map((entryId) => rowsById.get(entryId)!)
  for (const row of orderedRows) validateOrganizeTransition(row, action)

  const statements = orderedRows.flatMap((row) =>
    organizeStatements(options.database, options.userId, row, action, now),
  )
  await options.database.batch(statements)
  return { entryIds, action }
}

export async function updateRemoteImagePermission(options: {
  database: D1Database
  userId: string
  entryId: string
  mode: RemoteImagePermissionMode
  now?: number
}): Promise<{
  remoteImagesAllowed: boolean
  remoteImagePermission: MailboxMessageDetail['remoteImagePermission']
  trustedSenderAddress: string | null
}> {
  const access = await requireMailboxAccess(options.database, options.userId, options.entryId)
  const now = options.now ?? Date.now()
  const sender = access.sender_canonical_address

  if (options.mode === 'sender') {
    if (!sender) throw new MailboxAccessError('sender_unavailable', '这封邮件没有可识别的发件地址')
    await options.database.batch([
      options.database
        .prepare(
          `INSERT INTO trusted_sender_addresses (
             user_id, canonical_sender_address, display_sender_address, created_at
           ) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(user_id, canonical_sender_address) DO UPDATE SET
             display_sender_address = excluded.display_sender_address`,
        )
        .bind(options.userId, sender, access.sender_address_text ?? sender, now),
      ...clearSparseMailboxStateStatements(options.database, {
        userId: options.userId,
        entryId: options.entryId,
        field: 'remote_images_allowed',
        now,
      }),
    ])
    return {
      remoteImagesAllowed: true,
      remoteImagePermission: 'sender',
      trustedSenderAddress: sender,
    }
  }

  const value = options.mode === 'message' ? 1 : access.sender_trusted === 1 ? 0 : null
  await writeSparseMailboxState({
    database: options.database,
    userId: options.userId,
    entryId: options.entryId,
    field: 'remote_images_allowed',
    value,
    now,
  })
  return {
    remoteImagesAllowed: options.mode === 'message',
    remoteImagePermission:
      options.mode === 'message' ? 'message' : value === 0 ? 'blocked' : 'default',
    trustedSenderAddress: access.sender_trusted === 1 ? sender : null,
  }
}

export async function removeTrustedSender(options: {
  database: D1Database
  userId: string
  canonicalSenderAddress: string
}): Promise<void> {
  const address = options.canonicalSenderAddress.trim().toLowerCase()
  if (!address.includes('@') || address.length > 320) {
    throw new MailboxInputError('mode', '可信发件地址格式无效')
  }
  await options.database
    .prepare(
      `DELETE FROM trusted_sender_addresses
       WHERE user_id = ?1 AND canonical_sender_address = ?2`,
    )
    .bind(options.userId, address)
    .run()
}

export async function getAttachmentDownload(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  entryId: string
  objectId: string
}): Promise<AttachmentDownload> {
  const access = await requireMailboxAccess(options.database, options.userId, options.entryId)
  const object = await options.database
    .prepare(
      `SELECT
         id, object_key, object_role, sequence_number, expected_size_bytes,
         actual_size_bytes,
         hex(COALESCE(actual_sha256, expected_sha256)) AS verified_sha256,
         media_type, untrusted_file_name, content_disposition
       FROM object_registry
       WHERE id = ?1
         AND message_id = ?2
         AND object_role IN ('attachment', 'inline_resource')
         AND is_current = 1
         AND object_status = 'active'
       LIMIT 1`,
    )
    .bind(options.objectId, access.message_id)
    .first<MessageObjectRow>()
  if (!object) throw new MailboxAccessError('not_found', '附件不存在或无权访问')

  return {
    bytes: await readVerifiedObject(options.objectStore, object, '附件暂时无法读取'),
    fileName: safeDisplayFileName(object.untrusted_file_name, object.sequence_number),
    mediaType: object.media_type,
    previewable: SAFE_PREVIEW_MEDIA_TYPES.has(normalizeMediaType(object.media_type)),
  }
}

async function requireMailboxAccess(
  database: D1Database,
  userId: string,
  entryId: string,
  now = Date.now(),
): Promise<MailboxAccessRow> {
  const row = await database
    .prepare(
      `SELECT
         entry.id AS entry_id,
         entry.message_id,
         entry.entry_kind,
         entry.base_location,
         entry.mailbox_type,
         entry.organization_id,
         organization.name AS organization_name,
         organization.creator_user_id AS organization_creator_user_id,
         message.subject,
         message.header_date_text,
         message.header_date_at,
         message.accepted_at,
         message.authored_by_user_id,
         entry.occurred_at,
         message.attachment_count,
         message.has_attachments,
         sender.display_name AS sender_display_name,
         sender.address_text AS sender_address_text,
         sender.canonical_address AS sender_canonical_address,
         state.is_read AS state_is_read,
         state.is_starred AS state_is_starred,
         state.is_archived AS state_is_archived,
         state.location_override AS state_location_override,
         state.remote_images_allowed AS state_remote_images_allowed,
         state.previous_location AS state_previous_location,
         state.trashed_at AS state_trashed_at,
         state.trash_due_at AS state_trash_due_at,
         state.hidden_at AS state_hidden_at,
         membership.joined_at AS membership_joined_at,
         CASE WHEN trusted.canonical_sender_address IS NULL THEN 0 ELSE 1 END AS sender_trusted
       FROM mailbox_entries AS entry
       JOIN messages AS message ON message.id = entry.message_id
       JOIN message_integrity_states AS integrity
         ON integrity.message_id = message.id
        AND integrity.integrity_status = 'ready'
       LEFT JOIN organizations AS organization ON organization.id = entry.organization_id
       LEFT JOIN organization_memberships AS membership
         ON membership.organization_id = entry.organization_id
        AND membership.user_id = ?1
        AND membership.left_at IS NULL
       LEFT JOIN mailbox_user_states AS state
         ON state.mailbox_entry_id = entry.id
        AND state.user_id = ?1
       LEFT JOIN message_header_addresses AS sender
         ON sender.id = (
           SELECT address.id
           FROM message_header_addresses AS address
           WHERE address.message_id = message.id
             AND address.address_role IN ('from', 'sender')
           ORDER BY CASE address.address_role WHEN 'from' THEN 0 ELSE 1 END,
                    address.sequence_number,
                    address.id
           LIMIT 1
         )
       LEFT JOIN trusted_sender_addresses AS trusted
         ON trusted.user_id = ?1
        AND trusted.canonical_sender_address = sender.canonical_address
       WHERE entry.id = ?2
         AND COALESCE(state.location_override, entry.base_location) <> 'hidden'
         AND (
           state.location_override IS NULL
           OR state.location_override <> 'trash'
           OR state.trash_due_at IS NULL
           OR state.trash_due_at > ?3
         )
         AND (
           (entry.mailbox_type = 'user' AND entry.user_id = ?1)
           OR (
             entry.mailbox_type = 'organization'
             AND membership.id IS NOT NULL
             AND organization.status = 'active'
           )
         )
       LIMIT 1`,
    )
    .bind(userId, entryId, now)
    .first<MailboxAccessRow>()
  if (!row) throw new MailboxAccessError('not_found', '邮件不存在或无权访问')
  return row
}

async function listOrganizeRows(
  database: D1Database,
  userId: string,
  entryIds: string[],
  now: number,
): Promise<MailboxOrganizeRow[]> {
  const placeholders = entryIds.map((_, index) => `?${index + 3}`).join(', ')
  const result = await database
    .prepare(
      `SELECT
         entry.id AS entry_id,
         entry.entry_kind,
         entry.base_location,
         entry.occurred_at,
         entry.mailbox_type,
         entry.organization_id,
         state.is_read AS state_is_read,
         state.is_starred AS state_is_starred,
         state.is_archived AS state_is_archived,
         state.location_override AS state_location_override,
         state.previous_location AS state_previous_location,
         state.remote_images_allowed AS state_remote_images_allowed,
         state.trashed_at AS state_trashed_at,
         state.trash_due_at AS state_trash_due_at,
         state.hidden_at AS state_hidden_at,
         membership.joined_at AS membership_joined_at
       FROM mailbox_entries AS entry
       JOIN messages AS message ON message.id = entry.message_id
       JOIN message_integrity_states AS integrity
         ON integrity.message_id = message.id
        AND integrity.integrity_status = 'ready'
       LEFT JOIN organizations AS organization ON organization.id = entry.organization_id
       LEFT JOIN organization_memberships AS membership
         ON membership.organization_id = entry.organization_id
        AND membership.user_id = ?1
        AND membership.left_at IS NULL
       LEFT JOIN mailbox_user_states AS state
         ON state.mailbox_entry_id = entry.id
        AND state.user_id = ?1
       WHERE entry.id IN (${placeholders})
         AND COALESCE(state.location_override, entry.base_location) <> 'hidden'
         AND (
           state.location_override IS NULL
           OR state.location_override <> 'trash'
           OR state.trash_due_at IS NULL
           OR state.trash_due_at > ?2
         )
         AND (
           (entry.mailbox_type = 'user' AND entry.user_id = ?1)
           OR (
             entry.mailbox_type = 'organization'
             AND membership.id IS NOT NULL
             AND organization.status = 'active'
           )
         )`,
    )
    .bind(userId, now, ...entryIds)
    .all<MailboxOrganizeRow>()
  return result.results
}

function validateOrganizeTransition(row: MailboxOrganizeRow, action: MailboxOrganizeAction): void {
  const location = resolveLocation(row)
  if ((action === 'archive' || action === 'unarchive') && row.entry_kind !== 'received') {
    throw new MailboxAccessError('invalid_transition', '已发送邮件不能归档')
  }
  if ((action === 'archive' || action === 'unarchive') && location !== 'inbox') {
    throw new MailboxAccessError('invalid_transition', '只有收件箱中的邮件可以归档')
  }
  if ((action === 'mark_spam' || action === 'restore_from_spam') && row.entry_kind !== 'received') {
    throw new MailboxAccessError('invalid_transition', '已发送邮件不能标记为垃圾邮件')
  }
  if (action === 'mark_spam' && location !== 'inbox' && location !== 'spam') {
    throw new MailboxAccessError('invalid_transition', '只有收件箱中的邮件可以标记为垃圾邮件')
  }
  if (action === 'restore_from_spam' && location !== 'spam' && location !== 'inbox') {
    throw new MailboxAccessError('invalid_transition', '这封邮件不在垃圾邮件中')
  }
  if (action === 'restore_from_trash' && location !== 'trash') {
    throw new MailboxAccessError('invalid_transition', '这封邮件不在垃圾箱中')
  }
}

function organizeStatements(
  database: D1Database,
  userId: string,
  row: MailboxOrganizeRow,
  action: MailboxOrganizeAction,
  now: number,
): D1PreparedStatement[] {
  const common = { userId, entryId: row.entry_id, now }
  switch (action) {
    case 'mark_read':
    case 'mark_unread': {
      const isRead = action === 'mark_read'
      const value = isRead === resolveDefaultIsRead(row) ? null : isRead ? 1 : 0
      return sparseMailboxStateStatements(database, { ...common, field: 'is_read', value })
    }
    case 'star':
      return row.state_is_starred === 1
        ? []
        : sparseMailboxStateStatements(database, { ...common, field: 'is_starred', value: 1 })
    case 'unstar':
      return row.state_is_starred === 1
        ? sparseMailboxStateStatements(database, { ...common, field: 'is_starred', value: null })
        : []
    case 'archive':
      return row.state_is_archived === 1
        ? []
        : sparseMailboxStateStatements(database, { ...common, field: 'is_archived', value: 1 })
    case 'unarchive':
      return row.state_is_archived === 1
        ? sparseMailboxStateStatements(database, { ...common, field: 'is_archived', value: null })
        : []
    case 'move_to_trash': {
      const location = resolveLocation(row)
      if (location === 'trash') return []
      return [moveToTrashStatement(database, common, location, now + TRASH_RETENTION_MS)]
    }
    case 'restore_from_trash': {
      const previous = row.state_previous_location
      if (previous !== 'inbox' && previous !== 'sent' && previous !== 'spam') {
        throw new MailboxAccessError('invalid_transition', '垃圾箱原位置无效，无法恢复')
      }
      return setLocationStatements(
        database,
        common,
        previous === row.base_location ? null : previous,
      )
    }
    case 'mark_spam':
      return resolveLocation(row) === 'spam'
        ? []
        : setLocationStatements(database, common, row.base_location === 'spam' ? null : 'spam')
    case 'restore_from_spam':
      return resolveLocation(row) === 'inbox'
        ? []
        : setLocationStatements(database, common, row.base_location === 'inbox' ? null : 'inbox')
  }
}

function moveToTrashStatement(
  database: D1Database,
  common: { userId: string; entryId: string; now: number },
  previousLocation: MailboxLocation,
  dueAt: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO mailbox_user_states (
         mailbox_entry_id, user_id, location_override, previous_location,
         trashed_at, trash_due_at, updated_at
       ) VALUES (?1, ?2, 'trash', ?3, ?4, ?5, ?4)
       ON CONFLICT(mailbox_entry_id, user_id) DO UPDATE SET
         location_override = 'trash', previous_location = excluded.previous_location,
         trashed_at = excluded.trashed_at, trash_due_at = excluded.trash_due_at,
         hidden_at = NULL, updated_at = excluded.updated_at`,
    )
    .bind(common.entryId, common.userId, previousLocation, common.now, dueAt)
}

function setLocationStatements(
  database: D1Database,
  common: { userId: string; entryId: string; now: number },
  location: 'inbox' | 'sent' | 'spam' | null,
): D1PreparedStatement[] {
  if (location === null) {
    return clearLocationStateStatements(database, common)
  }
  return [
    database
      .prepare(
        `INSERT INTO mailbox_user_states (
           mailbox_entry_id, user_id, location_override, updated_at
         ) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(mailbox_entry_id, user_id) DO UPDATE SET
           location_override = excluded.location_override,
           previous_location = NULL, trashed_at = NULL, trash_due_at = NULL,
           hidden_at = NULL, updated_at = excluded.updated_at`,
      )
      .bind(common.entryId, common.userId, location, common.now),
  ]
}

function clearLocationStateStatements(
  database: D1Database,
  common: { userId: string; entryId: string; now: number },
): D1PreparedStatement[] {
  return [
    database
      .prepare(
        `DELETE FROM mailbox_user_states
         WHERE mailbox_entry_id = ?1 AND user_id = ?2
           AND is_read IS NULL AND is_starred IS NULL AND is_archived IS NULL
           AND remote_images_allowed IS NULL`,
      )
      .bind(common.entryId, common.userId),
    database
      .prepare(
        `UPDATE mailbox_user_states
         SET location_override = NULL, previous_location = NULL,
             trashed_at = NULL, trash_due_at = NULL, hidden_at = NULL, updated_at = ?3
         WHERE mailbox_entry_id = ?1 AND user_id = ?2`,
      )
      .bind(common.entryId, common.userId, common.now),
  ]
}

async function listHeaderAddresses(
  database: D1Database,
  messageId: string,
  userId: string,
): Promise<MailboxHeaderAddress[]> {
  const rows = await database
    .prepare(
      `SELECT address_role, display_name, address_text
       FROM message_header_addresses
       WHERE message_id = ?1
         AND (
           visibility_scope = 'header'
           OR EXISTS (
             SELECT 1 FROM messages
             WHERE messages.id = message_header_addresses.message_id
               AND messages.authored_by_user_id = ?2
           )
         )
       ORDER BY
         CASE address_role
           WHEN 'from' THEN 0 WHEN 'sender' THEN 1 WHEN 'reply_to' THEN 2
           WHEN 'to' THEN 3 WHEN 'cc' THEN 4 ELSE 5
         END,
         sequence_number,
         id`,
    )
    .bind(messageId, userId)
    .all<HeaderAddressRow>()
  return rows.results.filter(isMailboxHeaderAddressRole).map((row) => ({
    role: row.address_role,
    displayName: row.display_name,
    address: row.address_text,
  }))
}

async function listDeliveryAddresses(
  database: D1Database,
  entryIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (entryIds.length === 0) return result
  const sentEntryAddresses = await listSentEntrySenderAddresses(database, entryIds)
  const placeholders = entryIds.map((_, index) => `?${index + 1}`).join(', ')
  const [assignedRows, unallocatedRows] = await Promise.all([
    database
      .prepare(
        `SELECT relation.mailbox_entry_id, delivery.display_recipient_address
       FROM mailbox_entry_deliveries AS relation
       JOIN message_deliveries AS delivery ON delivery.id = relation.delivery_id
       WHERE relation.mailbox_entry_id IN (${placeholders})
       ORDER BY relation.mailbox_entry_id, delivery.delivered_at, delivery.id`,
      )
      .bind(...entryIds)
      .all<DeliveryAddressRow>(),
    database
      .prepare(
        `SELECT relation.mailbox_entry_id, delivery.display_recipient_address
         FROM mailbox_entry_unallocated_deliveries AS relation
         JOIN unallocated_message_deliveries AS delivery
           ON delivery.id = relation.unallocated_delivery_id
         WHERE relation.mailbox_entry_id IN (${placeholders})
         ORDER BY relation.mailbox_entry_id, delivery.delivered_at, delivery.id`,
      )
      .bind(...entryIds)
      .all<DeliveryAddressRow>(),
  ])
  for (const row of [...assignedRows.results, ...unallocatedRows.results]) {
    const addresses = result.get(row.mailbox_entry_id) ?? []
    if (!addresses.includes(row.display_recipient_address)) {
      addresses.push(row.display_recipient_address)
    }
    result.set(row.mailbox_entry_id, addresses)
  }
  for (const [entryId, address] of sentEntryAddresses) {
    if (!result.has(entryId)) result.set(entryId, [address])
  }
  return result
}

async function listMessageObjects(
  database: D1Database,
  messageId: string,
): Promise<MessageObjectRow[]> {
  const rows = await database
    .prepare(
      `SELECT
         id, object_key, object_role, sequence_number, expected_size_bytes,
         actual_size_bytes,
         hex(COALESCE(actual_sha256, expected_sha256)) AS verified_sha256,
         media_type, untrusted_file_name, content_disposition
       FROM object_registry
       WHERE message_id = ?1
         AND object_role IN ('plain_body', 'html_body', 'attachment', 'inline_resource')
         AND is_current = 1
         AND object_status = 'active'
       ORDER BY
         CASE object_role
           WHEN 'plain_body' THEN 0 WHEN 'html_body' THEN 1
           WHEN 'attachment' THEN 2 ELSE 3
         END,
         sequence_number,
         id`,
    )
    .bind(messageId)
    .all<MessageObjectRow>()
  return rows.results
}

async function listOrganizationScopes(
  database: D1Database,
  userId: string,
): Promise<MailboxOrganizationScope[]> {
  const rows = await database
    .prepare(
      `SELECT organization.id, organization.name
       FROM organization_memberships AS membership
       JOIN organizations AS organization ON organization.id = membership.organization_id
       WHERE membership.user_id = ?1
         AND membership.left_at IS NULL
         AND organization.status = 'active'
       ORDER BY membership.joined_at, membership.id`,
    )
    .bind(userId)
    .all<OrganizationScopeRow>()
  return rows.results
}

async function readTextObject(
  objectStore: MailObjectStore,
  object: MessageObjectRow,
): Promise<string> {
  return new TextDecoder().decode(
    await readVerifiedObject(objectStore, object, '邮件正文暂时无法读取'),
  )
}

async function readVerifiedObject(
  objectStore: MailObjectStore,
  object: MessageObjectRow,
  unavailableMessage: string,
): Promise<ArrayBuffer> {
  const stored = await objectStore.get(object.object_key)
  if (!stored) throw new MailboxAccessError('object_unavailable', unavailableMessage)
  const expectedSize = object.actual_size_bytes ?? object.expected_size_bytes
  const digest = await sha256Bytes(stored.bytes)
  if (
    stored.bytes.byteLength !== expectedSize ||
    bytesToHex(digest) !== object.verified_sha256.toLowerCase()
  ) {
    throw new MailboxAccessError('object_unavailable', unavailableMessage)
  }
  return stored.bytes
}

function mapListRow(row: MailboxListRow, deliveryAddresses: string[]): MailboxListItem {
  return {
    id: row.entry_id,
    mailboxType: row.mailbox_type === 'organization' ? 'organization' : 'user',
    entryKind: row.entry_kind === 'sent' ? 'sent' : 'received',
    organization: mapOrganization(row),
    subject: row.subject,
    sender: row.sender_address_text
      ? { displayName: row.sender_display_name, address: row.sender_address_text }
      : null,
    occurredAt: row.occurred_at,
    actualDeliveryAddresses: deliveryAddresses,
    isRead: resolveIsRead(row),
    isStarred: row.state_is_starred === 1,
    isArchived: row.state_is_archived === 1,
    location: resolveLocation(row),
    trashDueAt: row.state_trash_due_at,
    hasAttachments: row.has_attachments === 1,
    attachmentCount: row.attachment_count,
    conversationMessageCount: row.conversation_message_count,
    conversationUnreadCount: row.conversation_unread_count,
  }
}

function mapConversationEntry(
  row: ConversationSummaryRow,
): MailboxConversationSummary['entries'][number] {
  const isRead = row.state_is_read === null ? resolveDefaultIsRead(row) : row.state_is_read === 1
  return {
    id: row.entry_id,
    subject: row.subject,
    sender: row.sender_address_text
      ? { displayName: row.sender_display_name, address: row.sender_address_text }
      : null,
    occurredAt: row.occurred_at,
    isRead,
    hasAttachments: row.has_attachments === 1,
    attachmentCount: row.attachment_count,
  }
}

function mapOrganization(
  row: Pick<MailboxListRow, 'organization_id' | 'organization_name'>,
): MailboxOrganizationScope | null {
  return row.organization_id && row.organization_name
    ? { id: row.organization_id, name: row.organization_name }
    : null
}

function mapAttachment(object: MessageObjectRow): MailboxAttachment {
  return {
    id: object.id,
    fileName: safeDisplayFileName(object.untrusted_file_name, object.sequence_number),
    mediaType: object.media_type,
    sizeBytes: object.actual_size_bytes ?? object.expected_size_bytes,
    inline: object.object_role === 'inline_resource',
    previewable: SAFE_PREVIEW_MEDIA_TYPES.has(normalizeMediaType(object.media_type)),
  }
}

function resolveDefaultIsRead(
  row: Pick<MailboxListRow, 'entry_kind' | 'mailbox_type' | 'membership_joined_at' | 'occurred_at'>,
): boolean {
  if (row.entry_kind === 'sent') return true
  return (
    row.mailbox_type === 'organization' &&
    row.membership_joined_at !== null &&
    row.occurred_at < row.membership_joined_at
  )
}

function resolveLocation(
  row: Pick<MailboxListRow, 'state_location_override' | 'base_location'>,
): MailboxLocation {
  const location = row.state_location_override ?? row.base_location
  if (location === 'sent' || location === 'spam' || location === 'trash') return location
  return 'inbox'
}

function resolveIsRead(row: MailboxListRow): boolean {
  return row.state_is_read === null ? resolveDefaultIsRead(row) : row.state_is_read === 1
}

function resolveRemoteImagePermission(
  row: MailboxAccessRow,
): MailboxMessageDetail['remoteImagePermission'] {
  if (row.state_remote_images_allowed === 1) return 'message'
  if (row.state_remote_images_allowed === 0) return 'blocked'
  return row.sender_trusted === 1 ? 'sender' : 'default'
}

async function writeSparseMailboxState(options: {
  database: D1Database
  userId: string
  entryId: string
  field: SparseMailboxBooleanField
  value: number | null
  now: number
}): Promise<void> {
  await options.database.batch(sparseMailboxStateStatements(options.database, options))
}

type SparseMailboxBooleanField = 'is_read' | 'is_starred' | 'is_archived' | 'remote_images_allowed'

function sparseMailboxStateStatements(
  database: D1Database,
  options: {
    userId: string
    entryId: string
    field: SparseMailboxBooleanField
    value: number | null
    now: number
  },
): D1PreparedStatement[] {
  return options.value === null
    ? clearSparseMailboxStateStatements(database, options)
    : [sparseMailboxStateStatement(database, options)]
}

function sparseMailboxStateStatement(
  database: D1Database,
  options: {
    userId: string
    entryId: string
    field: SparseMailboxBooleanField
    value: number | null
    now: number
  },
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO mailbox_user_states (mailbox_entry_id, user_id, ${options.field}, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(mailbox_entry_id, user_id) DO UPDATE SET
         ${options.field} = excluded.${options.field},
         updated_at = excluded.updated_at`,
    )
    .bind(options.entryId, options.userId, options.value, options.now)
}

function clearSparseMailboxStateStatements(
  database: D1Database,
  options: {
    userId: string
    entryId: string
    field: SparseMailboxBooleanField
    now: number
  },
): D1PreparedStatement[] {
  const otherFields = ['is_read', 'is_starred', 'is_archived', 'remote_images_allowed']
    .filter((field) => field !== options.field)
    .map((field) => `${field} IS NULL`)
    .concat('location_override IS NULL')
    .join(' AND ')
  return [
    database
      .prepare(
        `DELETE FROM mailbox_user_states
         WHERE mailbox_entry_id = ?1 AND user_id = ?2 AND ${otherFields}`,
      )
      .bind(options.entryId, options.userId),
    database
      .prepare(
        `UPDATE mailbox_user_states
         SET ${options.field} = NULL, updated_at = ?3
         WHERE mailbox_entry_id = ?1 AND user_id = ?2`,
      )
      .bind(options.entryId, options.userId, options.now),
  ]
}

function parseScope(value: string | null | undefined): MailboxScope {
  const scope = value ?? 'all'
  if (scope !== 'all' && scope !== 'personal' && scope !== 'organization') {
    throw new MailboxInputError('scope', '邮箱范围无效')
  }
  return scope
}

function parseView(value: string | null | undefined): MailboxView {
  const view = value ?? 'inbox'
  if (
    view !== 'inbox' &&
    view !== 'sent' &&
    view !== 'starred' &&
    view !== 'archive' &&
    view !== 'spam' &&
    view !== 'trash' &&
    view !== 'all'
  ) {
    throw new MailboxInputError('view', '邮箱视图无效')
  }
  return view
}

function parseEntryIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PAGE_SIZE) {
    throw new MailboxInputError('entryIds', `请选择 1 至 ${MAX_PAGE_SIZE} 封邮件`)
  }
  const entryIds = value.map((entryId) => (typeof entryId === 'string' ? entryId.trim() : ''))
  if (entryIds.some((entryId) => entryId.length === 0 || entryId.length > 64)) {
    throw new MailboxInputError('entryIds', '邮件编号格式无效')
  }
  if (new Set(entryIds).size !== entryIds.length) {
    throw new MailboxInputError('entryIds', '同一封邮件不能重复选择')
  }
  return entryIds
}

function parseOrganizeAction(value: unknown): MailboxOrganizeAction {
  if (
    value !== 'mark_read' &&
    value !== 'mark_unread' &&
    value !== 'star' &&
    value !== 'unstar' &&
    value !== 'archive' &&
    value !== 'unarchive' &&
    value !== 'move_to_trash' &&
    value !== 'restore_from_trash' &&
    value !== 'mark_spam' &&
    value !== 'restore_from_spam'
  ) {
    throw new MailboxInputError('action', '邮箱整理操作无效')
  }
  return value
}

function mailboxViewCondition(view: MailboxView): string {
  const location = 'COALESCE(state.location_override, entry.base_location)'
  switch (view) {
    case 'inbox':
      return `entry.entry_kind = 'received' AND ${location} = 'inbox' AND COALESCE(state.is_archived, 0) = 0`
    case 'sent':
      return `entry.entry_kind = 'sent' AND ${location} = 'sent'`
    case 'starred':
      return `state.is_starred = 1 AND ${location} NOT IN ('spam', 'trash', 'hidden')`
    case 'archive':
      return `entry.entry_kind = 'received' AND ${location} = 'inbox' AND state.is_archived = 1`
    case 'spam':
      return `${location} = 'spam'`
    case 'trash':
      return `${location} = 'trash'`
    case 'all':
      return `${location} NOT IN ('spam', 'trash', 'hidden')`
  }
}

function parseOrganizationId(scope: MailboxScope, value: string | null | undefined): string | null {
  if (scope !== 'organization') return null
  const id = value?.trim() ?? ''
  if (!id || id.length > 64) throw new MailboxInputError('organizationId', '请选择有效的组织')
  return id
}

function parseLimit(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return DEFAULT_PAGE_SIZE
  const limit = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new MailboxInputError('limit', `每页数量必须在 1 至 ${MAX_PAGE_SIZE} 之间`)
  }
  return limit
}

function parseCursor(
  value: string | null | undefined,
  expectedSort: MailboxSort,
): ParsedCursor | null {
  if (!value) return null
  try {
    const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const parsed = JSON.parse(atob(padded)) as unknown
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      parsed[0] !== expectedSort ||
      !Number.isSafeInteger(parsed[1]) ||
      !Number.isSafeInteger(parsed[2]) ||
      typeof parsed[3] !== 'string' ||
      parsed[3].length === 0 ||
      parsed[3].length > 64
    ) {
      throw new Error('invalid cursor')
    }
    return {
      sort: expectedSort,
      sortValue: parsed[1],
      occurredAt: parsed[2],
      entryId: parsed[3],
    }
  } catch {
    throw new MailboxInputError('cursor', '分页位置无效，请重新打开收件箱')
  }
}

function encodeCursor(cursor: ParsedCursor): string {
  return btoa(JSON.stringify([cursor.sort, cursor.sortValue, cursor.occurredAt, cursor.entryId]))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '')
}

function parseOptionalSearchText(
  field: 'body' | 'subject' | 'sender' | 'recipient' | 'mailboxAddress',
  value: string | null | undefined,
  maximumLength: number,
): string {
  const normalized = value?.trim() ?? ''
  if (normalized.length > maximumLength) {
    throw new MailboxInputError(field, `搜索条件不能超过 ${maximumLength} 个字符`)
  }
  return normalized
}

function parseSearchTimestamp(
  field: 'dateFrom' | 'dateTo',
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined || value === '') return null
  const timestamp = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new MailboxInputError(field, '搜索日期无效')
  }
  return timestamp
}

function parseSearchChoice<const T extends readonly string[]>(
  field: 'attachment' | 'read' | 'starred' | 'archived',
  value: string | null | undefined,
  choices: T,
): T[number] {
  const candidate = value ?? 'all'
  if (!choices.includes(candidate)) throw new MailboxInputError(field, '搜索筛选条件无效')
  return candidate
}

function parseSort(value: string | null | undefined): MailboxSort {
  const sort = value ?? 'newest'
  if (
    sort !== 'newest' &&
    sort !== 'oldest' &&
    sort !== 'unread' &&
    sort !== 'starred' &&
    sort !== 'attachments'
  ) {
    throw new MailboxInputError('sort', '邮件排序方式无效')
  }
  return sort
}

function resolvedReadSql(): string {
  return `CASE
    WHEN state.is_read IS NOT NULL THEN state.is_read
    WHEN entry.entry_kind = 'sent' THEN 1
    WHEN entry.mailbox_type = 'organization'
      AND membership.joined_at IS NOT NULL
      AND entry.occurred_at < membership.joined_at THEN 1
    ELSE 0
  END`
}

function mailboxSortValueSql(sort: MailboxSort, readExpression: string): string {
  switch (sort) {
    case 'unread':
      return readExpression
    case 'starred':
      return 'COALESCE(state.is_starred, 0)'
    case 'attachments':
      return 'message.has_attachments'
    case 'newest':
    case 'oldest':
      return '0'
  }
}

function conversationSortValueSql(sort: MailboxSort): string {
  if (sort === 'unread') {
    return 'MIN(message_sort_value) OVER (PARTITION BY conversation_key)'
  }
  if (sort === 'starred' || sort === 'attachments') {
    return 'MAX(message_sort_value) OVER (PARTITION BY conversation_key)'
  }
  return '0'
}

function mailboxResultOrderBy(sort: MailboxSort): string {
  switch (sort) {
    case 'oldest':
      return 'occurred_at ASC, entry_id ASC'
    case 'unread':
      return 'conversation_sort_value ASC, occurred_at DESC, entry_id DESC'
    case 'starred':
    case 'attachments':
      return 'conversation_sort_value DESC, occurred_at DESC, entry_id DESC'
    case 'newest':
      return 'occurred_at DESC, entry_id DESC'
  }
}

function mailboxResultCursorCondition(
  sort: MailboxSort,
  cursor: ParsedCursor,
  bind: (value: unknown) => string,
): string {
  const sortValue = bind(cursor.sortValue)
  const occurredAt = bind(cursor.occurredAt)
  const entryId = bind(cursor.entryId)
  const descendingTime = `(occurred_at < ${occurredAt}
    OR (occurred_at = ${occurredAt} AND entry_id < ${entryId}))`
  if (sort === 'newest') return descendingTime
  if (sort === 'oldest') {
    return `(occurred_at > ${occurredAt}
      OR (occurred_at = ${occurredAt} AND entry_id > ${entryId}))`
  }
  const laterSortValue = sort === 'unread' ? '>' : '<'
  return `(conversation_sort_value ${laterSortValue} ${sortValue}
    OR (conversation_sort_value = ${sortValue} AND ${descendingTime}))`
}

function isMailboxHeaderAddressRole(row: HeaderAddressRow): row is HeaderAddressRow & {
  address_role: MailboxHeaderAddress['role']
} {
  return ['from', 'sender', 'reply_to', 'to', 'cc', 'bcc'].includes(row.address_role)
}

function safeDisplayFileName(value: string | null, sequenceNumber: number): string {
  const withoutControls = [...(value ?? '')]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && codePoint !== 127
    })
    .join('')
  const cleaned = withoutControls.replace(/[\\/:*?"<>|]/gu, '_').trim()
  return cleaned.slice(0, 240) || `附件-${sequenceNumber + 1}`
}

function normalizeMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? 'application/octet-stream'
}
