import type {
  UnallocatedMailDetail,
  UnallocatedMailListItem,
} from '../../../shared/contracts/unallocated-mail'
import type { PersonalAddressSummary } from '../../../shared/contracts/personal-address-management'
import type { StorageMode } from '../../../shared/contracts/storage-mode'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'
import {
  readAddressPolicySnapshot,
  validateLocalPartAgainstAddressPolicy,
} from '../../addresses/public'
import { normalizeCompleteEmailAddress } from '../../addresses/domain/email-address'
import { bytesToHex, sha256Bytes } from '../domain/content-digest'
import type { MailObjectStore } from '../infrastructure/object-storage'

const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 50
const MAX_ATOMIC_CLAIM_MESSAGES = 30
const SAFE_PREVIEW_MEDIA_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])

interface UnallocatedListRow {
  delivery_id: string
  period_id: string
  domain_id: string
  message_id: string
  subject: string
  occurred_at: number
  attachment_count: number
  has_attachments: number
  actual_delivery_address: string
  sender_display_name: string | null
  sender_address_text: string | null
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

interface ClaimPeriodRow {
  period_id: string
  domain_id: string
  canonical_address: string
  display_address: string
  local_part: string
  domain_name: string
  user_display_name: string
  storage_mode: StorageMode
  alias_limit: number
  alias_used: number
  self_creation_enabled: number
  storage_account_id: string
  committed_bytes: number
  reserved_bytes: number
  limit_bytes: number
  next_sort_order: number
  latest_state_at: number
}

interface ClaimDeliveryRow {
  delivery_id: string
  message_id: string
  raw_size_bytes: number
  occurred_at: number
  existing_received_entry_id: string | null
  existing_user_entry_count: number
  search_generation: number
  conversation_generation: number
}

export interface UnallocatedAttachmentDownload {
  bytes: ArrayBuffer
  fileName: string
  mediaType: string
  previewable: boolean
}

export class UnallocatedMailInputError extends Error {
  constructor(
    readonly field: 'cursor' | 'limit' | 'query' | 'confirmed' | 'periodId' | 'deliveryId',
    message: string,
  ) {
    super(message)
  }
}

export class UnallocatedMailAccessError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'permission_denied'
      | 'claim_conflict'
      | 'alias_quota_exceeded'
      | 'storage_quota_exceeded'
      | 'claim_too_large'
      | 'object_unavailable',
    message: string,
  ) {
    super(message)
  }
}

