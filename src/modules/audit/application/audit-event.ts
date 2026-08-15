export interface AuditContext {
  requestTraceId: string
  sourceIp: string | null
  browserFamily: string | null
}

export interface AuditEventInput extends AuditContext {
  actorType: 'user' | 'system' | 'deleted_user'
  actorUserId: string | null
  actionName: string
  targetType: string
  targetReference: string
  outcome: 'succeeded' | 'failed' | 'denied'
  reasonCode?: string | null
  occurredAt: number
}

export interface PasswordCredentialAuditGuard {
  userId: string
  formatVersion: number
  algorithm: string
  iterations: number
  salt: Uint8Array
  derivedKey: Uint8Array
  updatedAt: number
}

export interface UserStateAuditGuard {
  userId: string
  status: string
  updatedAt: number
}

export interface MailDomainStateAuditGuard {
  domainId: string
  status: string
  updatedAt: number
}

export interface UserAliasPolicyAuditGuard {
  userId: string
  aliasLimit: number
  selfCreationEnabled: boolean
  updatedAt: number
}

export interface PersonalAliasBindingAuditGuard {
  bindingId: string
  addressId: string
  userId: string
}

export interface PersonalAddressPreferenceAuditGuard {
  userId: string
  addressId: string
  customLabel: string | null
  isPinned: boolean
  sortOrder: number
  isDefaultSender: boolean
  updatedAt: number
}

export interface AddressPolicyAuditGuard {
  policyVersion: number
  minimumLocalPartLength: number
  aliasRetentionDays: number
  updatedAt: number
}

export interface UserOrganizationPolicyAuditGuard {
  userId: string
  organizationLimit: number
  updatedAt: number
}

export interface UserInvitationPolicyAuditGuard {
  userId: string
  invitationPolicy: string
  updatedAt: number
}

export interface OrganizationStateAuditGuard {
  organizationId: string
  status: string
  creatorUserId: string
  membersCanSend: boolean
  updatedAt: number
}

export interface OrganizationMembershipExitAuditGuard {
  membershipId: string
  userId: string
  organizationId: string
  leftAt: number
  leftReason: string
}

export interface OrganizationInvitationAuditGuard {
  invitationId: string
  status: string
  acceptedMembershipId: string | null
  resolvedAt: number
}

export interface DeletionOperationAuditGuard {
  deletionOperationId: string
}

export interface AccountRegistrationInvitationAuditGuard {
  invitationId: string
  revokedAt: number
}

export function createAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO audit_events (
        id, occurred_at, actor_type, actor_user_id, action_name,
        target_type, target_reference, outcome, reason_code,
        request_trace_id, source_ip_text, browser_family, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?2)`,
    )
    .bind(
      crypto.randomUUID(),
      event.occurredAt,
      event.actorType,
      event.actorUserId,
      normalizeAuditLabel(event.actionName, 120),
      normalizeAuditLabel(event.targetType, 80),
      normalizeAuditLabel(event.targetReference, 160),
      event.outcome,
      event.reasonCode ? normalizeAuditLabel(event.reasonCode, 120) : null,
      normalizeAuditLabel(event.requestTraceId, 120),
      normalizeOptionalText(event.sourceIp, 80),
      normalizeOptionalText(event.browserFamily, 80),
    )
}

export async function recordAuditEvent(
  database: D1Database,
  event: AuditEventInput,
): Promise<void> {
  await createAuditEventStatement(database, event).run()
}

export function createPasswordGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: PasswordCredentialAuditGuard,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO audit_events (
        id, occurred_at, actor_type, actor_user_id, action_name,
        target_type, target_reference, outcome, reason_code,
        request_trace_id, source_ip_text, browser_family, created_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?2
       WHERE EXISTS (
         SELECT 1
         FROM password_credentials
         WHERE user_id = ?13
           AND format_version = ?14
           AND algorithm = ?15
           AND iterations = ?16
           AND salt = ?17
           AND derived_key = ?18
           AND updated_at = ?19
       )`,
    )
    .bind(
      crypto.randomUUID(),
      event.occurredAt,
      event.actorType,
      event.actorUserId,
      normalizeAuditLabel(event.actionName, 120),
      normalizeAuditLabel(event.targetType, 80),
      normalizeAuditLabel(event.targetReference, 160),
      event.outcome,
      event.reasonCode ? normalizeAuditLabel(event.reasonCode, 120) : null,
      normalizeAuditLabel(event.requestTraceId, 120),
      normalizeOptionalText(event.sourceIp, 80),
      normalizeOptionalText(event.browserFamily, 80),
      guard.userId,
      guard.formatVersion,
      guard.algorithm,
      guard.iterations,
      guard.salt,
      guard.derivedKey,
      guard.updatedAt,
    )
}

