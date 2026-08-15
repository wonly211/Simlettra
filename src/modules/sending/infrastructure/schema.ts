import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core'
import { mailDomains, emailAddresses, addressBindings } from '../../addresses/infrastructure/schema'
import { drafts } from '../../drafts/infrastructure/schema'
import { users } from '../../identity/infrastructure/schema'
import {
  messages,
  mailboxEntries,
  messageDeliveries,
  objectRegistry,
} from '../../mail-receiving/infrastructure/schema'
import { organizations } from '../../organizations/infrastructure/schema'

export const outboundProviderConfigs = sqliteTable(
  'outbound_provider_configs',
  {
    id: text('id').primaryKey().notNull(),
    configurationKey: text('configuration_key').notNull(),
    configurationVersion: integer('configuration_version').notNull(),
    displayName: text('display_name').notNull(),
    providerType: text('provider_type').notNull(),
    publicOptionsJson: text('public_options_json').notNull(),
    credentialCiphertext: blob('credential_ciphertext', { mode: 'buffer' }).notNull(),
    credentialNonce: blob('credential_nonce', { mode: 'buffer' }).notNull(),
    credentialAlgorithm: text('credential_algorithm').notNull(),
    credentialKeyVersion: integer('credential_key_version').notNull(),
    credentialUpdatedAt: integer('credential_updated_at').notNull(),
    configurationStatus: text('configuration_status').notNull(),
    lastTestedAt: integer('last_tested_at'),
    lastTestResult: text('last_test_result'),
    lastTestSummary: text('last_test_summary'),
    disabledAt: integer('disabled_at'),
    retiredAt: integer('retired_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('outbound_provider_configs_key_version_unique').on(
      table.configurationKey,
      table.configurationVersion,
    ),
  ],
)

