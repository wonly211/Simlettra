import { sql } from 'drizzle-orm'
import { blob, check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { mailDomains } from '../../addresses/infrastructure/schema'
import { users } from '../../identity/infrastructure/schema'

export const accountRegistrationInvitations = sqliteTable(
  'account_registration_invitations',
  {
    id: text('id').primaryKey().notNull(),
    codeDigest: blob('code_digest', { mode: 'buffer' }).notNull(),
    codeCiphertext: blob('code_ciphertext', { mode: 'buffer' }).notNull(),
    codeNonce: blob('code_nonce', { mode: 'buffer' }).notNull(),
    encryptionAlgorithm: text('encryption_algorithm').notNull(),
    encryptionKeyVersion: integer('encryption_key_version').notNull(),
    domainId: text('domain_id').references(() => mailDomains.id, { onDelete: 'set null' }),
    domainNameSnapshot: text('domain_name_snapshot').notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    unique('account_registration_invitations_code_digest_unique').on(table.codeDigest),
    index('account_registration_invitations_state_index').on(
      table.revokedAt,
      table.createdAt,
      table.id,
    ),
    index('account_registration_invitations_domain_index').on(
      table.domainId,
      table.createdAt,
      table.id,
    ),
    check(
      'account_registration_invitations_code_digest_length_check',
      sql`length(${table.codeDigest}) = 32`,
    ),
    check(
      'account_registration_invitations_nonce_length_check',
      sql`length(${table.codeNonce}) = 12`,
    ),
    check(
      'account_registration_invitations_algorithm_check',
      sql`${table.encryptionAlgorithm} = 'AES-GCM-256'`,
    ),
    check(
      'account_registration_invitations_key_version_check',
      sql`${table.encryptionKeyVersion} = 1`,
    ),
  ],
)

export const accountRegistrationInvitationConsumptions = sqliteTable(
  'account_registration_invitation_consumptions',
  {
    id: text('id').primaryKey().notNull(),
    invitationId: text('invitation_id')
      .notNull()
      .references(() => accountRegistrationInvitations.id, { onDelete: 'restrict' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    userDisplayNameSnapshot: text('user_display_name_snapshot').notNull(),
    primaryAddressSnapshot: text('primary_address_snapshot').notNull(),
    consumedAt: integer('consumed_at').notNull(),
  },
  (table) => [
    unique('account_registration_invitation_consumptions_invitation_unique').on(table.invitationId),
    unique('account_registration_invitation_consumptions_user_unique').on(table.userId),
  ],
)

export const accountRegistrationRateLimits = sqliteTable(
  'account_registration_rate_limits',
  {
    sourceKeyDigest: blob('source_key_digest', { mode: 'buffer' }).primaryKey().notNull(),
    windowStartedAt: integer('window_started_at').notNull(),
    failureCount: integer('failure_count').notNull(),
    blockedUntil: integer('blocked_until'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('account_registration_rate_limits_expiry_index').on(table.blockedUntil, table.updatedAt),
    check(
      'account_registration_rate_limits_digest_length_check',
      sql`length(${table.sourceKeyDigest}) = 32`,
    ),
    check('account_registration_rate_limits_failure_count_check', sql`${table.failureCount} >= 0`),
  ],
)
