import type {
  AdministratorOrganizationPolicyUser,
  CreateOrganizationRequest,
  OrganizationDomainSummary,
  OrganizationInvitationPolicy,
  OrganizationInvitationSummary,
  OrganizationMemberSummary,
  OrganizationPolicySummary,
  OrganizationSummary,
} from '../../../shared/contracts/organization-management'
import {
  AddressPolicyInputError,
  readAddressPolicySnapshot,
  validateLocalPartAgainstAddressPolicy,
} from '../../addresses/application/address-policy-management'
import { AddressValidationError, normalizeEmailAddress } from '../../addresses/domain/email-address'
import {
  createAuditEventStatement,
  createOrganizationInvitationGuardedAuditEventStatement,
  createOrganizationMembershipExitGuardedAuditEventStatement,
  createOrganizationStateGuardedAuditEventStatement,
  createUserInvitationPolicyGuardedAuditEventStatement,
  createUserOrganizationPolicyGuardedAuditEventStatement,
  type AuditContext,
} from '../../audit/public'
import { sha256Bytes } from '../../mail-receiving/domain/content-digest'

const ORGANIZATION_RECOVERY_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const ORGANIZATION_DELETION_POLICY_VERSION = 1

export interface OrganizationActor {
  userId: string
  isAdministrator: boolean
}

type OrganizationInputField =
  | keyof CreateOrganizationRequest
  | 'primaryAddress'
  | 'invitationPolicy'
  | 'membersCanSend'
  | 'organizationLimit'
  | 'successorUserId'

interface OrganizationRow {
  id: string
  name: string
  status: string
  creator_user_id: string
  members_can_send: number
  deletion_due_at: number | null
  created_at: number
  updated_at: number
  address_id: string
  canonical_address: string
  actor_membership_id: string | null
}

interface OrganizationMemberRow {
  membership_id: string
  user_id: string
  display_name: string
  canonical_address: string
  joined_at: number
}

interface OrganizationInvitationRow {
  id: string
  organization_id: string
  organization_name: string
  canonical_address: string
  invited_user_id: string
  invited_user_display_name: string
  invited_user_address: string
  invited_by_user_id: string
  invited_by_display_name: string
  status: string
  created_at: number
  resolved_at: number | null
}

interface OrganizationPolicyRow {
  user_id: string
  display_name: string
  user_status: string
  canonical_address: string
  organization_limit: number
  owned_organization_count: number
  updated_at: number
}

interface ActiveDomainRow {
  id: string
  display_name: string
  canonical_name: string
}

interface InvitedUserRow {
  id: string
  display_name: string
  invitation_policy: string
  canonical_address: string
}

interface InvitationTargetRow {
  id: string
  organization_id: string
  invited_user_id: string
  status: string
  created_at: number
}

interface CurrentMembershipRow {
  membership_id: string
  organization_id: string
  user_id: string
  joined_at: number
  organization_name: string
  organization_status: string
  creator_user_id: string
  members_can_send: number
  deletion_due_at: number | null
  organization_updated_at: number
}

export class OrganizationInputError extends Error {
  constructor(
    readonly field: OrganizationInputField,
    message: string,
  ) {
    super(message)
  }
}

export class OrganizationPermissionError extends Error {
  constructor(message = '无权管理该组织') {
    super(message)
  }
}

export class OrganizationCreationError extends Error {
  constructor(
    readonly code:
      | 'organization_quota_exceeded'
      | 'address_unavailable'
      | 'domain_unavailable'
      | 'user_unavailable'
      | 'creation_conflict',
    message: string,
    readonly field: 'localPart' | 'domainId' | null = null,
  ) {
    super(message)
  }
}

export class OrganizationTargetError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'state_conflict'
      | 'successor_required'
      | 'successor_unavailable'
      | 'successor_quota_exceeded'
      | 'recovery_expired',
    message: string,
    readonly field: 'successorUserId' | null = null,
  ) {
    super(message)
  }
}

export class OrganizationInvitationError extends Error {
  constructor(
    readonly code:
      | 'user_not_found'
      | 'self_invitation'
      | 'already_member'
      | 'invitation_exists'
      | 'invitation_not_found'
      | 'invitation_conflict',
    message: string,
    readonly field: 'primaryAddress' | null = null,
  ) {
    super(message)
  }
}

export async function getOrganizationOverview(options: {
  database: D1Database
  actor: OrganizationActor
}): Promise<{
  invitationPolicy: OrganizationInvitationPolicy
  policy: OrganizationPolicySummary
  activeDomains: OrganizationDomainSummary[]
  organizations: OrganizationSummary[]
  pendingInvitations: OrganizationInvitationSummary[]
}> {
  const [policyUser, activeDomains, organizationRows, pendingInvitations, invitationPolicy] =
    await Promise.all([
      findOrganizationPolicyUser(options.database, options.actor.userId),
      listActiveDomains(options.database),
      listOrganizationRows(options.database, options.actor.userId),
      listPendingInvitationsForUser(options.database, options.actor.userId),
      findInvitationPolicy(options.database, options.actor.userId),
    ])

  if (!policyUser || !invitationPolicy) {
    throw new OrganizationTargetError('not_found', '当前用户没有可用的组织策略')
  }

  return {
    invitationPolicy,
    policy: organizationPolicyFromRow(policyUser),
    activeDomains: activeDomains.map(domainSummary),
    organizations: await Promise.all(
      organizationRows.map((row) =>
        organizationSummaryFromRow(options.database, row, options.actor),
      ),
    ),
    pendingInvitations,
  }
}

