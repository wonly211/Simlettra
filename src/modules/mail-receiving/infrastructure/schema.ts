import { sql } from 'drizzle-orm'
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { addressBindings, emailAddresses, mailDomains } from '../../addresses/infrastructure/schema'
import { users } from '../../identity/infrastructure/schema'
import { organizations } from '../../organizations/infrastructure/schema'

export const inboundReceiveControls = sqliteTable(
  'inbound_receive_controls',
  {
    id: text('id').primaryKey().notNull(),
    scopeType: text('scope_type').notNull(),
    domainId: text('domain_id').references(() => mailDomains.id, { onDelete: 'cascade' }),
    addressId: text('address_id').references(() => emailAddresses.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    receiveStatus: text('receive_status').notNull(),
    updatedByUserId: text('updated_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    pausedAt: integer('paused_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('inbound_receive_controls_domain_unique')
      .on(table.domainId)
      .where(sql`${table.scopeType} = 'domain'`),
    uniqueIndex('inbound_receive_controls_address_unique')
      .on(table.addressId)
      .where(sql`${table.scopeType} = 'address'`),
    uniqueIndex('inbound_receive_controls_user_unique')
      .on(table.userId)
      .where(sql`${table.scopeType} = 'user'`),
    index('inbound_receive_controls_status_index').on(
      table.receiveStatus,
      table.scopeType,
      table.updatedAt,
      table.id,
    ),
  ],
)

export const inboundRejectionRules = sqliteTable(
  'inbound_rejection_rules',
  {
    id: text('id').primaryKey().notNull(),
    ruleType: text('rule_type').notNull(),
    matchValue: text('match_value').notNull(),
    ruleStatus: text('rule_status').notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedByUserId: text('updated_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('inbound_rejection_rules_type_value_unique').on(table.ruleType, table.matchValue),
    index('inbound_rejection_rules_match_index').on(
      table.ruleStatus,
      table.ruleType,
      table.matchValue,
      table.id,
    ),
  ],
)

export const unallocatedAddressPeriods = sqliteTable(
  'unallocated_address_periods',
  {
    id: text('id').primaryKey().notNull(),
    domainId: text('domain_id')
      .notNull()
      .references(() => mailDomains.id, { onDelete: 'restrict' }),
    canonicalAddress: text('canonical_address').notNull(),
    displayAddress: text('display_address').notNull(),
    periodStatus: text('period_status').notNull(),
    startedAt: integer('started_at').notNull(),
    closedAt: integer('closed_at'),
    claimedByUserId: text('claimed_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    claimedAddressId: text('claimed_address_id').references(() => emailAddresses.id, {
      onDelete: 'restrict',
    }),
    claimedAddressBindingId: text('claimed_address_binding_id').references(
      () => addressBindings.id,
      { onDelete: 'restrict' },
    ),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('unallocated_address_periods_open_unique')
      .on(table.canonicalAddress)
      .where(sql`${table.periodStatus} = 'open'`),
    index('unallocated_address_periods_domain_index').on(
      table.domainId,
      table.periodStatus,
      table.startedAt,
      table.id,
    ),
  ],
)

export const unallocatedAccessGrants = sqliteTable(
  'unallocated_access_grants',
  {
    domainId: text('domain_id')
      .notNull()
      .references(() => mailDomains.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    grantedByUserId: text('granted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.domainId, table.userId] }),
    index('unallocated_access_grants_user_index').on(table.userId, table.domainId),
  ],
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey().notNull(),
    originType: text('origin_type').notNull(),
    authoredByUserId: text('authored_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    internetMessageId: text('internet_message_id'),
    subject: text('subject').notNull().default(''),
    headerDateText: text('header_date_text'),
    headerDateAt: integer('header_date_at'),
    acceptedAt: integer('accepted_at').notNull(),
    sortAt: integer('sort_at').notNull(),
    rawSizeBytes: integer('raw_size_bytes').notNull(),
    attachmentCount: integer('attachment_count').notNull().default(0),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('messages_sort_index').on(table.sortAt, table.id),
    index('messages_internet_message_id_index').on(table.internetMessageId, table.id),
  ],
)

export const messageHeaderAddresses = sqliteTable(
  'message_header_addresses',
  {
    id: text('id').primaryKey().notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    addressRole: text('address_role').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    displayName: text('display_name'),
    addressText: text('address_text').notNull(),
    canonicalAddress: text('canonical_address'),
    visibilityScope: text('visibility_scope').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('message_header_addresses_message_role_sequence_unique').on(
      table.messageId,
      table.addressRole,
      table.sequenceNumber,
    ),
    index('message_header_addresses_message_index').on(
      table.messageId,
      table.addressRole,
      table.sequenceNumber,
    ),
  ],
)

export const messageDeliveries = sqliteTable(
  'message_deliveries',
  {
    id: text('id').primaryKey().notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    addressBindingId: text('address_binding_id')
      .notNull()
      .references(() => addressBindings.id, { onDelete: 'restrict' }),
    canonicalRecipientAddress: text('canonical_recipient_address').notNull(),
    displayRecipientAddress: text('display_recipient_address').notNull(),
    deliverySource: text('delivery_source').notNull(),
    deliveredAt: integer('delivered_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('message_deliveries_message_binding_unique').on(table.messageId, table.addressBindingId),
    index('message_deliveries_binding_index').on(
      table.addressBindingId,
      table.deliveredAt,
      table.id,
    ),
  ],
)

export const unallocatedMessageDeliveries = sqliteTable(
  'unallocated_message_deliveries',
  {
    id: text('id').primaryKey().notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    unallocatedPeriodId: text('unallocated_period_id')
      .notNull()
      .references(() => unallocatedAddressPeriods.id, { onDelete: 'restrict' }),
    canonicalRecipientAddress: text('canonical_recipient_address').notNull(),
    displayRecipientAddress: text('display_recipient_address').notNull(),
    deliverySource: text('delivery_source').notNull(),
    deliveredAt: integer('delivered_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('unallocated_message_deliveries_message_period_unique').on(
      table.messageId,
      table.unallocatedPeriodId,
    ),
    index('unallocated_message_deliveries_period_index').on(
      table.unallocatedPeriodId,
      table.deliveredAt,
      table.id,
    ),
  ],
)

export const mailboxEntries = sqliteTable(
  'mailbox_entries',
  {
    id: text('id').primaryKey().notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    mailboxType: text('mailbox_type').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    entryKind: text('entry_kind').notNull(),
    baseLocation: text('base_location').notNull(),
    occurredAt: integer('occurred_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('mailbox_entries_user_message_unique')
      .on(table.messageId, table.userId, table.entryKind)
      .where(sql`${table.mailboxType} = 'user'`),
    uniqueIndex('mailbox_entries_organization_message_unique')
      .on(table.messageId, table.organizationId, table.entryKind)
      .where(sql`${table.mailboxType} = 'organization'`),
    index('mailbox_entries_user_list_index').on(table.userId, table.occurredAt, table.id),
    index('mailbox_entries_organization_list_index').on(
      table.organizationId,
      table.occurredAt,
      table.id,
    ),
  ],
)

export const mailboxEntryDeliveries = sqliteTable(
  'mailbox_entry_deliveries',
  {
    mailboxEntryId: text('mailbox_entry_id')
      .notNull()
      .references(() => mailboxEntries.id, { onDelete: 'cascade' }),
    deliveryId: text('delivery_id')
      .notNull()
      .unique()
      .references(() => messageDeliveries.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.mailboxEntryId, table.deliveryId] })],
)

export const mailboxEntryUnallocatedDeliveries = sqliteTable(
  'mailbox_entry_unallocated_deliveries',
  {
    mailboxEntryId: text('mailbox_entry_id')
      .notNull()
      .references(() => mailboxEntries.id, { onDelete: 'cascade' }),
    unallocatedDeliveryId: text('unallocated_delivery_id')
      .notNull()
      .unique()
      .references(() => unallocatedMessageDeliveries.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.mailboxEntryId, table.unallocatedDeliveryId] })],
)

export const objectRegistry = sqliteTable(
  'object_registry',
  {
    id: text('id').primaryKey().notNull(),
    storageMode: text('storage_mode').notNull(),
    objectKey: text('object_key').notNull().unique(),
    ownerKind: text('owner_kind').notNull(),
    ownerReference: text('owner_reference').notNull(),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'restrict' }),
    objectRole: text('object_role').notNull(),
    logicalPartKey: text('logical_part_key').notNull(),
    sequenceNumber: integer('sequence_number').notNull().default(0),
    generation: integer('generation').notNull(),
    requiredForVisibility: integer('required_for_visibility', { mode: 'boolean' })
      .notNull()
      .default(true),
    isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
    expectedSizeBytes: integer('expected_size_bytes').notNull(),
    expectedSha256: blob('expected_sha256', { mode: 'buffer' }).notNull(),
    actualSizeBytes: integer('actual_size_bytes'),
    actualSha256: blob('actual_sha256', { mode: 'buffer' }),
    mediaType: text('media_type').notNull(),
    untrustedFileName: text('untrusted_file_name'),
    contentDisposition: text('content_disposition'),
    contentId: text('content_id'),
    producerVersion: text('producer_version').notNull(),
    backendVersionReference: text('backend_version_reference'),
    objectStatus: text('object_status').notNull(),
    storedAt: integer('stored_at'),
    verifiedAt: integer('verified_at'),
    consistencyCheckedAt: integer('consistency_checked_at'),
    activatedAt: integer('activated_at'),
    supersededAt: integer('superseded_at'),
    deleteAfter: integer('delete_after'),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('object_registry_owner_part_generation_unique').on(
      table.ownerKind,
      table.ownerReference,
      table.objectRole,
      table.logicalPartKey,
      table.generation,
    ),
    uniqueIndex('object_registry_current_part_unique')
      .on(table.ownerKind, table.ownerReference, table.objectRole, table.logicalPartKey)
      .where(sql`${table.isCurrent} = 1`),
    index('object_registry_message_index').on(
      table.messageId,
      table.objectRole,
      table.isCurrent,
      table.sequenceNumber,
    ),
    index('object_registry_work_index').on(
      table.objectStatus,
      table.storageMode,
      table.updatedAt,
      table.id,
    ),
  ],
)