export async function listUnallocatedMail(options: {
  database: D1Database
  userId: string
  cursor?: string | null
  limit?: string | number | null
  query?: string | null
}): Promise<{ items: UnallocatedMailListItem[]; nextCursor: string | null }> {
  const limit = parseLimit(options.limit)
  const cursor = parseCursor(options.cursor)
  const query = normalizeQuery(options.query)
  const conditions = [
    `grant_access.user_id = ?1`,
    `user.status = 'active'`,
    `domain.status = 'active'`,
    `domain.catch_all_mode = 'unallocated'`,
    `period.period_status = 'open'`,
  ]
  const bindings: unknown[] = [options.userId]
  if (cursor) {
    conditions.push(
      `(delivery.delivered_at < ?2 OR (delivery.delivered_at = ?2 AND delivery.id < ?3))`,
    )
    bindings.push(cursor.occurredAt, cursor.deliveryId)
  }
  if (query) {
    const offset = bindings.length + 1
    conditions.push(`(
      lower(message.subject) LIKE ?${offset}
      OR lower(delivery.canonical_recipient_address) LIKE ?${offset}
      OR EXISTS (
        SELECT 1 FROM message_header_addresses AS searchable
        WHERE searchable.message_id = message.id
          AND searchable.address_role IN ('from', 'sender')
          AND lower(searchable.address_text) LIKE ?${offset}
      )
    )`)
    bindings.push(`%${query}%`)
  }
  bindings.push(limit + 1)
  const limitParameter = bindings.length
  const rows = await options.database
    .prepare(
      `SELECT delivery.id AS delivery_id, period.id AS period_id,
              period.domain_id, message.id AS message_id, message.subject,
              delivery.delivered_at AS occurred_at, message.attachment_count,
              message.has_attachments,
              delivery.display_recipient_address AS actual_delivery_address,
              sender.display_name AS sender_display_name,
              sender.address_text AS sender_address_text
       FROM unallocated_message_deliveries AS delivery
       JOIN unallocated_address_periods AS period ON period.id = delivery.unallocated_period_id
       JOIN mail_domains AS domain ON domain.id = period.domain_id
       JOIN unallocated_access_grants AS grant_access ON grant_access.domain_id = domain.id
       JOIN users AS user ON user.id = grant_access.user_id
       JOIN messages AS message ON message.id = delivery.message_id
       JOIN message_integrity_states AS integrity
         ON integrity.message_id = message.id AND integrity.integrity_status = 'ready'
       LEFT JOIN message_header_addresses AS sender
         ON sender.id = (
           SELECT candidate.id FROM message_header_addresses AS candidate
           WHERE candidate.message_id = message.id
             AND candidate.address_role IN ('from', 'sender')
           ORDER BY CASE candidate.address_role WHEN 'from' THEN 0 ELSE 1 END,
                    candidate.sequence_number, candidate.id
           LIMIT 1
         )
       WHERE ${conditions.join('\n AND ')}
       ORDER BY delivery.delivered_at DESC, delivery.id DESC
       LIMIT ?${limitParameter}`,
    )
    .bind(...bindings)
    .all<UnallocatedListRow>()
  const page = rows.results.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(mapListRow),
    nextCursor:
      rows.results.length > limit && last
        ? encodeCursor({ occurredAt: last.occurred_at, deliveryId: last.delivery_id })
        : null,
  }
}

export async function getUnallocatedMailDetail(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  deliveryId: string
}): Promise<UnallocatedMailDetail> {
  const row = await requireDeliveryAccess(options.database, options.userId, options.deliveryId)
  const [addresses, objects] = await Promise.all([
    options.database
      .prepare(
        `SELECT address_role, display_name, address_text
         FROM message_header_addresses
         WHERE message_id = ?1 AND visibility_scope = 'header'
         ORDER BY CASE address_role
           WHEN 'from' THEN 0 WHEN 'sender' THEN 1 WHEN 'reply_to' THEN 2
           WHEN 'to' THEN 3 WHEN 'cc' THEN 4 ELSE 5 END,
           sequence_number, id`,
      )
      .bind(row.message_id)
      .all<{ address_role: string; display_name: string | null; address_text: string }>(),
    listMessageObjects(options.database, row.message_id),
  ])
  const plain = objects.find((object) => object.object_role === 'plain_body')
  const html = objects.find((object) => object.object_role === 'html_body')
  const [plainTextBody, untrustedHtmlBody] = await Promise.all([
    plain ? readTextObject(options.objectStore, plain) : Promise.resolve(null),
    html ? readTextObject(options.objectStore, html) : Promise.resolve(null),
  ])
  return {
    ...mapListRow(row),
    headerDateText: row.header_date_text,
    headerDateAt: row.header_date_at,
    acceptedAt: row.accepted_at,
    addresses: addresses.results.map((address) => ({
      role: address.address_role as UnallocatedMailDetail['addresses'][number]['role'],
      displayName: address.display_name,
      address: address.address_text,
    })),
    plainTextBody,
    untrustedHtmlBody,
    attachments: objects
      .filter(
        (object) => object.object_role === 'attachment' || object.object_role === 'inline_resource',
      )
      .map((object) => ({
        id: object.id,
        fileName: safeDisplayFileName(object.untrusted_file_name, object.sequence_number),
        mediaType: object.media_type,
        sizeBytes: object.actual_size_bytes ?? object.expected_size_bytes,
        inline: object.object_role === 'inline_resource',
        previewable: SAFE_PREVIEW_MEDIA_TYPES.has(normalizeMediaType(object.media_type)),
      })),
  }
}