export async function createOrganization(options: {
  database: D1Database
  actor: OrganizationActor
  input: CreateOrganizationRequest
  audit: AuditContext
  now?: number
}): Promise<OrganizationSummary> {
  const policy = await findOrganizationPolicyUser(options.database, options.actor.userId)
  if (!policy || policy.user_status !== 'active') {
    throw new OrganizationCreationError('user_unavailable', '当前用户不能创建组织')
  }
  if (policy.owned_organization_count >= policy.organization_limit) {
    throw new OrganizationCreationError('organization_quota_exceeded', '组织创建额度已用完')
  }

  const name = normalizeOrganizationName(options.input.name)
  const domain = await findActiveDomain(options.database, options.input.domainId)
  if (!domain) {
    throw new OrganizationCreationError(
      'domain_unavailable',
      '请选择当前已启用的邮件域名',
      'domainId',
    )
  }

  let address
  try {
    address = normalizeEmailAddress(options.input.localPart, domain.canonical_name)
    validateLocalPartAgainstAddressPolicy(
      address.localPart,
      await readAddressPolicySnapshot(options.database),
    )
  } catch (error) {
    if (error instanceof AddressValidationError || error instanceof AddressPolicyInputError) {
      throw new OrganizationInputError('localPart', error.message)
    }
    throw error
  }

  const existingClaim = await options.database
    .prepare('SELECT 1 FROM address_claims WHERE canonical_address = ?1 COLLATE NOCASE LIMIT 1')
    .bind(address.canonicalAddress)
    .first()
  if (existingClaim) {
    throw new OrganizationCreationError(
      'address_unavailable',
      '该邮箱地址已经被使用或保留',
      'localPart',
    )
  }

  const now = options.now ?? Date.now()
  const organizationId = crypto.randomUUID()
  const membershipId = crypto.randomUUID()
  const addressId = crypto.randomUUID()
  const bindingId = crypto.randomUUID()

  try {
    const results = await options.database.batch([
      options.database
        .prepare(
          `INSERT INTO organizations (
            id, name, creator_user_id, status, members_can_send,
            deletion_requested_at, deletion_due_at, created_at, updated_at
           ) VALUES (?1, ?2, ?3, 'active', 0, NULL, NULL, ?4, ?4)`,
        )
        .bind(organizationId, name, options.actor.userId, now),
      options.database
        .prepare(
          `INSERT INTO organization_memberships (
            id, organization_id, user_id, joined_at, left_at, left_reason
           ) VALUES (?1, ?2, ?3, ?4, NULL, NULL)`,
        )
        .bind(membershipId, organizationId, options.actor.userId, now),
      options.database
        .prepare(
          `INSERT INTO email_addresses (
            id, domain_id, display_address, canonical_address, created_at
           ) VALUES (?1, ?2, ?3, ?3, ?4)`,
        )
        .bind(addressId, domain.id, address.canonicalAddress, now),
      options.database
        .prepare(
          `INSERT INTO address_claims (
            canonical_address, address_id, status, reserved_until, created_at, updated_at
           ) VALUES (?1, ?2, 'active', NULL, ?3, ?3)`,
        )
        .bind(address.canonicalAddress, addressId, now),
      options.database
        .prepare(
          `INSERT INTO address_bindings (
            id, address_id, owner_type, user_id, organization_id,
            address_role, started_at, ended_at, ended_reason
           ) VALUES (?1, ?2, 'organization', NULL, ?3, 'shared', ?4, NULL, NULL)`,
        )
        .bind(bindingId, addressId, organizationId, now),
      createAuditEventStatement(options.database, {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'organization.created',
        targetType: 'organization',
        targetReference: organizationId,
        outcome: 'succeeded',
        reasonCode: 'user_requested',
        occurredAt: now,
      }),
    ])
    if (
      (results[0]?.meta.changes ?? 0) < 1 ||
      results.slice(1).some((result) => result.meta.changes !== 1)
    ) {
      throw new OrganizationCreationError('creation_conflict', '组织数据没有完整建立')
    }
  } catch (error) {
    if (error instanceof OrganizationCreationError) throw error
    if (isQuotaConstraint(error)) {
      throw new OrganizationCreationError('organization_quota_exceeded', '组织创建额度已用完')
    }
    if (isConstraintError(error)) {
      throw new OrganizationCreationError(
        'address_unavailable',
        '该邮箱地址已经被使用或组织数据发生冲突',
        'localPart',
      )
    }
    throw error
  }

  return requireOrganizationSummary(options.database, organizationId, options.actor)
}

export async function updateInvitationPolicy(options: {
  database: D1Database
  actor: OrganizationActor
  invitationPolicy: OrganizationInvitationPolicy
  audit: AuditContext
  now?: number
}): Promise<OrganizationInvitationPolicy> {
  if (!isInvitationPolicy(options.invitationPolicy)) {
    throw new OrganizationInputError('invitationPolicy', '请选择有效的组织邀请策略')
  }
  const user = await options.database
    .prepare('SELECT status, invitation_policy, updated_at FROM users WHERE id = ?1 LIMIT 1')
    .bind(options.actor.userId)
    .first<{ status: string; invitation_policy: string; updated_at: number }>()
  if (!user || user.status !== 'active') {
    throw new OrganizationTargetError('not_found', '当前用户不可用')
  }
  if (user.invitation_policy === options.invitationPolicy) return options.invitationPolicy

  const now = Math.max(options.now ?? Date.now(), user.updated_at + 1)
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE users SET invitation_policy = ?1, updated_at = ?2
         WHERE id = ?3 AND status = 'active' AND updated_at = ?4`,
      )
      .bind(options.invitationPolicy, now, options.actor.userId, user.updated_at),
    createUserInvitationPolicyGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'organization.invitation_policy_updated',
        targetType: 'user',
        targetReference: options.actor.userId,
        outcome: 'succeeded',
        reasonCode: 'user_requested',
        occurredAt: now,
      },
      {
        userId: options.actor.userId,
        invitationPolicy: options.invitationPolicy,
        updatedAt: now,
      },
    ),
  ])
  requireTwoChanges(results, '邀请策略已经发生变化，请刷新后重试')
  return options.invitationPolicy
}

export async function createOrganizationInvitation(options: {
  database: D1Database
  actor: OrganizationActor
  organizationId: string
  primaryAddress: string
  audit: AuditContext
  now?: number
}): Promise<{
  invitation: OrganizationInvitationSummary
  outcome: 'pending' | 'accepted' | 'rejected'
}> {
  const organization = await requireCreatorOrganization(
    options.database,
    options.organizationId,
    options.actor.userId,
  )
  const canonicalAddress = normalizePrimaryAddressInput(options.primaryAddress)
  const invitedUser = await findActiveUserByPrimaryAddress(options.database, canonicalAddress)
  if (!invitedUser) {
    throw new OrganizationInvitationError(
      'user_not_found',
      '没有找到该主邮箱对应的有效用户',
      'primaryAddress',
    )
  }
  if (invitedUser.id === options.actor.userId) {
    throw new OrganizationInvitationError(
      'self_invitation',
      '创建者已经是组织成员',
      'primaryAddress',
    )
  }
  if (await hasCurrentMembership(options.database, organization.id, invitedUser.id)) {
    throw new OrganizationInvitationError(
      'already_member',
      '该用户已经是组织成员',
      'primaryAddress',
    )
  }
  if (await hasPendingInvitation(options.database, organization.id, invitedUser.id)) {
    throw new OrganizationInvitationError(
      'invitation_exists',
      '该用户已有一份待处理邀请',
      'primaryAddress',
    )
  }

  const invitationId = crypto.randomUUID()
  const membershipId = crypto.randomUUID()
  const now = options.now ?? Date.now()
  const outcome = invitationOutcome(invitedUser.invitation_policy)
  const statements: D1PreparedStatement[] = []

  if (outcome === 'accepted') {
    statements.push(
      options.database
        .prepare(
          `INSERT INTO organization_memberships (
            id, organization_id, user_id, joined_at, left_at, left_reason
           ) VALUES (?1, ?2, ?3, ?4, NULL, NULL)`,
        )
        .bind(membershipId, organization.id, invitedUser.id, now),
    )
  }

  statements.push(
    options.database
      .prepare(
        `INSERT INTO organization_invitations (
          id, organization_id, invited_user_id, invited_by_user_id,
          status, accepted_membership_id, created_at, resolved_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        invitationId,
        organization.id,
        invitedUser.id,
        options.actor.userId,
        outcome,
        outcome === 'accepted' ? membershipId : null,
        now,
        outcome === 'pending' ? null : now,
      ),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actor.userId,
      actionName:
        outcome === 'accepted'
          ? 'organization.member_auto_joined'
          : outcome === 'rejected'
            ? 'organization.invitation_rejected_by_preference'
            : 'organization.invitation_created',
      targetType: 'organization_invitation',
      targetReference: invitationId,
      outcome: 'succeeded',
      reasonCode: invitedUser.invitation_policy,
      occurredAt: now,
    }),
  )

  try {
    const results = await options.database.batch(statements)
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new OrganizationInvitationError(
        'invitation_conflict',
        '组织邀请已经发生变化，请刷新后重试',
      )
    }
  } catch (error) {
    if (error instanceof OrganizationInvitationError) throw error
    if (isConstraintError(error)) {
      throw new OrganizationInvitationError(
        'invitation_conflict',
        '该用户已经加入组织或邀请状态已发生变化',
      )
    }
    throw error
  }

  const invitation = await findInvitationSummary(options.database, invitationId)
  if (!invitation)
    throw new OrganizationInvitationError('invitation_conflict', '邀请记录未能完整建立')
  return { invitation, outcome }
}