export const messageIntegrityStates = sqliteTable('message_integrity_states', {
  messageId: text('message_id')
    .primaryKey()
    .notNull()
    .references(() => messages.id, { onDelete: 'restrict' }),
  sourceCompleteness: text('source_completeness').notNull(),
  integrityStatus: text('integrity_status').notNull(),
  objectSetVersion: integer('object_set_version').notNull().default(1),
  readyAt: integer('ready_at'),
  hiddenSince: integer('hidden_since'),
  damageCode: text('damage_code'),
  damageSummary: text('damage_summary'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const receiveOperations = sqliteTable(
  'receive_operations',
  {
    id: text('id').primaryKey().notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceEventReference: text('source_event_reference'),
    deduplicationKind: text('deduplication_kind').notNull(),
    deduplicationKeyDigest: blob('deduplication_key_digest', { mode: 'buffer' }).notNull(),
    deduplicationWindowStartedAt: integer('deduplication_window_started_at'),
    deduplicationExpiresAt: integer('deduplication_expires_at'),
    messageReference: text('message_reference').notNull(),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'restrict' }),
    rawObjectId: text('raw_object_id').references(() => objectRegistry.id, {
      onDelete: 'restrict',
    }),
    rawSizeBytes: integer('raw_size_bytes').notNull(),
    rawSha256: blob('raw_sha256', { mode: 'buffer' }).notNull(),
    envelopeSenderText: text('envelope_sender_text').notNull(),
    operationStatus: text('operation_status').notNull(),
    parserVersion: text('parser_version'),
    parsedPartCount: integer('parsed_part_count'),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
    acceptedAt: integer('accepted_at').notNull(),
    visibleAt: integer('visible_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('receive_operations_source_digest_unique').on(
      table.sourceKind,
      table.deduplicationKeyDigest,
    ),
    index('receive_operations_work_index').on(table.operationStatus, table.updatedAt, table.id),
  ],
)

export const receiveOperationRoutes = sqliteTable(
  'receive_operation_routes',
  {
    id: text('id').primaryKey().notNull(),
    receiveOperationId: text('receive_operation_id')
      .notNull()
      .references(() => receiveOperations.id, { onDelete: 'cascade' }),
    sequenceNumber: integer('sequence_number').notNull(),
    canonicalRecipientAddress: text('canonical_recipient_address').notNull(),
    displayRecipientAddress: text('display_recipient_address').notNull(),
    domainId: text('domain_id')
      .notNull()
      .references(() => mailDomains.id, { onDelete: 'restrict' }),
    addressId: text('address_id')
      .notNull()
      .references(() => emailAddresses.id, { onDelete: 'restrict' }),
    addressBindingId: text('address_binding_id')
      .notNull()
      .references(() => addressBindings.id, { onDelete: 'restrict' }),
    ownerType: text('owner_type').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'restrict' }),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    routeStatus: text('route_status').notNull(),
    rejectionCode: text('rejection_code'),
    deliveryId: text('delivery_id').references(() => messageDeliveries.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at').notNull(),
    committedAt: integer('committed_at'),
  },
  (table) => [
    unique('receive_operation_routes_sequence_unique').on(
      table.receiveOperationId,
      table.sequenceNumber,
    ),
    unique('receive_operation_routes_recipient_unique').on(
      table.receiveOperationId,
      table.canonicalRecipientAddress,
    ),
    index('receive_operation_routes_operation_index').on(
      table.receiveOperationId,
      table.routeStatus,
      table.sequenceNumber,
    ),
  ],
)