export async function getUnallocatedAttachmentDownload(options: {
  database: D1Database
  objectStore: MailObjectStore
  userId: string
  deliveryId: string
  objectId: string
}): Promise<UnallocatedAttachmentDownload> {
  const access = await requireDeliveryAccess(options.database, options.userId, options.deliveryId)
  const object = await options.database
    .prepare(
      `SELECT id, object_key, object_role, sequence_number, expected_size_bytes,
              actual_size_bytes, hex(COALESCE(actual_sha256, expected_sha256)) AS verified_sha256,
              media_type, untrusted_file_name, content_disposition
       FROM object_registry
       WHERE id = ?1 AND message_id = ?2
         AND object_role IN ('attachment', 'inline_resource')
         AND is_current = 1 AND object_status = 'active'
       LIMIT 1`,
    )
    .bind(options.objectId, access.message_id)
    .first<MessageObjectRow>()
  if (!object) throw new UnallocatedMailAccessError('not_found', '附件不存在或无权访问')
  return {
    bytes: await readVerifiedObject(options.objectStore, object),
    fileName: safeDisplayFileName(object.untrusted_file_name, object.sequence_number),
    mediaType: object.media_type,
    previewable: SAFE_PREVIEW_MEDIA_TYPES.has(normalizeMediaType(object.media_type)),
  }
}