export async function resolveOrganizationInvitation(options: {
  database: D1Database
  actor: OrganizationActor
  invitationId: string
  decision: 'accepted' | 'rejected'
  audit: AuditContext
  now?: number
}): Promise<{ invitationId: string; status: 'accepted' | 'rejected' }> {
  const invitation = await findPendingInvitationForUser(
    options.database,
    options.invitationId,
    options.actor.userId,
  )
  if (!invitation) {
    throw new OrganizationInvitationError('invitation_not_found', '该邀请不存在或已经处理')
  }
  const now = Math.max(options.now ?? Date.now(), invitation.created_at)
  const membershipId = options.decision === 'accepted' ? crypto.randomUUID() : null
  const statements: D1PreparedStatement[] = []
  if (membershipId) {
    statements.push(
      options.database
        .prepare(
          `INSERT INTO organization_memberships (
            id, organization_id, user_id, joined_at, left_at, left_reason
           )
           SELECT ?1, ?2, ?3, ?4, NULL, NULL
           WHERE EXISTS (
             SELECT 1 FROM organization_invitations
             WHERE id = ?5 AND invited_user_id = ?3 AND status = 'pending'
           )`,
        )
        .bind(membershipId, invitation.organization_id, options.actor.userId, now, invitation.id),
    )
  }
  statements.push(
    options.database
      .prepare(
        `UPDATE organization_invitations
         SET status = ?1, accepted_membership_id = ?2, resolved_at = ?3
         WHERE id = ?4 AND invited_user_id = ?5 AND status = 'pending'`,
      )
      .bind(options.decision, membershipId, now, invitation.id, options.actor.userId),
    createOrganizationInvitationGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName:
          options.decision === 'accepted'
            ? 'organization.invitation_accepted'
            : 'organization.invitation_rejected',
        targetType: 'organization_invitation',
        targetReference: invitation.id,
        outcome: 'succeeded',
        reasonCode: 'recipient_requested',
        occurredAt: now,
      },
      {
        invitationId: invitation.id,
        status: options.decision,
        acceptedMembershipId: membershipId,
        resolvedAt: now,
      },
    ),
  )

  try {
    const results = await options.database.batch(statements)
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new OrganizationInvitationError('invitation_conflict', '该邀请已经被处理，请刷新后查看')
    }
  } catch (error) {
    if (error instanceof OrganizationInvitationError) throw error
    if (isConstraintError(error)) {
      throw new OrganizationInvitationError(
        'invitation_conflict',
        '该邀请已经被处理或成员资格已发生变化',
      )
    }
    throw error
  }
  return { invitationId: invitation.id, status: options.decision }
}

export async function revokeOrganizationInvitation(options: {
  database: D1Database
  actor: OrganizationActor
  organizationId: string
  invitationId: string
  audit: AuditContext
  now?: number
}): Promise<{ invitationId: string; status: 'revoked' }> {
  await requireCreatorOrganization(options.database, options.organizationId, options.actor.userId)
  const invitation = await options.database
    .prepare(
      `SELECT id, organization_id, invited_user_id, status, created_at
       FROM organization_invitations
       WHERE id = ?1 AND organization_id = ?2 AND status = 'pending' LIMIT 1`,
    )
    .bind(options.invitationId, options.organizationId)
    .first<InvitationTargetRow>()
  if (!invitation) {
    throw new OrganizationInvitationError('invitation_not_found', '该邀请不存在或已经处理')
  }
  const now = Math.max(options.now ?? Date.now(), invitation.created_at)
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE organization_invitations
         SET status = 'revoked', accepted_membership_id = NULL, resolved_at = ?1
         WHERE id = ?2 AND organization_id = ?3 AND status = 'pending'`,
      )
      .bind(now, invitation.id, options.organizationId),
    createOrganizationInvitationGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'organization.invitation_revoked',
        targetType: 'organization_invitation',
        targetReference: invitation.id,
        outcome: 'succeeded',
        reasonCode: 'creator_requested',
        occurredAt: now,
      },
      {
        invitationId: invitation.id,
        status: 'revoked',
        acceptedMembershipId: null,
        resolvedAt: now,
      },
    ),
  ])
  requireTwoChanges(results, '该邀请已经被处理，请刷新后查看')
  return { invitationId: invitation.id, status: 'revoked' }
}

export async function updateOrganizationSendingPermission(options: {
  database: D1Database
  actor: OrganizationActor
  organizationId: string
  membersCanSend: boolean
  audit: AuditContext
  now?: number
}): Promise<OrganizationSummary> {
  const organization = await requireCreatorOrganization(
    options.database,
    options.organizationId,
    options.actor.userId,
  )
  if ((organization.members_can_send === 1) === options.membersCanSend) {
    return requireOrganizationSummary(options.database, organization.id, options.actor)
  }
  const now = Math.max(options.now ?? Date.now(), organization.updated_at + 1)
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE organizations SET members_can_send = ?1, updated_at = ?2
         WHERE id = ?3 AND creator_user_id = ?4 AND status = 'active' AND updated_at = ?5`,
      )
      .bind(
        options.membersCanSend ? 1 : 0,
        now,
        organization.id,
        options.actor.userId,
        organization.updated_at,
      ),
    createOrganizationStateGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'organization.sending_permission_updated',
        targetType: 'organization',
        targetReference: organization.id,
        outcome: 'succeeded',
        reasonCode: options.membersCanSend ? 'members_allowed' : 'members_denied',
        occurredAt: now,
      },
      organizationStateGuard(organization, {
        membersCanSend: options.membersCanSend,
        updatedAt: now,
      }),
    ),
  ])
  requireTwoChanges(results, '组织设置已经发生变化，请刷新后重试')
  return requireOrganizationSummary(options.database, organization.id, options.actor)
}

