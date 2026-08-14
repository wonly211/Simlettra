import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from '../../identity/infrastructure/schema'

export const organizations = sqliteTable(
  'organizations',
  {
    id: text('id').primaryKey().notNull(),
    name: text('name').notNull(),
    creatorUserId: text('creator_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
    membersCanSend: integer('members_can_send', { mode: 'boolean' }).notNull().default(false),
    deletionRequestedAt: integer('deletion_requested_at'),
    deletionDueAt: integer('deletion_due_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('organizations_creator_index').on(table.creatorUserId, table.status, table.id),
    check('organizations_name_length_check', sql`length(${table.name}) between 1 and 120`),
    check(
      'organizations_status_check',
      sql`${table.status} in ('active', 'deletion_pending', 'deleting')`,
    ),
    check('organizations_updated_at_check', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
)

export const userOrganizationPolicies = sqliteTable(
  'user_organization_policies',
  {
    userId: text('user_id')
      .primaryKey()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationLimit: integer('organization_limit').notNull().default(5),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('user_organization_policies_updated_index').on(table.updatedAt, table.userId),
    check(
      'user_organization_policies_limit_check',
      sql`${table.organizationLimit} between 0 and 1000`,
    ),
    check(
      'user_organization_policies_updated_at_check',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
)

export const organizationMemberships = sqliteTable(
  'organization_memberships',
  {
    id: text('id').primaryKey().notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    joinedAt: integer('joined_at').notNull(),
    leftAt: integer('left_at'),
    leftReason: text('left_reason'),
  },
  (table) => [
    uniqueIndex('organization_memberships_current_unique')
      .on(table.organizationId, table.userId)
      .where(sql`${table.leftAt} is null`),
    index('organization_memberships_current_user_index')
      .on(table.userId, table.organizationId, table.id)
      .where(sql`${table.leftAt} is null`),
    index('organization_memberships_history_index').on(
      table.organizationId,
      table.joinedAt,
      table.id,
    ),
    check(
      'organization_memberships_left_reason_check',
      sql`${table.leftReason} is null or ${table.leftReason} in ('member_exited', 'creator_transferred', 'organization_deleted')`,
    ),
  ],
)

export const organizationInvitations = sqliteTable(
  'organization_invitations',
  {
    id: text('id').primaryKey().notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    invitedUserId: text('invited_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    invitedByUserId: text('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
    acceptedMembershipId: text('accepted_membership_id').references(
      () => organizationMemberships.id,
      { onDelete: 'set null' },
    ),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (table) => [
    uniqueIndex('organization_invitations_pending_unique')
      .on(table.organizationId, table.invitedUserId)
      .where(sql`${table.status} = 'pending'`),
    index('organization_invitations_user_index').on(
      table.invitedUserId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('organization_invitations_organization_index').on(
      table.organizationId,
      table.status,
      table.createdAt,
      table.id,
    ),
    check(
      'organization_invitations_status_check',
      sql`${table.status} in ('pending', 'accepted', 'rejected', 'revoked')`,
    ),
  ],
)
