import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { users } from '../../identity/infrastructure/schema'
import { organizations } from '../../organizations/infrastructure/schema'

export const mailDomains = sqliteTable(
  'mail_domains',
  {
    id: text('id').primaryKey().notNull(),
    canonicalName: text('canonical_name').notNull().unique(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    catchAllMode: text('catch_all_mode').notNull().default('reject'),
    pausedAt: integer('paused_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('mail_domains_status_check', sql`${table.status} in ('active', 'paused', 'deleting')`),
    check(
      'mail_domains_catch_all_mode_check',
      sql`${table.catchAllMode} in ('reject', 'unallocated')`,
    ),
    check('mail_domains_name_length_check', sql`length(${table.canonicalName}) between 3 and 253`),
    check(
      'mail_domains_lowercase_check',
      sql`${table.canonicalName} = lower(${table.canonicalName})`,
    ),
    check('mail_domains_updated_at_check', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
)

export const emailAddresses = sqliteTable(
  'email_addresses',
  {
    id: text('id').primaryKey().notNull(),
    domainId: text('domain_id')
      .notNull()
      .references(() => mailDomains.id, { onDelete: 'restrict' }),
    displayAddress: text('display_address').notNull(),
    canonicalAddress: text('canonical_address').notNull(),
    publicLabel: text('public_label'),
    createdAt: integer('created_at').notNull(),
    retiredAt: integer('retired_at'),
  },
  (table) => [
    unique('email_addresses_identity_address_unique').on(table.id, table.canonicalAddress),
    index('email_addresses_domain_index').on(table.domainId, table.id),
    index('email_addresses_canonical_history_index').on(
      table.canonicalAddress,
      table.createdAt,
      table.id,
    ),
    check(
      'email_addresses_display_check',
      sql`${table.displayAddress} = ${table.canonicalAddress}`,
    ),
    check(
      'email_addresses_lowercase_check',
      sql`${table.canonicalAddress} = lower(${table.canonicalAddress})`,
    ),
    check('email_addresses_length_check', sql`length(${table.canonicalAddress}) between 3 and 320`),
  ],
)

export const addressClaims = sqliteTable(
  'address_claims',
  {
    canonicalAddress: text('canonical_address').primaryKey().notNull(),
    addressId: text('address_id').notNull().unique(),
    status: text('status').notNull(),
    reservedUntil: integer('reserved_until'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.addressId, table.canonicalAddress],
      foreignColumns: [emailAddresses.id, emailAddresses.canonicalAddress],
    }).onDelete('restrict'),
    index('address_claims_release_index').on(
      table.status,
      table.reservedUntil,
      table.canonicalAddress,
    ),
    check('address_claims_status_check', sql`${table.status} in ('active', 'reserved')`),
    check('address_claims_updated_at_check', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
)

export const addressBindings = sqliteTable(
  'address_bindings',
  {
    id: text('id').primaryKey().notNull(),
    addressId: text('address_id')
      .notNull()
      .references(() => emailAddresses.id, { onDelete: 'restrict' }),
    ownerType: text('owner_type').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'restrict' }),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    addressRole: text('address_role').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    endedReason: text('ended_reason'),
  },
  (table) => [
    uniqueIndex('address_bindings_current_address_unique')
      .on(table.addressId)
      .where(sql`${table.endedAt} is null`),
    uniqueIndex('address_bindings_current_primary_unique')
      .on(table.userId)
      .where(sql`${table.endedAt} is null and ${table.addressRole} = 'primary'`),
    uniqueIndex('address_bindings_current_organization_unique')
      .on(table.organizationId)
      .where(sql`${table.endedAt} is null and ${table.addressRole} = 'shared'`),
    index('address_bindings_current_user_index')
      .on(table.userId, table.addressRole, table.addressId)
      .where(sql`${table.endedAt} is null`),
    check('address_bindings_owner_type_check', sql`${table.ownerType} in ('user', 'organization')`),
    check(
      'address_bindings_role_check',
      sql`${table.addressRole} in ('primary', 'alias', 'shared')`,
    ),
  ],
)

export const userAddressPreferences = sqliteTable(
  'user_address_preferences',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addressId: text('address_id')
      .notNull()
      .references(() => emailAddresses.id, { onDelete: 'cascade' }),
    customLabel: text('custom_label'),
    isPinned: integer('is_pinned', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isDefaultSender: integer('is_default_sender', { mode: 'boolean' }).notNull().default(false),
    senderDisplayName: text('sender_display_name'),
    signatureFormat: text('signature_format'),
    signatureContent: text('signature_content'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.addressId] }),
    uniqueIndex('user_address_preferences_default_sender_unique')
      .on(table.userId)
      .where(sql`${table.isDefaultSender} = 1`),
    index('user_address_preferences_order_index').on(
      table.userId,
      table.isPinned,
      table.sortOrder,
      table.addressId,
    ),
  ],
)

export const userAliasPolicies = sqliteTable(
  'user_alias_policies',
  {
    userId: text('user_id')
      .primaryKey()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    aliasLimit: integer('alias_limit').notNull().default(20),
    selfCreationEnabled: integer('self_creation_enabled', { mode: 'boolean' })
      .notNull()
      .default(true),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('user_alias_policies_updated_index').on(table.updatedAt, table.userId),
    check('user_alias_policies_limit_check', sql`${table.aliasLimit} between 0 and 1000`),
    check('user_alias_policies_updated_at_check', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
)

export const addressPolicySettings = sqliteTable(
  'address_policy_settings',
  {
    singletonId: integer('singleton_id').primaryKey().notNull(),
    minimumLocalPartLength: integer('minimum_local_part_length').notNull().default(1),
    aliasRetentionDays: integer('alias_retention_days').notNull().default(0),
    policyVersion: integer('policy_version').notNull().default(1),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('address_policy_settings_singleton_check', sql`${table.singletonId} = 1`),
    check(
      'address_policy_settings_minimum_length_check',
      sql`${table.minimumLocalPartLength} between 1 and 64`,
    ),
    check(
      'address_policy_settings_retention_check',
      sql`${table.aliasRetentionDays} between 0 and 30`,
    ),
    check('address_policy_settings_version_check', sql`${table.policyVersion} >= 1`),
    check(
      'address_policy_settings_updated_at_check',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
)

export const addressPolicyTerms = sqliteTable(
  'address_policy_terms',
  {
    id: text('id').primaryKey().notNull(),
    termKind: text('term_kind').notNull(),
    normalizedValue: text('normalized_value').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('address_policy_terms_kind_value_unique').on(table.termKind, table.normalizedValue),
    index('address_policy_terms_kind_index').on(table.termKind, table.normalizedValue, table.id),
    check(
      'address_policy_terms_kind_check',
      sql`${table.termKind} in ('blocked_substring', 'reserved_name')`,
    ),
    check(
      'address_policy_terms_value_check',
      sql`length(${table.normalizedValue}) between 1 and 64 and ${table.normalizedValue} = lower(${table.normalizedValue}) and instr(${table.normalizedValue}, '@') = 0`,
    ),
  ],
)