export async function leaveOrganization(options: {
  database: D1Database
  actor: OrganizationActor
  organizationId: string
  successorUserId: string | null
  audit: AuditContext
  now?: number
}): Promise<{
  organizationId: string
  outcome: 'left' | 'transferred' | 'deletion_pending'
  successorUserId: string | null
  deletionDueAt: string | null
}> {
  const membership = await findCurrentMembership(
    options.database,
    options.organizationId,
    options.actor.userId,
  )
  if (!membership || membership.organization_status !== 'active') {
    throw new OrganizationTargetError('not_found', '该组织不存在或当前不能退出')
  }
  const now = Math.max(options.now ?? Date.now(), membership.organization_updated_at + 1)

  if (membership.creator_user_id !== options.actor.userId) {
    const results = await options.database.batch([
      options.database
        .prepare(
          `UPDATE organization_memberships
           SET left_at = ?1, left_reason = 'member_exited'
           WHERE id = ?2 AND user_id = ?3 AND left_at IS NULL`,
        )
        .bind(now, membership.membership_id, options.actor.userId),
      createOrganizationMembershipExitGuardedAuditEventStatement(
        options.database,
        {
          ...options.audit,
          actorType: 'user',
          actorUserId: options.actor.userId,
          actionName: 'organization.member_exited',
          targetType: 'organization',
          targetReference: membership.organization_id,
          outcome: 'succeeded',
          reasonCode: 'member_requested',
          occurredAt: now,
        },
        {
          membershipId: membership.membership_id,
          userId: options.actor.userId,
          organizationId: membership.organization_id,
          leftAt: now,
          leftReason: 'member_exited',
        },
      ),
    ])
    requireTwoChanges(results, '成员资格已经发生变化，请刷新后重试')
    return {
      organizationId: membership.organization_id,
      outcome: 'left',
      successorUserId: null,
      deletionDueAt: null,
    }
  }

  const otherMembers = await listCurrentMemberIds(
    options.database,
    membership.organization_id,
    options.actor.userId,
  )
  if (otherMembers.length === 0) {
    const deletionDueAt = now + ORGANIZATION_RECOVERY_DURATION_MS
    await markOrganizationDeletionPending({
      database: options.database,
      actor: options.actor,
      organization: {
        id: membership.organization_id,
        creator_user_id: membership.creator_user_id,
        members_can_send: membership.members_can_send,
        updated_at: membership.organization_updated_at,
      },
      now,
      deletionDueAt,
      audit: options.audit,
      reasonCode: 'sole_creator_exited',
    })
    return {
      organizationId: membership.organization_id,
      outcome: 'deletion_pending',
      successorUserId: null,
      deletionDueAt: toIso(deletionDueAt),
    }
  }

  if (!options.successorUserId) {
    throw new OrganizationTargetError(
      'successor_required',
      '创建者退出前必须选择一名当前成员继承',
      'successorUserId',
    )
  }
  if (!otherMembers.includes(options.successorUserId)) {
    throw new OrganizationTargetError(
      'successor_unavailable',
      '请选择当前仍在组织中的成员继承',
      'successorUserId',
    )
  }

  try {
    const results = await options.database.batch([
      options.database
        .prepare(
          `UPDATE organizations SET creator_user_id = ?1, updated_at = ?2
           WHERE id = ?3 AND creator_user_id = ?4 AND status = 'active' AND updated_at = ?5`,
        )
        .bind(
          options.successorUserId,
          now,
          membership.organization_id,
          options.actor.userId,
          membership.organization_updated_at,
        ),
      options.database
        .prepare(
          `UPDATE organization_memberships
           SET left_at = ?1, left_reason = 'creator_transferred'
           WHERE id = ?2 AND user_id = ?3 AND left_at IS NULL
             AND EXISTS (
               SELECT 1 FROM organizations
               WHERE id = ?4 AND creator_user_id = ?5 AND updated_at = ?1
             )`,
        )
        .bind(
          now,
          membership.membership_id,
          options.actor.userId,
          membership.organization_id,
          options.successorUserId,
        ),
      createOrganizationStateGuardedAuditEventStatement(
        options.database,
        {
          ...options.audit,
          actorType: 'user',
          actorUserId: options.actor.userId,
          actionName: 'organization.creator_transferred',
          targetType: 'organization',
          targetReference: membership.organization_id,
          outcome: 'succeeded',
          reasonCode: 'creator_exited',
          occurredAt: now,
        },
        {
          organizationId: membership.organization_id,
          status: 'active',
          creatorUserId: options.successorUserId,
          membersCanSend: membership.members_can_send === 1,
          updatedAt: now,
        },
      ),
    ])
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new OrganizationTargetError(
        'state_conflict',
        '组织成员或创建者身份已发生变化，请刷新后重试',
      )
    }
  } catch (error) {
    if (error instanceof OrganizationTargetError) throw error
    if (isQuotaConstraint(error)) {
      throw new OrganizationTargetError(
        'successor_quota_exceeded',
        '继承者的组织额度已用完，请选择其他成员',
        'successorUserId',
      )
    }
    if (isConstraintError(error)) {
      throw new OrganizationTargetError(
        'state_conflict',
        '组织成员或创建者身份已发生变化，请刷新后重试',
      )
    }
    throw error
  }

  return {
    organizationId: membership.organization_id,
    outcome: 'transferred',
    successorUserId: options.successorUserId,
    deletionDueAt: null,
  }
}

export async function deleteOrganization(options: {
  database: D1Database
  actor: OrganizationActor
  organizationId: string
  audit: AuditContext
  now?: number
}): Promise<{ organizationId: string; deletionDueAt: string }> {
  const organization = await requireCreatorOrganization(
    options.database,
    options.organizationId,
    options.actor.userId,
  )
  const now = Math.max(options.now ?? Date.now(), organization.updated_at + 1)
  const deletionDueAt = now + ORGANIZATION_RECOVERY_DURATION_MS
  await markOrganizationDeletionPending({
    database: options.database,
    actor: options.actor,
    organization,
    now,
    deletionDueAt,
    audit: options.audit,
    reasonCode: 'creator_requested',
  })
  return { organizationId: organization.id, deletionDueAt: toIso(deletionDueAt) }
}

export async function restoreOrganization(options: {
  database: D1Database
  actor: OrganizationActor
  organizationId: string
  audit: AuditContext
  now?: number
}): Promise<OrganizationSummary> {
  const organization = await findOrganizationById(options.database, options.organizationId)
  if (!organization || organization.creator_user_id !== options.actor.userId) {
    throw new OrganizationTargetError('not_found', '该组织不存在或无权恢复')
  }
  if (organization.status !== 'deletion_pending') {
    throw new OrganizationTargetError('state_conflict', '该组织当前不在可恢复状态')
  }
  const now = Math.max(options.now ?? Date.now(), organization.updated_at + 1)
  if (organization.deletion_due_at === null || organization.deletion_due_at <= now) {
    throw new OrganizationTargetError('recovery_expired', '该组织的七天恢复期已经结束')
  }
  const operation = await options.database
    .prepare(
      `SELECT id FROM deletion_operations
       WHERE operation_kind = 'organization_delete' AND target_type = 'organization'
         AND target_reference = ?1 AND operation_status = 'recovery_pending'
         AND recovery_due_at > ?2 LIMIT 1`,
    )
    .bind(organization.id, now)
    .first<{ id: string }>()
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `UPDATE organizations
         SET status = 'active', deletion_requested_at = NULL,
             deletion_due_at = NULL, updated_at = ?1
         WHERE id = ?2 AND creator_user_id = ?3
           AND status = 'deletion_pending' AND updated_at = ?4`,
      )
      .bind(now, organization.id, options.actor.userId, organization.updated_at),
  ]
  if (operation) {
    statements.push(
      options.database
        .prepare(
          `UPDATE deletion_operations SET operation_status = 'cancelled',
               cancelled_at = ?1, updated_at = ?1
           WHERE id = ?2 AND operation_status = 'recovery_pending'`,
        )
        .bind(now, operation.id),
      options.database
        .prepare(
          `UPDATE background_tasks SET task_status = 'cancelled', next_attempt_at = NULL,
               completed_at = ?1, updated_at = ?1
           WHERE task_type = 'organization_cleanup' AND target_type = 'deletion_operation'
             AND target_reference = ?2 AND task_status IN ('pending', 'retry_wait')`,
        )
        .bind(now, operation.id),
    )
  }
  const auditResultIndex = statements.length
  statements.push(
    createOrganizationStateGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'organization.restored',
        targetType: 'organization',
        targetReference: organization.id,
        outcome: 'succeeded',
        reasonCode: 'creator_requested',
        occurredAt: now,
      },
      organizationStateGuard(organization, { status: 'active', updatedAt: now }),
    ),
  )
  const results = await options.database.batch(statements)
  if (
    results[0]?.meta.changes !== 1 ||
    (operation && results[1]?.meta.changes !== 1) ||
    (operation && results[2]?.meta.changes !== 1) ||
    results[auditResultIndex]?.meta.changes !== 1
  ) {
    throw new OrganizationTargetError('state_conflict', '组织状态已经发生变化，请刷新后重试')
  }
  return requireOrganizationSummary(options.database, organization.id, options.actor)
}