export async function claimUnallocatedAddress(options: {
  database: D1Database
  queue?: Queue<{ taskId: string; inputVersion: number }>
  userId: string
  periodId: string
  audit: AuditContext
  now?: number
}): Promise<{
  periodId: string
  addressId: string
  address: string
  claimedAlias: PersonalAddressSummary
  claimedMessageCount: number
  newlyAddedMessageCount: number
  chargedBytes: number
}> {
  const period = await readClaimPeriod(options.database, options.userId, options.periodId)
  if (!period) {
    throw new UnallocatedMailAccessError('permission_denied', '未分配地址不存在或无权认领')
  }
  if (period.self_creation_enabled !== 1) {
    throw new UnallocatedMailAccessError('claim_conflict', '管理员已关闭个人别名自助创建')
  }
  if (period.alias_used >= period.alias_limit) {
    throw new UnallocatedMailAccessError('alias_quota_exceeded', '个人别名额度已用完')
  }
  const normalized = normalizeCompleteEmailAddress(period.canonical_address)
  validateLocalPartAgainstAddressPolicy(
    normalized.localPart,
    await readAddressPolicySnapshot(options.database),
  )
  const deliveries = await readClaimDeliveries(options.database, options.userId, period.period_id)
  if (deliveries.length === 0) {
    throw new UnallocatedMailAccessError('claim_conflict', '当前未分配时期没有可认领邮件')
  }
  if (deliveries.length > MAX_ATOMIC_CLAIM_MESSAGES) {
    throw new UnallocatedMailAccessError(
      'claim_too_large',
      `当前时期有 ${deliveries.length} 封邮件，超过本地已验证的单次原子认领上限`,
    )
  }
  const chargedBytes = deliveries
    .filter((delivery) => delivery.existing_user_entry_count === 0)
    .reduce((total, delivery) => total + delivery.raw_size_bytes, 0)
  if (period.committed_bytes + period.reserved_bytes + chargedBytes > period.limit_bytes) {
    throw new UnallocatedMailAccessError('storage_quota_exceeded', '认领历史邮件所需存储额度不足')
  }

  const now = Math.max(options.now ?? Date.now(), period.latest_state_at)
  const addressId = crypto.randomUUID()
  const bindingId = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO email_addresses (
          id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
         )
         SELECT ?1, period.domain_id, period.display_address, period.canonical_address,
                NULL, ?2, NULL
         FROM unallocated_address_periods AS period
         JOIN mail_domains AS domain
           ON domain.id = period.domain_id AND domain.status = 'active'
          AND domain.catch_all_mode = 'unallocated'
         JOIN unallocated_access_grants AS grant_access
           ON grant_access.domain_id = period.domain_id AND grant_access.user_id = ?3
         JOIN users AS user ON user.id = ?3 AND user.status = 'active'
         JOIN user_alias_policies AS alias_policy ON alias_policy.user_id = user.id
         JOIN logical_storage_usage_accounts AS account
           ON account.storage_mode = ?4 AND account.owner_type = 'user' AND account.user_id = user.id
         JOIN logical_storage_quota_policies AS defaults
           ON defaults.storage_mode = account.storage_mode
          AND defaults.owner_type = 'system_default' AND defaults.default_owner_type = 'user'
          AND defaults.policy_status = 'active'
         LEFT JOIN logical_storage_quota_policies AS override
           ON override.storage_mode = account.storage_mode
          AND override.owner_type = 'user' AND override.user_id = user.id
          AND override.policy_status = 'active'
         JOIN address_policy_settings AS address_policy ON address_policy.singleton_id = 1
         WHERE period.id = ?5 AND period.period_status = 'open'
           AND alias_policy.self_creation_enabled = 1
           AND alias_policy.alias_limit > (
             SELECT COUNT(*) FROM address_bindings
             WHERE user_id = user.id AND owner_type = 'user'
               AND address_role = 'alias' AND ended_at IS NULL
           )
           AND length(?6) >= address_policy.minimum_local_part_length
           AND NOT EXISTS (
             SELECT 1 FROM address_policy_terms AS term
             WHERE (term.term_kind = 'reserved_name' AND term.normalized_value = ?6)
                OR (term.term_kind = 'blocked_substring' AND instr(?6, term.normalized_value) > 0)
           )
           AND account.committed_bytes + account.reserved_bytes + ?7
             <= COALESCE(override.limit_bytes, defaults.limit_bytes)
           AND NOT EXISTS (
             SELECT 1 FROM address_claims
             WHERE canonical_address = period.canonical_address COLLATE NOCASE
           )`,
      )
      .bind(
        addressId,
        now,
        options.userId,
        period.storage_mode,
        period.period_id,
        period.local_part,
        chargedBytes,
      ),
    options.database
      .prepare(
        `INSERT INTO address_claims (
          canonical_address, address_id, status, reserved_until, created_at, updated_at
         ) VALUES (?1, ?2, 'active', NULL, ?3, ?3)`,
      )
      .bind(period.canonical_address, addressId, now),
    options.database
      .prepare(
        `INSERT INTO address_bindings (
          id, address_id, owner_type, user_id, organization_id,
          address_role, started_at, ended_at, ended_reason
         ) VALUES (?1, ?2, 'user', ?3, NULL, 'alias', ?4, NULL, NULL)`,
      )
      .bind(bindingId, addressId, options.userId, now),
    options.database
      .prepare(
        `INSERT INTO user_address_preferences (
          user_id, address_id, custom_label, is_pinned, sort_order,
          is_default_sender, sender_display_name, signature_format,
          signature_content, created_at, updated_at
         ) VALUES (?1, ?2, NULL, 0, ?3, 0, ?4, NULL, NULL, ?5, ?5)`,
      )
      .bind(options.userId, addressId, period.next_sort_order, period.user_display_name, now),
    options.database
      .prepare(
        `UPDATE unallocated_address_periods
         SET period_status = 'claimed', closed_at = ?1,
             claimed_by_user_id = ?2, claimed_address_id = ?3,
             claimed_address_binding_id = ?4, updated_at = ?1
         WHERE id = ?5 AND period_status = 'open'`,
      )
      .bind(now, options.userId, addressId, bindingId, period.period_id),
  ]

  const taskMessages: { taskId: string; inputVersion: number }[] = []
  for (const delivery of deliveries) {
    const mailboxEntryId = delivery.existing_received_entry_id ?? delivery.delivery_id
    if (!delivery.existing_received_entry_id) {
      statements.push(
        options.database
          .prepare(
            `INSERT INTO mailbox_entries (
              id, message_id, mailbox_type, user_id, organization_id,
              entry_kind, base_location, occurred_at, created_at
             ) VALUES (?1, ?2, 'user', ?3, NULL, 'received', 'inbox', ?4, ?5)`,
          )
          .bind(mailboxEntryId, delivery.message_id, options.userId, delivery.occurred_at, now),
      )
    }
    statements.push(
      options.database
        .prepare(
          `INSERT INTO mailbox_entry_unallocated_deliveries (
            mailbox_entry_id, unallocated_delivery_id, created_at
           ) VALUES (?1, ?2, ?3)`,
        )
        .bind(mailboxEntryId, delivery.delivery_id, now),
    )
    if (!delivery.existing_received_entry_id) {
      const searchGeneration = delivery.search_generation + 1
      const searchTaskId = crypto.randomUUID()
      const conversationGeneration = delivery.conversation_generation + 1
      const conversationTaskId = crypto.randomUUID()
      statements.push(
        options.database
          .prepare(
            `DELETE FROM message_search_index
             WHERE rowid IN (
               SELECT id FROM message_search_chunks WHERE message_id = ?1
             )`,
          )
          .bind(delivery.message_id),
        options.database
          .prepare('DELETE FROM message_search_chunks WHERE message_id = ?1')
          .bind(delivery.message_id),
        options.database
          .prepare(
            `UPDATE message_search_states
             SET index_generation = ?1, index_status = 'pending', chunk_count = 0,
                 last_error_code = NULL, indexed_at = NULL, updated_at = ?2
             WHERE message_id = ?3`,
          )
          .bind(searchGeneration, now, delivery.message_id),
        backgroundTaskStatement(options.database, {
          id: searchTaskId,
          taskType: 'index_message',
          targetType: 'message_search',
          targetReference: delivery.message_id,
          inputVersion: searchGeneration,
          digest: await sha256Bytes(`index_message\n${delivery.message_id}\n${searchGeneration}`),
          now,
        }),
        backgroundTaskStatement(options.database, {
          id: conversationTaskId,
          taskType: 'rebuild_conversation',
          targetType: 'message_conversation',
          targetReference: delivery.message_id,
          inputVersion: conversationGeneration,
          digest: await sha256Bytes(
            `rebuild_conversation\n${delivery.message_id}\n${conversationGeneration}`,
          ),
          now,
        }),
      )
      taskMessages.push(
        { taskId: searchTaskId, inputVersion: searchGeneration },
        { taskId: conversationTaskId, inputVersion: conversationGeneration },
      )
    }
  }
  if (chargedBytes > 0) {
    statements.push(
      options.database
        .prepare(
          `INSERT INTO logical_storage_usage_entries (
            id, storage_usage_account_id, storage_reservation_id, entry_kind,
            owner_reference, bytes_delta, idempotency_key_digest, committed_at, created_at
           ) VALUES (?1, ?2, NULL, 'message', ?3, ?4, ?5, ?6, ?6)`,
        )
        .bind(
          crypto.randomUUID(),
          period.storage_account_id,
          `unallocated-period:${period.period_id}`,
          chargedBytes,
          await sha256Bytes(`unallocated-claim\n${period.period_id}\n${options.userId}`),
          now,
        ),
    )
  }
  statements.push(
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName: 'unallocated_address.claimed',
      targetType: 'unallocated_address_period',
      targetReference: period.period_id,
      outcome: 'succeeded',
      reasonCode: 'user_confirmed',
      occurredAt: now,
    }),
  )
  try {
    await options.database.batch(statements)
  } catch (error) {
    if (String(error).includes('UNIQUE constraint')) {
      throw new UnallocatedMailAccessError('claim_conflict', '该地址已经被认领或占用')
    }
    throw error
  }
  if (options.queue && taskMessages.length > 0) {
    try {
      await options.queue.sendBatch(taskMessages.map((body) => ({ body })))
    } catch {
      // D1 任务账本已经提交，定时任务会补投。
    }
  }
  return {
    periodId: period.period_id,
    addressId,
    address: period.canonical_address,
    claimedAlias: {
      id: addressId,
      address: period.canonical_address,
      domainId: period.domain_id,
      domainDisplayName: period.domain_name,
      role: 'alias',
      customLabel: null,
      isPinned: false,
      sortOrder: period.next_sort_order,
      isDefaultSender: false,
      createdAt: new Date(now).toISOString(),
    },
    claimedMessageCount: deliveries.length,
    newlyAddedMessageCount: deliveries.filter((delivery) => !delivery.existing_received_entry_id)
      .length,
    chargedBytes,
  }
}

async function readClaimPeriod(
  database: D1Database,
  userId: string,
  periodId: string,
): Promise<ClaimPeriodRow | null> {
  return database
    .prepare(
      `SELECT period.id AS period_id, period.domain_id, period.canonical_address,
              period.display_address,
              substr(period.canonical_address, 1, instr(period.canonical_address, '@') - 1)
                AS local_part,
              domain.canonical_name AS domain_name, user.display_name AS user_display_name,
              system.storage_mode, alias_policy.alias_limit,
              alias_policy.self_creation_enabled,
              (
                SELECT COUNT(*) FROM address_bindings
                WHERE user_id = user.id AND owner_type = 'user'
                  AND address_role = 'alias' AND ended_at IS NULL
              ) AS alias_used,
              account.id AS storage_account_id, account.committed_bytes,
              account.reserved_bytes,
              COALESCE(override.limit_bytes, defaults.limit_bytes) AS limit_bytes,
              COALESCE((
                SELECT MAX(sort_order) + 1 FROM user_address_preferences
                WHERE user_id = user.id
              ), 0) AS next_sort_order,
              MAX(
                period.updated_at,
                COALESCE((
                  SELECT MAX(search_state.updated_at)
                  FROM unallocated_message_deliveries AS delivery
                  JOIN message_search_states AS search_state
                    ON search_state.message_id = delivery.message_id
                  WHERE delivery.unallocated_period_id = period.id
                ), period.updated_at)
              ) AS latest_state_at
       FROM unallocated_address_periods AS period
       JOIN mail_domains AS domain
         ON domain.id = period.domain_id AND domain.status = 'active'
        AND domain.catch_all_mode = 'unallocated'
       JOIN unallocated_access_grants AS grant_access
         ON grant_access.domain_id = period.domain_id AND grant_access.user_id = ?1
       JOIN users AS user ON user.id = ?1 AND user.status = 'active'
       JOIN user_alias_policies AS alias_policy ON alias_policy.user_id = user.id
       JOIN system_instances AS system ON system.singleton_id = 1
       JOIN logical_storage_usage_accounts AS account
         ON account.storage_mode = system.storage_mode
        AND account.owner_type = 'user' AND account.user_id = user.id
       JOIN logical_storage_quota_policies AS defaults
         ON defaults.storage_mode = system.storage_mode
        AND defaults.owner_type = 'system_default' AND defaults.default_owner_type = 'user'
        AND defaults.policy_status = 'active'
       LEFT JOIN logical_storage_quota_policies AS override
         ON override.storage_mode = system.storage_mode
        AND override.owner_type = 'user' AND override.user_id = user.id
        AND override.policy_status = 'active'
       WHERE period.id = ?2 AND period.period_status = 'open'
       LIMIT 1`,
    )
    .bind(userId, periodId)
    .first<ClaimPeriodRow>()
}

async function readClaimDeliveries(
  database: D1Database,
  userId: string,
  periodId: string,
): Promise<ClaimDeliveryRow[]> {
  const rows = await database
    .prepare(
      `SELECT delivery.id AS delivery_id, delivery.message_id,
              message.raw_size_bytes, delivery.delivered_at AS occurred_at,
              (
                SELECT entry.id FROM mailbox_entries AS entry
                WHERE entry.mailbox_type = 'user' AND entry.user_id = ?1
                  AND entry.message_id = delivery.message_id AND entry.entry_kind = 'received'
                LIMIT 1
              ) AS existing_received_entry_id,
              (
                SELECT COUNT(*) FROM mailbox_entries AS entry
                WHERE entry.mailbox_type = 'user' AND entry.user_id = ?1
                  AND entry.message_id = delivery.message_id
              ) AS existing_user_entry_count,
              search_state.index_generation AS search_generation,
              COALESCE((
                SELECT MAX(task.input_version) FROM background_tasks AS task
                WHERE task.task_type = 'rebuild_conversation'
                  AND task.target_type = 'message_conversation'
                  AND task.target_reference = delivery.message_id
              ), 0) AS conversation_generation
       FROM unallocated_message_deliveries AS delivery
       JOIN messages AS message ON message.id = delivery.message_id
       JOIN message_integrity_states AS integrity
         ON integrity.message_id = message.id AND integrity.integrity_status = 'ready'
       JOIN message_search_states AS search_state ON search_state.message_id = message.id
       WHERE delivery.unallocated_period_id = ?2
       ORDER BY delivery.delivered_at, delivery.id`,
    )
    .bind(userId, periodId)
    .all<ClaimDeliveryRow>()
  return rows.results
}

async function requireDeliveryAccess(
  database: D1Database,
  userId: string,
  deliveryId: string,
): Promise<
  UnallocatedListRow & {
    header_date_text: string | null
    header_date_at: number | null
    accepted_at: number
  }
> {
  const row = await database
    .prepare(
      `SELECT delivery.id AS delivery_id, period.id AS period_id,
              period.domain_id, message.id AS message_id, message.subject,
              delivery.delivered_at AS occurred_at, message.attachment_count,
              message.has_attachments,
              delivery.display_recipient_address AS actual_delivery_address,
              sender.display_name AS sender_display_name,
              sender.address_text AS sender_address_text,
              message.header_date_text, message.header_date_at, message.accepted_at
       FROM unallocated_message_deliveries AS delivery
       JOIN unallocated_address_periods AS period
         ON period.id = delivery.unallocated_period_id AND period.period_status = 'open'
       JOIN mail_domains AS domain
         ON domain.id = period.domain_id AND domain.status = 'active'
        AND domain.catch_all_mode = 'unallocated'
       JOIN unallocated_access_grants AS grant_access
         ON grant_access.domain_id = domain.id AND grant_access.user_id = ?1
       JOIN users AS user ON user.id = grant_access.user_id AND user.status = 'active'
       JOIN messages AS message ON message.id = delivery.message_id
       JOIN message_integrity_states AS integrity
         ON integrity.message_id = message.id AND integrity.integrity_status = 'ready'
       LEFT JOIN message_header_addresses AS sender
         ON sender.id = (
           SELECT candidate.id FROM message_header_addresses AS candidate
           WHERE candidate.message_id = message.id
             AND candidate.address_role IN ('from', 'sender')
           ORDER BY CASE candidate.address_role WHEN 'from' THEN 0 ELSE 1 END,
                    candidate.sequence_number, candidate.id LIMIT 1
         )
       WHERE delivery.id = ?2 LIMIT 1`,
    )
    .bind(userId, deliveryId)
    .first<
      UnallocatedListRow & {
        header_date_text: string | null
        header_date_at: number | null
        accepted_at: number
      }
    >()
  if (!row) throw new UnallocatedMailAccessError('not_found', '未分配来信不存在或无权访问')
  return row
}

async function listMessageObjects(database: D1Database, messageId: string) {
  const rows = await database
    .prepare(
      `SELECT id, object_key, object_role, sequence_number, expected_size_bytes,
              actual_size_bytes, hex(COALESCE(actual_sha256, expected_sha256)) AS verified_sha256,
              media_type, untrusted_file_name, content_disposition
       FROM object_registry
       WHERE message_id = ?1
         AND object_role IN ('plain_body', 'html_body', 'attachment', 'inline_resource')
         AND is_current = 1 AND object_status = 'active'
       ORDER BY CASE object_role WHEN 'plain_body' THEN 0 WHEN 'html_body' THEN 1
         WHEN 'attachment' THEN 2 ELSE 3 END, sequence_number, id`,
    )
    .bind(messageId)
    .all<MessageObjectRow>()
  return rows.results
}

async function readTextObject(store: MailObjectStore, object: MessageObjectRow) {
  return new TextDecoder().decode(await readVerifiedObject(store, object))
}

async function readVerifiedObject(store: MailObjectStore, object: MessageObjectRow) {
  const stored = await store.get(object.object_key)
  if (!stored) throw new UnallocatedMailAccessError('object_unavailable', '邮件对象暂时无法读取')
  const digest = await sha256Bytes(stored.bytes)
  if (
    stored.bytes.byteLength !== (object.actual_size_bytes ?? object.expected_size_bytes) ||
    bytesToHex(digest) !== object.verified_sha256.toLowerCase()
  ) {
    throw new UnallocatedMailAccessError('object_unavailable', '邮件对象完整性校验失败')
  }
  return stored.bytes
}

function mapListRow(row: UnallocatedListRow): UnallocatedMailListItem {
  return {
    deliveryId: row.delivery_id,
    periodId: row.period_id,
    domainId: row.domain_id,
    messageId: row.message_id,
    subject: row.subject,
    sender: row.sender_address_text
      ? { displayName: row.sender_display_name, address: row.sender_address_text }
      : null,
    actualDeliveryAddress: row.actual_delivery_address,
    occurredAt: row.occurred_at,
    hasAttachments: row.has_attachments === 1,
    attachmentCount: row.attachment_count,
  }
}

function backgroundTaskStatement(
  database: D1Database,
  options: {
    id: string
    taskType: string
    targetType: string
    targetReference: string
    inputVersion: number
    digest: Uint8Array
    now: number
  },
) {
  return database
    .prepare(
      `INSERT INTO background_tasks (
        id, task_type, target_type, target_reference, input_version,
        task_key_digest, task_status, priority, attempt_count, max_attempts,
        next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
        last_error_code, last_error_summary, last_error_at, completed_at,
        created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 5, 0, 5,
         ?7, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?7, ?7)`,
    )
    .bind(
      options.id,
      options.taskType,
      options.targetType,
      options.targetReference,
      options.inputVersion,
      options.digest,
      options.now,
    )
}

function parseLimit(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return DEFAULT_PAGE_SIZE
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new UnallocatedMailInputError('limit', '每页数量必须是 1 至 50 的整数')
  }
  return parsed
}

function normalizeQuery(value: string | null | undefined) {
  const query = value?.trim().normalize('NFC').toLocaleLowerCase() ?? ''
  if (query.length > 200)
    throw new UnallocatedMailInputError('query', '搜索内容不能超过 200 个字符')
  return query
}

function encodeCursor(cursor: { occurredAt: number; deliveryId: string }) {
  return btoa(JSON.stringify(cursor))
}

function parseCursor(value: string | null | undefined) {
  if (!value) return null
  try {
    const parsed = JSON.parse(atob(value)) as Record<string, unknown>
    if (typeof parsed.occurredAt !== 'number' || typeof parsed.deliveryId !== 'string') {
      throw new Error('invalid')
    }
    return { occurredAt: parsed.occurredAt, deliveryId: parsed.deliveryId }
  } catch {
    throw new UnallocatedMailInputError('cursor', '分页游标无效')
  }
}

function safeDisplayFileName(value: string | null, sequenceNumber: number) {
  const fallback = `附件-${sequenceNumber + 1}`
  if (!value) return fallback
  const invalidFileNameCharacters = '\\/:*?"<>|'
  const sanitized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127 || invalidFileNameCharacters.includes(character)
        ? '_'
        : character
    })
    .join('')
    .trim()
  return sanitized.slice(0, 180) || fallback
}

function normalizeMediaType(value: string) {
  return value.split(';', 1)[0]!.trim().toLowerCase()
}
