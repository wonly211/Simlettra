import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core'
import { emailAddresses } from '../../addresses/infrastructure/schema'
import { users } from '../../identity/infrastructure/schema'
import { messageDeliveries, messages } from '../../mail-receiving/infrastructure/schema'
import {
  outboundRouteSnapshotEntries,
  outboundRouteSnapshots,
} from '../../sending/infrastructure/schema'

export const externalEmailTargets = sqliteTable(
  'external_email_targets',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    displayEmailAddress: text('display_email_address').notNull(),
    canonicalEmailAddress: text('canonical_email_address').notNull(),
    targetStatus: text('target_status').notNull(),
    verifiedAt: integer('verified_at'),
    disabledAt: integer('disabled_at'),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('external_email_targets_user_index').on(
      table.userId,
      table.targetStatus,
      table.createdAt,
      table.id,
    ),
  ],
)

export const externalEmailVerifications = sqliteTable('external_email_verifications', {
  id: text('id').primaryKey().notNull(),
  externalEmailTargetId: text('external_email_target_id')
    .notNull()
    .references(() => externalEmailTargets.id),
  verificationCodeHash: blob('verification_code_hash', { mode: 'buffer' }).notNull(),
  verificationCodeSalt: blob('verification_code_salt', { mode: 'buffer' }).notNull(),
  expiresAt: integer('expires_at').notNull(),
  maxFailureCount: integer('max_failure_count').notNull(),
  failureCount: integer('failure_count').notNull(),
  verificationStatus: text('verification_status').notNull(),
  outboundRouteSnapshotId: text('outbound_route_snapshot_id')
    .notNull()
    .references(() => outboundRouteSnapshots.id),
  deliveredAt: integer('delivered_at'),
  verifiedAt: integer('verified_at'),
  completedAt: integer('completed_at'),
  errorCode: text('error_code'),
  errorSummary: text('error_summary'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const externalEmailVerificationAttempts = sqliteTable(
  'external_email_verification_attempts',
  {
    id: text('id').primaryKey().notNull(),
    externalEmailVerificationId: text('external_email_verification_id')
      .notNull()
      .references(() => externalEmailVerifications.id),
    routeSnapshotEntryId: text('route_snapshot_entry_id')
      .notNull()
      .references(() => outboundRouteSnapshotEntries.id),
    attemptNumber: integer('attempt_number').notNull(),
    selectionKind: text('selection_kind').notNull(),
    fallbackReason: text('fallback_reason'),
    attemptStatus: text('attempt_status').notNull(),
    providerSubmissionId: text('provider_submission_id'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('external_email_verification_attempts_number_unique').on(
      table.externalEmailVerificationId,
      table.attemptNumber,
    ),
  ],
)

export const mailForwardingRules = sqliteTable(
  'mail_forwarding_rules',
  {
    id: text('id').primaryKey().notNull(),
    ruleKey: text('rule_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    externalEmailTargetId: text('external_email_target_id')
      .notNull()
      .references(() => externalEmailTargets.id),
    ruleVersion: integer('rule_version').notNull(),
    scopeKind: text('scope_kind').notNull(),
    ruleStatus: text('rule_status').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    supersededAt: integer('superseded_at'),
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    unique('mail_forwarding_rules_key_version_unique').on(table.ruleKey, table.ruleVersion),
  ],
)

export const mailForwardingRuleAddresses = sqliteTable(
  'mail_forwarding_rule_addresses',
  {
    mailForwardingRuleId: text('mail_forwarding_rule_id')
      .notNull()
      .references(() => mailForwardingRules.id),
    emailAddressId: text('email_address_id')
      .notNull()
      .references(() => emailAddresses.id),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.mailForwardingRuleId, table.emailAddressId] })],
)

export const mailForwardOperations = sqliteTable(
  'mail_forward_operations',
  {
    id: text('id').primaryKey().notNull(),
    sourceMessageId: text('source_message_id')
      .notNull()
      .references(() => messages.id),
    messageDeliveryId: text('message_delivery_id')
      .notNull()
      .references(() => messageDeliveries.id),
    mailForwardingRuleId: text('mail_forwarding_rule_id')
      .notNull()
      .references(() => mailForwardingRules.id),
    ruleVersion: integer('rule_version').notNull(),
    externalEmailTargetId: text('external_email_target_id')
      .notNull()
      .references(() => externalEmailTargets.id),
    senderAddress: text('sender_address').notNull(),
    targetCanonicalEmailAddress: text('target_canonical_email_address').notNull(),
    payloadSha256: blob('payload_sha256', { mode: 'buffer' }).notNull(),
    payloadSizeBytes: integer('payload_size_bytes').notNull(),
    forwardingHopCount: integer('forwarding_hop_count').notNull(),
    sourceMarkedBySimlettra: integer('source_marked_by_simlettra').notNull(),
    outboundRouteSnapshotId: text('outbound_route_snapshot_id').references(
      () => outboundRouteSnapshots.id,
    ),
    operationStatus: text('operation_status').notNull(),
    providerReference: text('provider_reference'),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [
    unique('mail_forward_operations_deduplication_unique').on(
      table.messageDeliveryId,
      table.mailForwardingRuleId,
      table.ruleVersion,
      table.externalEmailTargetId,
    ),
  ],
)

export const mailForwardAttempts = sqliteTable(
  'mail_forward_attempts',
  {
    id: text('id').primaryKey().notNull(),
    mailForwardOperationId: text('mail_forward_operation_id')
      .notNull()
      .references(() => mailForwardOperations.id),
    routeSnapshotEntryId: text('route_snapshot_entry_id')
      .notNull()
      .references(() => outboundRouteSnapshotEntries.id),
    attemptNumber: integer('attempt_number').notNull(),
    selectionKind: text('selection_kind').notNull(),
    fallbackReason: text('fallback_reason'),
    attemptStatus: text('attempt_status').notNull(),
    providerSubmissionId: text('provider_submission_id'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('mail_forward_attempts_number_unique').on(
      table.mailForwardOperationId,
      table.attemptNumber,
    ),
  ],
)