export async function ensurePendingOrganizationCleanupTasks(options: {
  database: D1Database
  now?: number
}): Promise<number> {
  const now = options.now ?? Date.now()
  const pending = await options.database
    .prepare(
      `SELECT organization.id, organization.creator_user_id,
              organization.deletion_requested_at, organization.deletion_due_at
       FROM organizations AS organization
       WHERE organization.status = 'deletion_pending'
         AND organization.deletion_requested_at IS NOT NULL
         AND organization.deletion_due_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM deletion_operations AS operation
           WHERE operation.target_type = 'organization'
             AND operation.target_reference = organization.id
             AND operation.operation_status NOT IN ('completed', 'cancelled')
         )
       ORDER BY organization.deletion_due_at, organization.id
       LIMIT 25`,
    )
    .all<{
      id: string
      creator_user_id: string
      deletion_requested_at: number
      deletion_due_at: number
    }>()

  let created = 0
  for (const organization of pending.results) {
    try {
      await createOrganizationCleanupOperation({
        database: options.database,
        organizationId: organization.id,
        requestedByUserId: organization.creator_user_id,
        requestedAt: organization.deletion_requested_at,
        deletionDueAt: organization.deletion_due_at,
        now,
      })
      created += 1
    } catch (error) {
      if (!isConstraintError(error)) throw error
    }
  }
  return created
}

export async function getAdministratorOrganizationPolicyOverview(options: {
  database: D1Database
  actor: OrganizationActor
}): Promise<AdministratorOrganizationPolicyUser[]> {
  requireAdministrator(options.actor)
  const result = await options.database
    .prepare(organizationPolicyUsersSql())
    .all<OrganizationPolicyRow>()
  return result.results.map(administratorOrganizationPolicyUserFromRow)
}

export async function updateUserOrganizationPolicy(options: {
  database: D1Database
  actor: OrganizationActor
  userId: string
  organizationLimit: number
  audit: AuditContext
  now?: number
}): Promise<AdministratorOrganizationPolicyUser> {
  requireAdministrator(options.actor)
  if (
    !Number.isInteger(options.organizationLimit) ||
    options.organizationLimit < 0 ||
    options.organizationLimit > 1000
  ) {
    throw new OrganizationInputError('organizationLimit', '组织上限必须是 0 至 1000 的整数')
  }
  const target = await findOrganizationPolicyUser(options.database, options.userId)
  if (!target || (target.user_status !== 'active' && target.user_status !== 'disabled')) {
    throw new OrganizationTargetError('not_found', '该用户不存在或当前不能修改组织额度')
  }
  if (target.organization_limit === options.organizationLimit) {
    return administratorOrganizationPolicyUserFromRow(target)
  }
  const now = Math.max(options.now ?? Date.now(), target.updated_at + 1)
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE user_organization_policies
         SET organization_limit = ?1, updated_by_user_id = ?2, updated_at = ?3
         WHERE user_id = ?4 AND updated_at = ?5`,
      )
      .bind(
        options.organizationLimit,
        options.actor.userId,
        now,
        target.user_id,
        target.updated_at,
      ),
    createUserOrganizationPolicyGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'organization.policy_updated',
        targetType: 'user',
        targetReference: target.user_id,
        outcome: 'succeeded',
        reasonCode: 'administrator_requested',
        occurredAt: now,
      },
      {
        userId: target.user_id,
        organizationLimit: options.organizationLimit,
        updatedAt: now,
      },
    ),
  ])
  requireTwoChanges(results, '组织额度已经发生变化，请刷新后重试')
  return administratorOrganizationPolicyUserFromRow({
    ...target,
    organization_limit: options.organizationLimit,
    updated_at: now,
  })
}

async function markOrganizationDeletionPending(options: {
  database: D1Database
  actor: OrganizationActor
  organization: Pick<OrganizationRow, 'id' | 'creator_user_id' | 'members_can_send' | 'updated_at'>
  now: number
  deletionDueAt: number
  audit: AuditContext
  reasonCode: string
}): Promise<void> {
  const cleanupOperation = await prepareOrganizationCleanupOperation({
    database: options.database,
    organizationId: options.organization.id,
    requestedByUserId: options.actor.userId,
    requestedAt: options.now,
    deletionDueAt: options.deletionDueAt,
    now: options.now,
  })
  const statements = [...cleanupOperation.statements]
  const organizationUpdateIndex = statements.length
  statements.push(
    options.database
      .prepare(
        `UPDATE organizations
         SET status = 'deletion_pending', deletion_requested_at = ?1,
             deletion_due_at = ?2, updated_at = ?1
         WHERE id = ?3 AND creator_user_id = ?4
           AND status = 'active' AND updated_at = ?5`,
      )
      .bind(
        options.now,
        options.deletionDueAt,
        options.organization.id,
        options.actor.userId,
        options.organization.updated_at,
      ),
    createOrganizationStateGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'organization.deletion_requested',
        targetType: 'organization',
        targetReference: options.organization.id,
        outcome: 'succeeded',
        reasonCode: options.reasonCode,
        occurredAt: options.now,
      },
      {
        organizationId: options.organization.id,
        status: 'deletion_pending',
        creatorUserId: options.organization.creator_user_id,
        membersCanSend: options.organization.members_can_send === 1,
        updatedAt: options.now,
      },
    ),
  )
  const results = await options.database.batch(statements)
  if (
    results
      .slice(0, cleanupOperation.statements.length)
      .some((result) => result.meta.changes !== 1) ||
    results[organizationUpdateIndex]?.meta.changes !== 1 ||
    results.at(-1)?.meta.changes !== 1
  ) {
    throw new OrganizationTargetError('state_conflict', '组织状态已经发生变化，请刷新后重试')
  }
}

async function createOrganizationCleanupOperation(options: {
  database: D1Database
  organizationId: string
  requestedByUserId: string
  requestedAt: number
  deletionDueAt: number
  now: number
}): Promise<string> {
  const cleanupOperation = await prepareOrganizationCleanupOperation(options)
  const results = await options.database.batch(cleanupOperation.statements)
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new OrganizationTargetError('state_conflict', '组织删除任务补建失败，请稍后重试')
  }
  return cleanupOperation.operationId
}

async function prepareOrganizationCleanupOperation(options: {
  database: D1Database
  organizationId: string
  requestedByUserId: string
  requestedAt: number
  deletionDueAt: number
  now: number
}): Promise<{ operationId: string; statements: D1PreparedStatement[] }> {
  const operationId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  const taskDigest = await sha256Bytes(
    `organization_cleanup\n${operationId}\n${ORGANIZATION_DELETION_POLICY_VERSION}`,
  )
  const impact = await options.database
    .prepare(
      `SELECT
         COUNT(entry.id) AS mailbox_count,
         COUNT(DISTINCT entry.message_id) AS message_count,
         COALESCE(SUM(message.raw_size_bytes), 0) AS size_bytes
       FROM mailbox_entries AS entry
       JOIN messages AS message ON message.id = entry.message_id
       WHERE entry.mailbox_type = 'organization' AND entry.organization_id = ?1`,
    )
    .bind(options.organizationId)
    .first<{ mailbox_count: number; message_count: number; size_bytes: number }>()
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO deletion_operations (
          id, operation_kind, target_type, target_reference,
          requested_by_user_id, policy_version, is_recoverable,
          requested_at, recovery_due_at, impact_mailbox_entry_count,
          impact_message_count, impact_object_count, impact_size_bytes,
          operation_status, created_at, updated_at
         ) VALUES (?1, 'organization_delete', 'organization', ?2, ?3, ?4, 1,
           ?5, ?6, ?7, ?8, 0, ?9, 'recovery_pending', ?5, ?5)`,
      )
      .bind(
        operationId,
        options.organizationId,
        options.requestedByUserId,
        ORGANIZATION_DELETION_POLICY_VERSION,
        options.requestedAt,
        options.deletionDueAt,
        impact?.mailbox_count ?? 0,
        impact?.message_count ?? 0,
        impact?.size_bytes ?? 0,
      ),
  ]
  for (const [stepKey, sequence, stepKind, status] of organizationDeletionStepDefinitions()) {
    statements.push(
      options.database
        .prepare(
          `INSERT INTO deletion_operation_steps (
            id, deletion_operation_id, step_key, sequence_number,
            step_kind, is_required, step_status, attempt_count,
            next_attempt_at, started_at, completed_at, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 0,
             NULL, ?7, ?7, ?8, ?8)`,
        )
        .bind(
          crypto.randomUUID(),
          operationId,
          stepKey,
          sequence,
          stepKind,
          status,
          status === 'succeeded' ? options.requestedAt : null,
          options.requestedAt,
        ),
    )
  }
  statements.push(
    options.database
      .prepare(
        `INSERT INTO background_tasks (
          id, task_type, target_type, target_reference, input_version,
          task_key_digest, task_status, priority, attempt_count,
          max_attempts, next_attempt_at, lease_owner_reference,
          lease_token, lease_expires_at, created_at, updated_at
         ) VALUES (?1, 'organization_cleanup', 'deletion_operation', ?2, ?3,
           ?4, 'pending', 3, 0, 100, ?5, NULL, 0, NULL, ?6, ?6)`,
      )
      .bind(
        taskId,
        operationId,
        ORGANIZATION_DELETION_POLICY_VERSION,
        taskDigest,
        options.deletionDueAt,
        options.now,
      ),
  )
  return { operationId, statements }
}