export const receiveOperationUnallocatedRoutes = sqliteTable(
  'receive_operation_unallocated_routes',
  {
    id: text('id').primaryKey().notNull(),
    receiveOperationId: text('receive_operation_id')
      .notNull()
      .unique()
      .references(() => receiveOperations.id, { onDelete: 'cascade' }),
    sequenceNumber: integer('sequence_number').notNull().default(0),
    canonicalRecipientAddress: text('canonical_recipient_address').notNull(),
    displayRecipientAddress: text('display_recipient_address').notNull(),
    domainId: text('domain_id')
      .notNull()
      .references(() => mailDomains.id, { onDelete: 'restrict' }),
    unallocatedPeriodId: text('unallocated_period_id')
      .notNull()
      .references(() => unallocatedAddressPeriods.id, { onDelete: 'restrict' }),
    routeStatus: text('route_status').notNull(),
    deliveryId: text('delivery_id')
      .unique()
      .references(() => unallocatedMessageDeliveries.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
    committedAt: integer('committed_at'),
  },
  (table) => [
    index('receive_operation_unallocated_routes_status_index').on(
      table.routeStatus,
      table.domainId,
      table.createdAt,
      table.id,
    ),
  ],
)

export const messageDeduplicationKeys = sqliteTable(
  'message_deduplication_keys',
  {
    sourceKind: text('source_kind').notNull(),
    keyDigest: blob('key_digest', { mode: 'buffer' }).notNull(),
    receiveOperationId: text('receive_operation_id')
      .notNull()
      .unique()
      .references(() => receiveOperations.id, { onDelete: 'restrict' }),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceKind, table.keyDigest] })],
)