export function createUserStateGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: UserStateAuditGuard,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO audit_events (
        id, occurred_at, actor_type, actor_user_id, action_name,
        target_type, target_reference, outcome, reason_code,
        request_trace_id, source_ip_text, browser_family, created_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?2
       WHERE EXISTS (
         SELECT 1
         FROM users
         WHERE id = ?13 AND status = ?14 AND updated_at = ?15
       )`,
    )
    .bind(
      crypto.randomUUID(),
      event.occurredAt,
      event.actorType,
      event.actorUserId,
      normalizeAuditLabel(event.actionName, 120),
      normalizeAuditLabel(event.targetType, 80),
      normalizeAuditLabel(event.targetReference, 160),
      event.outcome,
      event.reasonCode ? normalizeAuditLabel(event.reasonCode, 120) : null,
      normalizeAuditLabel(event.requestTraceId, 120),
      normalizeOptionalText(event.sourceIp, 80),
      normalizeOptionalText(event.browserFamily, 80),
      guard.userId,
      guard.status,
      guard.updatedAt,
    )
}

export function createMailDomainStateGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: MailDomainStateAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM mail_domains
      WHERE id = ?13 AND status = ?14 AND updated_at = ?15
    )`,
    [guard.domainId, guard.status, guard.updatedAt],
  )
}

export function createDeletedMailDomainAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  domainId: string,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    'NOT EXISTS (SELECT 1 FROM mail_domains WHERE id = ?13)',
    [domainId],
  )
}

export function createUserAliasPolicyGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: UserAliasPolicyAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM user_alias_policies
      WHERE user_id = ?13
        AND alias_limit = ?14
        AND self_creation_enabled = ?15
        AND updated_at = ?16
    )`,
    [guard.userId, guard.aliasLimit, guard.selfCreationEnabled ? 1 : 0, guard.updatedAt],
  )
}

export function createPersonalAliasBindingGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: PersonalAliasBindingAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM address_bindings
      WHERE id = ?13 AND address_id = ?14 AND user_id = ?15
        AND owner_type = 'user' AND address_role = 'alias' AND ended_at IS NULL
    )`,
    [guard.bindingId, guard.addressId, guard.userId],
  )
}

export function createPersonalAddressPreferenceGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: PersonalAddressPreferenceAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM user_address_preferences
      WHERE user_id = ?13 AND address_id = ?14
        AND custom_label IS ?15
        AND is_pinned = ?16
        AND sort_order = ?17
        AND is_default_sender = ?18
        AND updated_at = ?19
    )`,
    [
      guard.userId,
      guard.addressId,
      guard.customLabel,
      guard.isPinned ? 1 : 0,
      guard.sortOrder,
      guard.isDefaultSender ? 1 : 0,
      guard.updatedAt,
    ],
  )
}

export function createDeletedPersonalAliasGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: {
    bindingId: string
    addressId: string
    endedAt: number
    reservedUntil: number | null
  },
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM address_bindings
      WHERE id = ?13 AND address_id = ?14 AND ended_at = ?15
    ) AND (
      (?16 IS NULL AND NOT EXISTS (
        SELECT 1 FROM address_claims WHERE address_id = ?14
      ))
      OR (?16 IS NOT NULL AND EXISTS (
        SELECT 1 FROM address_claims
        WHERE address_id = ?14 AND status = 'reserved' AND reserved_until = ?16
      ))
    )`,
    [guard.bindingId, guard.addressId, guard.endedAt, guard.reservedUntil],
  )
}