function organizationDeletionStepDefinitions() {
  return [
    ['revoke_access', 0, 'revoke_access', 'succeeded'],
    ['remove_mailbox_relations', 1, 'database_relations', 'pending'],
    ['remove_objects', 2, 'objects', 'pending'],
    ['remove_search_data', 3, 'search', 'pending'],
    ['remove_settings', 4, 'cache', 'pending'],
    ['release_addresses', 5, 'release_identity', 'pending'],
    ['reconcile_cleanup', 6, 'reconcile', 'pending'],
  ] as const
}

async function requireOrganizationSummary(
  database: D1Database,
  organizationId: string,
  actor: OrganizationActor,
): Promise<OrganizationSummary> {
  const row = await findVisibleOrganization(database, organizationId, actor.userId)
  if (!row) throw new OrganizationTargetError('not_found', '组织已不可见')
  return organizationSummaryFromRow(database, row, actor)
}

async function organizationSummaryFromRow(
  database: D1Database,
  row: OrganizationRow,
  actor: OrganizationActor,
): Promise<OrganizationSummary> {
  const isCreator = row.creator_user_id === actor.userId
  const [members, pendingInvitations] = await Promise.all([
    listOrganizationMembers(database, row.id, row.creator_user_id),
    isCreator && row.status === 'active'
      ? listPendingInvitationsForOrganization(database, row.id)
      : Promise.resolve([]),
  ])
  return {
    id: row.id,
    name: row.name,
    status: row.status as OrganizationSummary['status'],
    sharedAddress: row.canonical_address,
    addressId: row.address_id,
    creatorUserId: row.creator_user_id,
    isCreator,
    membersCanSend: row.members_can_send === 1,
    canSendAsOrganization: row.status === 'active' && (isCreator || row.members_can_send === 1),
    memberCount: members.length,
    members,
    pendingInvitations,
    createdAt: toIso(row.created_at),
    deletionDueAt: row.deletion_due_at === null ? null : toIso(row.deletion_due_at),
  }
}

async function listOrganizationRows(database: D1Database, userId: string) {
  const result = await database
    .prepare(
      `${organizationSelectSql()}
       LEFT JOIN organization_memberships actor_membership
         ON actor_membership.organization_id = organizations.id
        AND actor_membership.user_id = ?1
        AND actor_membership.left_at IS NULL
       WHERE (organizations.status = 'active' AND actor_membership.id IS NOT NULL)
          OR (organizations.status = 'deletion_pending'
              AND organizations.creator_user_id = ?1)
       ORDER BY organizations.created_at, organizations.id`,
    )
    .bind(userId)
    .all<OrganizationRow>()
  return result.results
}

async function findVisibleOrganization(
  database: D1Database,
  organizationId: string,
  userId: string,
): Promise<OrganizationRow | null> {
  if (!isUuid(organizationId)) return null
  return database
    .prepare(
      `${organizationSelectSql()}
       LEFT JOIN organization_memberships actor_membership
         ON actor_membership.organization_id = organizations.id
        AND actor_membership.user_id = ?2
        AND actor_membership.left_at IS NULL
       WHERE organizations.id = ?1
         AND (
           (organizations.status = 'active' AND actor_membership.id IS NOT NULL)
           OR (organizations.status = 'deletion_pending'
               AND organizations.creator_user_id = ?2)
         )
       LIMIT 1`,
    )
    .bind(organizationId, userId)
    .first<OrganizationRow>()
}

async function findOrganizationById(
  database: D1Database,
  organizationId: string,
): Promise<OrganizationRow | null> {
  if (!isUuid(organizationId)) return null
  return database
    .prepare(
      `${organizationSelectSql()}
       LEFT JOIN organization_memberships actor_membership
         ON actor_membership.organization_id = organizations.id
        AND actor_membership.user_id = organizations.creator_user_id
        AND actor_membership.left_at IS NULL
       WHERE organizations.id = ?1 LIMIT 1`,
    )
    .bind(organizationId)
    .first<OrganizationRow>()
}