export const domainOutboundRoutes = sqliteTable(
  'domain_outbound_routes',
  {
    id: text('id').primaryKey().notNull(),
    mailDomainId: text('mail_domain_id')
      .notNull()
      .references(() => mailDomains.id),
    routeVersion: integer('route_version').notNull(),
    routeStatus: text('route_status').notNull(),
    createdAt: integer('created_at').notNull(),
    activatedAt: integer('activated_at'),
    supersededAt: integer('superseded_at'),
    disabledAt: integer('disabled_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('domain_outbound_routes_domain_index').on(table.mailDomainId, table.routeVersion),
  ],
)

export const domainOutboundRouteEntries = sqliteTable(
  'domain_outbound_route_entries',
  {
    id: text('id').primaryKey().notNull(),
    routeId: text('route_id')
      .notNull()
      .references(() => domainOutboundRoutes.id),
    priorityNumber: integer('priority_number').notNull(),
    providerConfigId: text('provider_config_id')
      .notNull()
      .references(() => outboundProviderConfigs.id),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('domain_outbound_route_entries_priority_unique').on(table.routeId, table.priorityNumber),
  ],
)

export const outboundRouteSnapshots = sqliteTable('outbound_route_snapshots', {
  id: text('id').primaryKey().notNull(),
  mailDomainId: text('mail_domain_id')
    .notNull()
    .references(() => mailDomains.id),
  sourceRouteId: text('source_route_id')
    .notNull()
    .references(() => domainOutboundRoutes.id),
  sourceRouteVersion: integer('source_route_version').notNull(),
  executionKind: text('execution_kind').notNull(),
  executionReference: text('execution_reference').notNull(),
  payloadSha256: blob('payload_sha256', { mode: 'buffer' }).notNull(),
  payloadSizeBytes: integer('payload_size_bytes').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const outboundRouteSnapshotEntries = sqliteTable(
  'outbound_route_snapshot_entries',
  {
    id: text('id').primaryKey().notNull(),
    routeSnapshotId: text('route_snapshot_id')
      .notNull()
      .references(() => outboundRouteSnapshots.id),
    priorityNumber: integer('priority_number').notNull(),
    providerConfigId: text('provider_config_id')
      .notNull()
      .references(() => outboundProviderConfigs.id),
    configurationKey: text('configuration_key').notNull(),
    configurationVersion: integer('configuration_version').notNull(),
    providerType: text('provider_type').notNull(),
    effectiveSizeLimitBytes: integer('effective_size_limit_bytes').notNull(),
    providerOptionsDigest: blob('provider_options_digest', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('outbound_route_snapshot_entries_priority_unique').on(
      table.routeSnapshotId,
      table.priorityNumber,
    ),
  ],
)

export const quotaPolicies = sqliteTable('quota_policies', {
  id: text('id').primaryKey().notNull(),
  quotaKind: text('quota_kind').notNull(),
  scopeType: text('scope_type').notNull(),
  userId: text('user_id').references(() => users.id),
  mailDomainId: text('mail_domain_id').references(() => mailDomains.id),
  policyVersion: integer('policy_version').notNull(),
  limitValue: integer('limit_value'),
  policyStatus: text('policy_status').notNull(),
  effectiveAt: integer('effective_at').notNull(),
  retiredAt: integer('retired_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const domainMonthlyUsagePeriods = sqliteTable(
  'domain_monthly_usage_periods',
  {
    id: text('id').primaryKey().notNull(),
    mailDomainId: text('mail_domain_id')
      .notNull()
      .references(() => mailDomains.id),
    periodStartAt: integer('period_start_at').notNull(),
    periodEndAt: integer('period_end_at').notNull(),
    timezoneName: text('timezone_name').notNull(),
    quotaPolicyId: text('quota_policy_id')
      .notNull()
      .references(() => quotaPolicies.id),
    quotaLimitSnapshot: integer('quota_limit_snapshot'),
    committedUnits: integer('committed_units').notNull(),
    reservedUnits: integer('reserved_units').notNull(),
    unknownHeldUnits: integer('unknown_held_units').notNull(),
    periodStatus: text('period_status').notNull(),
    closedAt: integer('closed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('domain_monthly_usage_periods_domain_start_unique').on(
      table.mailDomainId,
      table.periodStartAt,
    ),
  ],
)

export const sendOperations = sqliteTable(
  'send_operations',
  {
    id: text('id').primaryKey().notNull(),
    operatorUserId: text('operator_user_id')
      .notNull()
      .references(() => users.id),
    sourceDraftId: text('source_draft_id').references(() => drafts.id),
    sourceDraftReference: text('source_draft_reference').notNull(),
    sourceDraftRevisionNumber: integer('source_draft_revision_number').notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id),
    sentMailboxEntryId: text('sent_mailbox_entry_id')
      .notNull()
      .references(() => mailboxEntries.id),
    senderAddressId: text('sender_address_id')
      .notNull()
      .references(() => emailAddresses.id),
    senderAddressBindingId: text('sender_address_binding_id')
      .notNull()
      .references(() => addressBindings.id),
    sentMailboxType: text('sent_mailbox_type').notNull(),
    sentUserId: text('sent_user_id').references(() => users.id),
    sentOrganizationId: text('sent_organization_id').references(() => organizations.id),
    composeKind: text('compose_kind').notNull(),
    sourceMessageId: text('source_message_id').references(() => messages.id),
    sourceReference: text('source_reference'),
    recipientCount: integer('recipient_count').notNull(),
    internalRecipientCount: integer('internal_recipient_count').notNull(),
    externalRecipientCount: integer('external_recipient_count').notNull(),
    quotaRecipientUnits: integer('quota_recipient_units').notNull(),
    payloadSha256: blob('payload_sha256', { mode: 'buffer' }).notNull(),
    payloadSizeBytes: integer('payload_size_bytes').notNull(),
    effectiveSizeLimitBytes: integer('effective_size_limit_bytes').notNull(),
    outboundRouteSnapshotId: text('outbound_route_snapshot_id').references(
      () => outboundRouteSnapshots.id,
    ),
    workflowStatus: text('workflow_status').notNull(),
    acceptedAt: integer('accepted_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finalMimeObjectId: text('final_mime_object_id')
      .notNull()
      .references(() => objectRegistry.id),
    payloadGeneratorVersion: text('payload_generator_version').notNull(),
  },
  (table) => [
    index('send_operations_operator_index').on(table.operatorUserId, table.acceptedAt, table.id),
  ],
)

export const sendIdempotencyKeys = sqliteTable(
  'send_idempotency_keys',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    requestKeyDigest: blob('request_key_digest', { mode: 'buffer' }).notNull(),
    inputDigest: blob('input_digest', { mode: 'buffer' }).notNull(),
    sendOperationId: text('send_operation_id')
      .notNull()
      .references(() => sendOperations.id),
    acceptedAt: integer('accepted_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.requestKeyDigest] })],
)

export const sendRecipients = sqliteTable(
  'send_recipients',
  {
    id: text('id').primaryKey().notNull(),
    sendOperationId: text('send_operation_id')
      .notNull()
      .references(() => sendOperations.id),
    recipientRole: text('recipient_role').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    displayName: text('display_name'),
    addressText: text('address_text').notNull(),
    canonicalAddress: text('canonical_address').notNull(),
    deduplicationKey: blob('deduplication_key', { mode: 'buffer' }).notNull(),
    routeChannel: text('route_channel').notNull(),
    messageDeliveryId: text('message_delivery_id').references(() => messageDeliveries.id),
    deliveryStatus: text('delivery_status').notNull(),
    statusVersion: integer('status_version').notNull(),
    statusUpdatedAt: integer('status_updated_at').notNull(),
    failureCode: text('failure_code'),
    failureDetail: text('failure_detail'),
    complainedAt: integer('complained_at'),
    lastProviderReference: text('last_provider_reference'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('send_recipients_operation_sequence_unique').on(
      table.sendOperationId,
      table.recipientRole,
      table.sequenceNumber,
    ),
  ],
)

export const sendRecipientStatusHistory = sqliteTable('send_recipient_status_history', {
  id: text('id').primaryKey().notNull(),
  sendRecipientId: text('send_recipient_id')
    .notNull()
    .references(() => sendRecipients.id),
  previousStatus: text('previous_status'),
  newStatus: text('new_status').notNull(),
  statusVersion: integer('status_version').notNull(),
  sourceType: text('source_type').notNull(),
  sourceReference: text('source_reference').notNull(),
  occurredAt: integer('occurred_at').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const sendRecipientRouteProgress = sqliteTable('send_recipient_route_progress', {
  sendRecipientId: text('send_recipient_id')
    .primaryKey()
    .notNull()
    .references(() => sendRecipients.id),
  routeSnapshotId: text('route_snapshot_id')
    .notNull()
    .references(() => outboundRouteSnapshots.id),
  nextPriorityNumber: integer('next_priority_number').notNull(),
  selectedRouteSnapshotEntryId: text('selected_route_snapshot_entry_id').references(
    () => outboundRouteSnapshotEntries.id,
  ),
  progressStatus: text('progress_status').notNull(),
  lastAttemptId: text('last_attempt_id'),
  lastSwitchReason: text('last_switch_reason'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const outboundSubmissionAttempts = sqliteTable('outbound_submission_attempts', {
  id: text('id').primaryKey().notNull(),
  sendOperationId: text('send_operation_id')
    .notNull()
    .references(() => sendOperations.id),
  routeSnapshotEntryId: text('route_snapshot_entry_id')
    .notNull()
    .references(() => outboundRouteSnapshotEntries.id),
  attemptNumber: integer('attempt_number').notNull(),
  attemptStatus: text('attempt_status').notNull(),
  payloadSha256: blob('payload_sha256', { mode: 'buffer' }).notNull(),
  payloadSizeBytes: integer('payload_size_bytes').notNull(),
  idempotencyKeyDigest: blob('idempotency_key_digest', { mode: 'buffer' }),
  providerSubmissionId: text('provider_submission_id'),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
  errorCode: text('error_code'),
  errorSummary: text('error_summary'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const outboundSubmissionAttemptRecipients = sqliteTable(
  'outbound_submission_attempt_recipients',
  {
    outboundSubmissionAttemptId: text('outbound_submission_attempt_id')
      .notNull()
      .references(() => outboundSubmissionAttempts.id),
    sendRecipientId: text('send_recipient_id')
      .notNull()
      .references(() => sendRecipients.id),
    selectionKind: text('selection_kind').notNull(),
    fallbackReason: text('fallback_reason'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.outboundSubmissionAttemptId, table.sendRecipientId] })],
)

export const outboundProviderEvents = sqliteTable('outbound_provider_events', {
  id: text('id').primaryKey().notNull(),
  providerType: text('provider_type').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  normalizedEventType: text('normalized_event_type').notNull(),
  occurredAt: integer('occurred_at').notNull(),
  receivedAt: integer('received_at').notNull(),
  verifiedAt: integer('verified_at').notNull(),
  rawSha256: blob('raw_sha256', { mode: 'buffer' }).notNull(),
  diagnosticCode: text('diagnostic_code'),
  diagnosticSummary: text('diagnostic_summary'),
  outboundSubmissionAttemptId: text('outbound_submission_attempt_id').references(
    () => outboundSubmissionAttempts.id,
  ),
  sendRecipientId: text('send_recipient_id').references(() => sendRecipients.id),
  matchStatus: text('match_status').notNull(),
  processingResult: text('processing_result').notNull(),
  processedAt: integer('processed_at'),
  createdAt: integer('created_at').notNull(),
})

export const domainMonthlyUsageReservations = sqliteTable('domain_monthly_usage_reservations', {
  id: text('id').primaryKey().notNull(),
  domainMonthlyUsagePeriodId: text('domain_monthly_usage_period_id')
    .notNull()
    .references(() => domainMonthlyUsagePeriods.id),
  sendRecipientId: text('send_recipient_id')
    .notNull()
    .references(() => sendRecipients.id),
  usageStatus: text('usage_status').notNull(),
  reservedAt: integer('reserved_at').notNull(),
  committedAt: integer('committed_at'),
  releasedAt: integer('released_at'),
  unknownAt: integer('unknown_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