export function createAddressPolicyGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: AddressPolicyAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM address_policy_settings
      WHERE singleton_id = 1
        AND policy_version = ?13
        AND minimum_local_part_length = ?14
        AND alias_retention_days = ?15
        AND updated_at = ?16
    )`,
    [guard.policyVersion, guard.minimumLocalPartLength, guard.aliasRetentionDays, guard.updatedAt],
  )
}

export function createUserOrganizationPolicyGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: UserOrganizationPolicyAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM user_organization_policies
      WHERE user_id = ?13
        AND organization_limit = ?14
        AND updated_at = ?15
    )`,
    [guard.userId, guard.organizationLimit, guard.updatedAt],
  )
}

export function createUserInvitationPolicyGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: UserInvitationPolicyAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM users
      WHERE id = ?13 AND invitation_policy = ?14 AND updated_at = ?15
    )`,
    [guard.userId, guard.invitationPolicy, guard.updatedAt],
  )
}

export function createOrganizationStateGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: OrganizationStateAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM organizations
      WHERE id = ?13 AND status = ?14 AND creator_user_id = ?15
        AND members_can_send = ?16 AND updated_at = ?17
    )`,
    [
      guard.organizationId,
      guard.status,
      guard.creatorUserId,
      guard.membersCanSend ? 1 : 0,
      guard.updatedAt,
    ],
  )
}

export function createOrganizationMembershipExitGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: OrganizationMembershipExitAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM organization_memberships
      WHERE id = ?13 AND user_id = ?14 AND organization_id = ?15
        AND left_at = ?16 AND left_reason = ?17
    )`,
    [guard.membershipId, guard.userId, guard.organizationId, guard.leftAt, guard.leftReason],
  )
}

export function createOrganizationInvitationGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: OrganizationInvitationAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM organization_invitations
      WHERE id = ?13 AND status = ?14
        AND accepted_membership_id IS ?15 AND resolved_at = ?16
    )`,
    [guard.invitationId, guard.status, guard.acceptedMembershipId, guard.resolvedAt],
  )
}

export function createDeletionOperationGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: DeletionOperationAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    'EXISTS (SELECT 1 FROM deletion_operations WHERE id = ?13)',
    [guard.deletionOperationId],
  )
}

export function createAccountRegistrationInvitationGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  guard: AccountRegistrationInvitationAuditGuard,
): D1PreparedStatement {
  return createGuardedAuditEventStatement(
    database,
    event,
    `EXISTS (
      SELECT 1 FROM account_registration_invitations
      WHERE id = ?13 AND revoked_at = ?14
    )`,
    [guard.invitationId, guard.revokedAt],
  )
}

function createGuardedAuditEventStatement(
  database: D1Database,
  event: AuditEventInput,
  predicate: string,
  predicateBindings: unknown[],
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO audit_events (
        id, occurred_at, actor_type, actor_user_id, action_name,
        target_type, target_reference, outcome, reason_code,
        request_trace_id, source_ip_text, browser_family, created_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?2
       WHERE ${predicate}`,
    )
    .bind(
      crypto.randomUUID(),
      event.occurredAt,
      event.actorType,
      event.actorUserId,
      normalizeAuditLabel(event.actionName, 120),
      normalizeAuditLabel(event.targetType, 80),
      normalizeAuditLabel(event.targetReference, 160),
      event.outcome,
      event.reasonCode ? normalizeAuditLabel(event.reasonCode, 120) : null,
      normalizeAuditLabel(event.requestTraceId, 120),
      normalizeOptionalText(event.sourceIp, 80),
      normalizeOptionalText(event.browserFamily, 80),
      ...predicateBindings,
    )
}

function normalizeAuditLabel(value: string, maximumLength: number): string {
  const normalized = [...value.trim()]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && codePoint !== 127
    })
    .join('')
  return [...normalized].slice(0, maximumLength).join('') || 'unknown'
}

function normalizeOptionalText(value: string | null, maximumLength: number): string | null {
  return value ? normalizeAuditLabel(value, maximumLength) : null
}