async function requireCreatorOrganization(
  database: D1Database,
  organizationId: string,
  userId: string,
): Promise<OrganizationRow> {
  const organization = await findVisibleOrganization(database, organizationId, userId)
  if (!organization) throw new OrganizationTargetError('not_found', '该组织不存在')
  if (organization.status !== 'active') {
    throw new OrganizationTargetError('state_conflict', '该组织当前不能修改')
  }
  if (organization.creator_user_id !== userId) throw new OrganizationPermissionError()
  return organization
}

function organizationSelectSql(): string {
  return `SELECT
    organizations.id,
    organizations.name,
    organizations.status,
    organizations.creator_user_id,
    organizations.members_can_send,
    organizations.deletion_due_at,
    organizations.created_at,
    organizations.updated_at,
    email_addresses.id AS address_id,
    email_addresses.canonical_address,
    actor_membership.id AS actor_membership_id
   FROM organizations
   JOIN address_bindings
     ON address_bindings.organization_id = organizations.id
    AND address_bindings.owner_type = 'organization'
    AND address_bindings.address_role = 'shared'
    AND address_bindings.ended_at IS NULL
   JOIN email_addresses ON email_addresses.id = address_bindings.address_id`
}

async function listOrganizationMembers(
  database: D1Database,
  organizationId: string,
  creatorUserId: string,
): Promise<OrganizationMemberSummary[]> {
  const result = await database
    .prepare(
      `SELECT
        organization_memberships.id AS membership_id,
        users.id AS user_id,
        users.display_name,
        email_addresses.canonical_address,
        organization_memberships.joined_at
       FROM organization_memberships
       JOIN users ON users.id = organization_memberships.user_id
       JOIN address_bindings
         ON address_bindings.user_id = users.id
        AND address_bindings.owner_type = 'user'
        AND address_bindings.address_role = 'primary'
        AND address_bindings.ended_at IS NULL
       JOIN email_addresses ON email_addresses.id = address_bindings.address_id
       WHERE organization_memberships.organization_id = ?1
         AND organization_memberships.left_at IS NULL
       ORDER BY CASE WHEN users.id = ?2 THEN 0 ELSE 1 END,
                organization_memberships.joined_at,
                organization_memberships.id`,
    )
    .bind(organizationId, creatorUserId)
    .all<OrganizationMemberRow>()
  return result.results.map((row) => ({
    membershipId: row.membership_id,
    userId: row.user_id,
    displayName: row.display_name,
    primaryAddress: row.canonical_address,
    role: row.user_id === creatorUserId ? 'creator' : 'member',
    joinedAt: toIso(row.joined_at),
  }))
}

async function listPendingInvitationsForUser(database: D1Database, userId: string) {
  const result = await database
    .prepare(
      `${invitationSelectSql()} WHERE invitations.invited_user_id = ?1 AND invitations.status = 'pending'
      AND organizations.status = 'active' ORDER BY invitations.created_at, invitations.id`,
    )
    .bind(userId)
    .all<OrganizationInvitationRow>()
  return result.results.map(invitationSummaryFromRow)
}

async function listPendingInvitationsForOrganization(database: D1Database, organizationId: string) {
  const result = await database
    .prepare(
      `${invitationSelectSql()} WHERE invitations.organization_id = ?1 AND invitations.status = 'pending'
      ORDER BY invitations.created_at, invitations.id`,
    )
    .bind(organizationId)
    .all<OrganizationInvitationRow>()
  return result.results.map(invitationSummaryFromRow)
}

async function findInvitationSummary(database: D1Database, invitationId: string) {
  return database
    .prepare(`${invitationSelectSql()} WHERE invitations.id = ?1 LIMIT 1`)
    .bind(invitationId)
    .first<OrganizationInvitationRow>()
    .then((row) => (row ? invitationSummaryFromRow(row) : null))
}

function invitationSelectSql(): string {
  return `SELECT
    invitations.id,
    invitations.organization_id,
    organizations.name AS organization_name,
    organization_address.canonical_address,
    invitations.invited_user_id,
    invited_user.display_name AS invited_user_display_name,
    invited_address.canonical_address AS invited_user_address,
    invitations.invited_by_user_id,
    invited_by.display_name AS invited_by_display_name,
    invitations.status,
    invitations.created_at,
    invitations.resolved_at
   FROM organization_invitations invitations
   JOIN organizations ON organizations.id = invitations.organization_id
   JOIN address_bindings organization_binding
     ON organization_binding.organization_id = organizations.id
    AND organization_binding.owner_type = 'organization'
    AND organization_binding.address_role = 'shared'
    AND organization_binding.ended_at IS NULL
   JOIN email_addresses organization_address
     ON organization_address.id = organization_binding.address_id
   JOIN users invited_user ON invited_user.id = invitations.invited_user_id
   JOIN address_bindings invited_binding
     ON invited_binding.user_id = invited_user.id
    AND invited_binding.owner_type = 'user'
    AND invited_binding.address_role = 'primary'
    AND invited_binding.ended_at IS NULL
   JOIN email_addresses invited_address ON invited_address.id = invited_binding.address_id
   JOIN users invited_by ON invited_by.id = invitations.invited_by_user_id`
}

function invitationSummaryFromRow(row: OrganizationInvitationRow): OrganizationInvitationSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    sharedAddress: row.canonical_address,
    invitedUserId: row.invited_user_id,
    invitedUserDisplayName: row.invited_user_display_name,
    invitedUserPrimaryAddress: row.invited_user_address,
    invitedByUserId: row.invited_by_user_id,
    invitedByDisplayName: row.invited_by_display_name,
    status: row.status as OrganizationInvitationSummary['status'],
    createdAt: toIso(row.created_at),
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
  }
}

async function findOrganizationPolicyUser(database: D1Database, userId: string) {
  if (!isUuid(userId)) return null
  return database
    .prepare(`${organizationPolicyUsersSql()} WHERE users.id = ?1 LIMIT 1`)
    .bind(userId)
    .first<OrganizationPolicyRow>()
}

function organizationPolicyUsersSql(): string {
  return `SELECT
    users.id AS user_id,
    users.display_name,
    users.status AS user_status,
    email_addresses.canonical_address,
    user_organization_policies.organization_limit,
    user_organization_policies.updated_at,
    (SELECT COUNT(*) FROM organizations
      WHERE organizations.creator_user_id = users.id) AS owned_organization_count
   FROM users
   JOIN user_organization_policies ON user_organization_policies.user_id = users.id
   JOIN address_bindings
     ON address_bindings.user_id = users.id
    AND address_bindings.owner_type = 'user'
    AND address_bindings.address_role = 'primary'
    AND address_bindings.ended_at IS NULL
   JOIN email_addresses ON email_addresses.id = address_bindings.address_id
   AND users.status IN ('active', 'disabled')`
}

function organizationPolicyFromRow(row: OrganizationPolicyRow): OrganizationPolicySummary {
  return {
    organizationLimit: row.organization_limit,
    ownedOrganizationCount: row.owned_organization_count,
    remainingOrganizationCount: Math.max(0, row.organization_limit - row.owned_organization_count),
    overLimit: row.owned_organization_count > row.organization_limit,
  }
}

function administratorOrganizationPolicyUserFromRow(
  row: OrganizationPolicyRow,
): AdministratorOrganizationPolicyUser {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    primaryAddress: row.canonical_address,
    userStatus: row.user_status as 'active' | 'disabled',
    policy: organizationPolicyFromRow(row),
  }
}

async function listActiveDomains(database: D1Database): Promise<ActiveDomainRow[]> {
  const result = await database
    .prepare(
      `SELECT id, display_name, canonical_name FROM mail_domains
       WHERE status = 'active' ORDER BY canonical_name, id`,
    )
    .all<ActiveDomainRow>()
  return result.results
}

async function findActiveDomain(database: D1Database, domainId: string) {
  if (!isUuid(domainId)) return null
  return database
    .prepare(
      `SELECT id, display_name, canonical_name FROM mail_domains
       WHERE id = ?1 AND status = 'active' LIMIT 1`,
    )
    .bind(domainId)
    .first<ActiveDomainRow>()
}

async function findInvitationPolicy(
  database: D1Database,
  userId: string,
): Promise<OrganizationInvitationPolicy | null> {
  const row = await database
    .prepare("SELECT invitation_policy FROM users WHERE id = ?1 AND status = 'active' LIMIT 1")
    .bind(userId)
    .first<{ invitation_policy: string }>()
  return row && isInvitationPolicy(row.invitation_policy) ? row.invitation_policy : null
}

async function findActiveUserByPrimaryAddress(database: D1Database, canonicalAddress: string) {
  return database
    .prepare(
      `SELECT users.id, users.display_name, users.invitation_policy,
              email_addresses.canonical_address
       FROM users
       JOIN address_bindings
         ON address_bindings.user_id = users.id
        AND address_bindings.owner_type = 'user'
        AND address_bindings.address_role = 'primary'
        AND address_bindings.ended_at IS NULL
       JOIN email_addresses ON email_addresses.id = address_bindings.address_id
       WHERE email_addresses.canonical_address = ?1 COLLATE NOCASE
         AND users.status = 'active'
       LIMIT 1`,
    )
    .bind(canonicalAddress)
    .first<InvitedUserRow>()
}

async function hasCurrentMembership(database: D1Database, organizationId: string, userId: string) {
  return Boolean(
    await database
      .prepare(
        `SELECT 1 FROM organization_memberships
         WHERE organization_id = ?1 AND user_id = ?2 AND left_at IS NULL LIMIT 1`,
      )
      .bind(organizationId, userId)
      .first(),
  )
}

async function hasPendingInvitation(database: D1Database, organizationId: string, userId: string) {
  return Boolean(
    await database
      .prepare(
        `SELECT 1 FROM organization_invitations
         WHERE organization_id = ?1 AND invited_user_id = ?2 AND status = 'pending' LIMIT 1`,
      )
      .bind(organizationId, userId)
      .first(),
  )
}

async function findPendingInvitationForUser(
  database: D1Database,
  invitationId: string,
  userId: string,
) {
  if (!isUuid(invitationId)) return null
  return database
    .prepare(
      `SELECT invitations.id, invitations.organization_id, invitations.invited_user_id,
              invitations.status, invitations.created_at
       FROM organization_invitations invitations
       JOIN organizations ON organizations.id = invitations.organization_id
       WHERE invitations.id = ?1 AND invitations.invited_user_id = ?2
         AND invitations.status = 'pending' AND organizations.status = 'active'
       LIMIT 1`,
    )
    .bind(invitationId, userId)
    .first<InvitationTargetRow>()
}

async function findCurrentMembership(database: D1Database, organizationId: string, userId: string) {
  if (!isUuid(organizationId)) return null
  return database
    .prepare(
      `SELECT
        organization_memberships.id AS membership_id,
        organization_memberships.organization_id,
        organization_memberships.user_id,
        organization_memberships.joined_at,
        organizations.name AS organization_name,
        organizations.status AS organization_status,
        organizations.creator_user_id,
        organizations.members_can_send,
        organizations.deletion_due_at,
        organizations.updated_at AS organization_updated_at
       FROM organization_memberships
       JOIN organizations ON organizations.id = organization_memberships.organization_id
       WHERE organization_memberships.organization_id = ?1
         AND organization_memberships.user_id = ?2
         AND organization_memberships.left_at IS NULL
       LIMIT 1`,
    )
    .bind(organizationId, userId)
    .first<CurrentMembershipRow>()
}

async function listCurrentMemberIds(
  database: D1Database,
  organizationId: string,
  excludedUserId: string,
) {
  const result = await database
    .prepare(
      `SELECT user_id FROM organization_memberships
       WHERE organization_id = ?1 AND user_id <> ?2 AND left_at IS NULL
       ORDER BY joined_at, id`,
    )
    .bind(organizationId, excludedUserId)
    .all<{ user_id: string }>()
  return result.results.map((row) => row.user_id)
}

function normalizeOrganizationName(input: string): string {
  const name = input.trim()
  if ([...name].length < 1 || [...name].length > 120 || containsControlCharacter(name)) {
    throw new OrganizationInputError('name', '组织名称必须包含 1 至 120 个有效字符')
  }
  return name
}

function normalizePrimaryAddressInput(input: string): string {
  const value = input.trim()
  const separator = value.lastIndexOf('@')
  if (separator <= 0 || separator === value.length - 1) {
    throw new OrganizationInputError('primaryAddress', '请输入完整的主邮箱地址')
  }
  try {
    return normalizeEmailAddress(value.slice(0, separator), value.slice(separator + 1))
      .canonicalAddress
  } catch (error) {
    if (error instanceof AddressValidationError) {
      throw new OrganizationInputError('primaryAddress', '请输入有效的主邮箱地址')
    }
    throw error
  }
}

function invitationOutcome(policy: string): 'pending' | 'accepted' | 'rejected' {
  if (policy === 'auto_accept') return 'accepted'
  if (policy === 'reject_all') return 'rejected'
  return 'pending'
}

function isInvitationPolicy(value: string): value is OrganizationInvitationPolicy {
  return value === 'reject_all' || value === 'manual' || value === 'auto_accept'
}

function domainSummary(row: ActiveDomainRow): OrganizationDomainSummary {
  return { id: row.id, displayName: row.display_name, canonicalName: row.canonical_name }
}

function organizationStateGuard(
  organization: Pick<
    OrganizationRow,
    'id' | 'status' | 'creator_user_id' | 'members_can_send' | 'updated_at'
  >,
  overrides: { status?: string; membersCanSend?: boolean; updatedAt?: number },
) {
  return {
    organizationId: organization.id,
    status: overrides.status ?? organization.status,
    creatorUserId: organization.creator_user_id,
    membersCanSend: overrides.membersCanSend ?? organization.members_can_send === 1,
    updatedAt: overrides.updatedAt ?? organization.updated_at,
  }
}

function requireAdministrator(actor: OrganizationActor): void {
  if (!actor.isAdministrator)
    throw new OrganizationPermissionError('只有系统管理员可以调整组织额度')
}

function requireTwoChanges(results: D1Result<unknown>[], message: string): void {
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new OrganizationTargetError('state_conflict', message)
  }
}

function isQuotaConstraint(error: unknown): boolean {
  return (
    error instanceof Error && /组织创建额度已用完|继承者的组织创建额度已用完/u.test(error.message)
  )
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique|组织|邀请|成员|共享地址/iu.test(error.message)
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function toIso(value: number): string {
  return new Date(value).toISOString()
}
