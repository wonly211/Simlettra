import type {
  AdministratorAliasPolicyUser,
  PersonalAddressSummary,
  UpdatePersonalAddressPreferenceRequest,
  UserAliasPolicySummary,
} from '../../../shared/contracts/personal-address-management'
import {
  createDeletedPersonalAliasGuardedAuditEventStatement,
  createPersonalAddressPreferenceGuardedAuditEventStatement,
  createPersonalAliasBindingGuardedAuditEventStatement,
  createUserAliasPolicyGuardedAuditEventStatement,
  type AuditContext,
} from '../../audit/public'
import { AddressValidationError, normalizeEmailAddress } from '../domain/email-address'
import {
  readAddressPolicySnapshot,
  validateLocalPartAgainstAddressPolicy,
} from './address-policy-management'

export interface PersonalAddressActor {
  userId: string
  isAdministrator: boolean
}

interface PersonalAddressRow {
  id: string
  canonical_address: string
  domain_id: string
  domain_display_name: string
  address_role: string
  custom_label: string | null
  is_pinned: number
  sort_order: number
  is_default_sender: number
  created_at: number
  preference_updated_at: number
  binding_id: string
}

interface AliasPolicyUserRow {
  id: string
  display_name: string
  status: string
  primary_address: string
  alias_limit: number
  self_creation_enabled: number
  alias_used: number
  created_at: number
  updated_at: number
}

interface ActiveDomainRow {
  id: string
  display_name: string
  canonical_name: string
}

type PersonalAddressField =
  | 'localPart'
  | 'domainId'
  | 'aliasLimit'
  | 'selfCreationEnabled'
  | 'customLabel'
  | 'isPinned'
  | 'direction'

export class PersonalAddressInputError extends Error {
  constructor(
    readonly field: PersonalAddressField,
    message: string,
  ) {
    super(message)
  }
}

export class PersonalAddressPermissionError extends Error {
  constructor(message = '无权管理该用户的个人邮箱地址') {
    super(message)
  }
}

export class PersonalAliasCreationError extends Error {
  constructor(
    readonly code:
      | 'self_creation_disabled'
      | 'alias_quota_exceeded'
      | 'address_unavailable'
      | 'user_unavailable'
      | 'domain_unavailable',
    message: string,
    readonly field: 'localPart' | 'domainId' | null = null,
  ) {
    super(message)
  }
}

export class PersonalAddressTargetError extends Error {
  constructor(
    readonly code: 'not_found' | 'primary_protected' | 'state_conflict',
    message: string,
  ) {
    super(message)
  }
}

export async function getPersonalAddressOverview(options: {
  database: D1Database
  actor: PersonalAddressActor
}) {
  const policy = await findAliasPolicyUser(options.database, options.actor.userId)
  if (!policy || policy.status !== 'active') {
    throw new PersonalAddressTargetError('not_found', '当前用户没有可用的地址策略')
  }

  const [addresses, activeDomains, addressPolicy] = await Promise.all([
    listPersonalAddresses(options.database, options.actor.userId),
    listActiveDomains(options.database),
    readAddressPolicySnapshot(options.database),
  ])
  return {
    policy: aliasPolicyFromRow(policy),
    aliasRetentionDays: addressPolicy.aliasRetentionDays,
    addresses,
    activeDomains: activeDomains.map(domainSummary),
  }
}

export async function getAdministratorAliasPolicyOverview(options: {
  database: D1Database
  actor: PersonalAddressActor
}): Promise<AdministratorAliasPolicyUser[]> {
  requireAdministrator(options.actor)
  const result = await options.database.prepare(aliasPolicyUsersSql()).all<AliasPolicyUserRow>()
  return Promise.all(
    result.results.map(async (row) =>
      administratorAliasPolicyUserFromRow(
        row,
        (await listPersonalAddresses(options.database, row.id)).filter(
          (address) => address.role === 'alias',
        ),
      ),
    ),
  )
}

export async function updateUserAliasPolicy(options: {
  database: D1Database
  actor: PersonalAddressActor
  userId: string
  aliasLimit: number
  selfCreationEnabled: boolean
  audit: AuditContext
  now?: number
}): Promise<AdministratorAliasPolicyUser> {
  requireAdministrator(options.actor)
  if (
    !Number.isInteger(options.aliasLimit) ||
    options.aliasLimit < 0 ||
    options.aliasLimit > 1000
  ) {
    throw new PersonalAddressInputError('aliasLimit', '个人别名上限必须是 0 至 1000 的整数')
  }

  const target = await findAliasPolicyUser(options.database, options.userId)
  if (!target || (target.status !== 'active' && target.status !== 'disabled')) {
    throw new PersonalAddressTargetError('not_found', '该用户不存在或当前不能修改别名策略')
  }
  const now = Math.max(options.now ?? Date.now(), target.updated_at + 1)
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE user_alias_policies
         SET alias_limit = ?1, self_creation_enabled = ?2,
             updated_by_user_id = ?3, updated_at = ?4
         WHERE user_id = ?5 AND updated_at = ?6`,
      )
      .bind(
        options.aliasLimit,
        options.selfCreationEnabled ? 1 : 0,
        options.actor.userId,
        now,
        target.id,
        target.updated_at,
      ),
    createUserAliasPolicyGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'personal_alias.policy_updated',
        targetType: 'user',
        targetReference: target.id,
        outcome: 'succeeded',
        reasonCode: 'administrator_requested',
        occurredAt: now,
      },
      {
        userId: target.id,
        aliasLimit: options.aliasLimit,
        selfCreationEnabled: options.selfCreationEnabled,
        updatedAt: now,
      },
    ),
  ])
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new PersonalAddressTargetError('state_conflict', '别名策略已经发生变化，请刷新后重试')
  }

  return administratorAliasPolicyUserFromRow(
    {
      ...target,
      alias_limit: options.aliasLimit,
      self_creation_enabled: options.selfCreationEnabled ? 1 : 0,
      updated_at: now,
    },
    (await listPersonalAddresses(options.database, target.id)).filter(
      (address) => address.role === 'alias',
    ),
  )
}

export async function createPersonalAlias(options: {
  database: D1Database
  actor: PersonalAddressActor
  targetUserId: string
  asAdministrator: boolean
  localPart: string
  domainId: string
  audit: AuditContext
  now?: number
}): Promise<{ address: PersonalAddressSummary; policy: UserAliasPolicySummary }> {
  authorizeTargetUser(options.actor, options.targetUserId, options.asAdministrator)
  const target = await findAliasPolicyUser(options.database, options.targetUserId)
  if (!target || target.status !== 'active') {
    throw new PersonalAliasCreationError('user_unavailable', '目标用户当前不能建立个人别名')
  }
  if (!options.asAdministrator && target.self_creation_enabled !== 1) {
    throw new PersonalAliasCreationError('self_creation_disabled', '管理员已关闭个人别名自助创建')
  }
  if (target.alias_used >= target.alias_limit) {
    throw new PersonalAliasCreationError('alias_quota_exceeded', '个人别名额度已用完')
  }

  const domain = await findActiveDomain(options.database, options.domainId)
  if (!domain) {
    throw new PersonalAliasCreationError(
      'domain_unavailable',
      '请选择当前已启用的邮件域名',
      'domainId',
    )
  }
  let normalized
  try {
    normalized = normalizeEmailAddress(options.localPart, domain.canonical_name)
  } catch (error) {
    if (error instanceof AddressValidationError) {
      throw new PersonalAddressInputError('localPart', error.message)
    }
    throw error
  }
  validateLocalPartAgainstAddressPolicy(
    normalized.localPart,
    await readAddressPolicySnapshot(options.database),
  )

  const existingClaim = await options.database
    .prepare('SELECT 1 FROM address_claims WHERE canonical_address = ?1 COLLATE NOCASE LIMIT 1')
    .bind(normalized.canonicalAddress)
    .first()
  if (existingClaim) {
    throw new PersonalAliasCreationError(
      'address_unavailable',
      '该邮箱地址已经被使用或保留',
      'localPart',
    )
  }

  const now = options.now ?? Date.now()
  const sortOrder = await nextSortOrder(options.database, target.id)
  const addressId = crypto.randomUUID()
  const bindingId = crypto.randomUUID()
  const actorCondition = options.asAdministrator ? '' : 'AND self_creation_enabled = 1'
  const statements = [
    options.database
      .prepare(
        `INSERT INTO email_addresses (
          id, domain_id, display_address, canonical_address, created_at
         )
         SELECT ?1, ?2, ?3, ?3, ?4
         WHERE EXISTS (
           SELECT 1
           FROM users
           JOIN user_alias_policies ON user_alias_policies.user_id = users.id
           WHERE users.id = ?5 AND users.status = 'active'
             AND user_alias_policies.alias_limit > (
               SELECT COUNT(*) FROM address_bindings
               WHERE user_id = ?5 AND owner_type = 'user'
                 AND address_role = 'alias' AND ended_at IS NULL
             )
             ${actorCondition}
         )
         AND EXISTS (
           SELECT 1 FROM mail_domains WHERE id = ?2 AND status = 'active'
         )`,
      )
      .bind(addressId, domain.id, normalized.canonicalAddress, now, target.id),
    options.database
      .prepare(
        `INSERT INTO address_claims (
          canonical_address, address_id, status, reserved_until, created_at, updated_at
         ) VALUES (?1, ?2, 'active', NULL, ?3, ?3)`,
      )
      .bind(normalized.canonicalAddress, addressId, now),
    options.database
      .prepare(
        `INSERT INTO address_bindings (
          id, address_id, owner_type, user_id, organization_id,
          address_role, started_at, ended_at, ended_reason
         ) VALUES (?1, ?2, 'user', ?3, NULL, 'alias', ?4, NULL, NULL)`,
      )
      .bind(bindingId, addressId, target.id, now),
    options.database
      .prepare(
        `INSERT INTO user_address_preferences (
          user_id, address_id, custom_label, is_pinned, sort_order,
          is_default_sender, sender_display_name, created_at, updated_at
         ) VALUES (?1, ?2, NULL, 0, ?3, 0, ?4, ?5, ?5)`,
      )
      .bind(target.id, addressId, sortOrder, target.display_name, now),
    createPersonalAliasBindingGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'personal_alias.created',
        targetType: 'email_address',
        targetReference: addressId,
        outcome: 'succeeded',
        reasonCode: options.asAdministrator ? 'administrator_assigned' : 'user_created',
        occurredAt: now,
      },
      { bindingId, addressId, userId: target.id },
    ),
  ]

  try {
    const results = await options.database.batch(statements)
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new PersonalAddressTargetError('state_conflict', '个人别名没有完整建立')
    }
  } catch (error) {
    throw classifyAliasCreationFailure(error)
  }

  return {
    address: {
      id: addressId,
      address: normalized.canonicalAddress,
      domainId: domain.id,
      domainDisplayName: domain.display_name,
      role: 'alias',
      customLabel: null,
      isPinned: false,
      sortOrder,
      isDefaultSender: false,
      createdAt: toIso(now),
    },
    policy: aliasPolicyFromRow({ ...target, alias_used: target.alias_used + 1 }),
  }
}

export async function updatePersonalAddressPreference(options: {
  database: D1Database
  actor: PersonalAddressActor
  addressId: string
  input: UpdatePersonalAddressPreferenceRequest
  audit: AuditContext
  now?: number
}): Promise<PersonalAddressSummary> {
  const target = await findPersonalAddress(
    options.database,
    options.actor.userId,
    options.addressId,
  )
  if (!target) throw new PersonalAddressTargetError('not_found', '该个人邮箱地址不存在')
  const customLabel = normalizeCustomLabel(options.input.customLabel)
  const now = Math.max(options.now ?? Date.now(), target.preference_updated_at + 1)
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE user_address_preferences
         SET custom_label = ?1, is_pinned = ?2, updated_at = ?3
         WHERE user_id = ?4 AND address_id = ?5
           AND EXISTS (
             SELECT 1 FROM address_bindings
             WHERE user_id = ?4 AND address_id = ?5
               AND owner_type = 'user' AND ended_at IS NULL
           )`,
      )
      .bind(customLabel, options.input.isPinned ? 1 : 0, now, options.actor.userId, target.id),
    createPersonalAddressPreferenceGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'personal_address.preference_updated',
        targetType: 'email_address',
        targetReference: target.id,
        outcome: 'succeeded',
        reasonCode: 'user_requested',
        occurredAt: now,
      },
      {
        userId: options.actor.userId,
        addressId: target.id,
        customLabel,
        isPinned: options.input.isPinned,
        sortOrder: target.sort_order,
        isDefaultSender: target.is_default_sender === 1,
        updatedAt: now,
      },
    ),
  ])
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new PersonalAddressTargetError('state_conflict', '地址设置已经发生变化，请刷新后重试')
  }
  return personalAddressFromRow({
    ...target,
    custom_label: customLabel,
    is_pinned: options.input.isPinned ? 1 : 0,
    preference_updated_at: now,
  })
}

export async function setPersonalDefaultSender(options: {
  database: D1Database
  actor: PersonalAddressActor
  addressId: string
  audit: AuditContext
  now?: number
}): Promise<PersonalAddressSummary[]> {
  const target = await findPersonalAddress(
    options.database,
    options.actor.userId,
    options.addressId,
  )
  if (!target) throw new PersonalAddressTargetError('not_found', '该个人邮箱地址不存在')
  if (target.is_default_sender === 1) {
    return listPersonalAddresses(options.database, options.actor.userId)
  }
  const now = Math.max(options.now ?? Date.now(), target.preference_updated_at + 1)
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE user_address_preferences
         SET is_default_sender = 0, updated_at = ?1
         WHERE user_id = ?2 AND is_default_sender = 1
           AND EXISTS (
             SELECT 1 FROM address_bindings
             WHERE user_id = ?2 AND address_id = ?3
               AND owner_type = 'user' AND ended_at IS NULL
           )`,
      )
      .bind(now, options.actor.userId, target.id),
    options.database
      .prepare(
        `UPDATE user_address_preferences
         SET is_default_sender = 1, updated_at = ?1
         WHERE user_id = ?2 AND address_id = ?3
           AND EXISTS (
             SELECT 1 FROM address_bindings
             WHERE user_id = ?2 AND address_id = ?3
               AND owner_type = 'user' AND ended_at IS NULL
           )`,
      )
      .bind(now, options.actor.userId, target.id),
    createPersonalAddressPreferenceGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'personal_address.default_sender_changed',
        targetType: 'email_address',
        targetReference: target.id,
        outcome: 'succeeded',
        reasonCode: 'user_requested',
        occurredAt: now,
      },
      {
        userId: options.actor.userId,
        addressId: target.id,
        customLabel: target.custom_label,
        isPinned: target.is_pinned === 1,
        sortOrder: target.sort_order,
        isDefaultSender: true,
        updatedAt: now,
      },
    ),
  ])
  if (
    (results[0]?.meta.changes ?? 0) < 1 ||
    results[1]?.meta.changes !== 1 ||
    results[2]?.meta.changes !== 1
  ) {
    throw new PersonalAddressTargetError('state_conflict', '默认发件地址没有完整更新')
  }
  return listPersonalAddresses(options.database, options.actor.userId)
}

export async function movePersonalAddress(options: {
  database: D1Database
  actor: PersonalAddressActor
  addressId: string
  direction: 'up' | 'down'
  audit: AuditContext
  now?: number
}): Promise<{ addresses: PersonalAddressSummary[]; changed: boolean }> {
  const rows = await listPersonalAddressRows(options.database, options.actor.userId)
  const index = rows.findIndex((address) => address.id === options.addressId)
  if (index < 0) throw new PersonalAddressTargetError('not_found', '该个人邮箱地址不存在')
  const target = rows[index]
  if (!target) throw new PersonalAddressTargetError('not_found', '该个人邮箱地址不存在')
  const candidates = rows.filter((address) => address.is_pinned === target.is_pinned)
  const candidateIndex = candidates.findIndex((address) => address.id === target.id)
  const neighbor = candidates[candidateIndex + (options.direction === 'up' ? -1 : 1)]
  if (!neighbor) return { addresses: rows.map(personalAddressFromRow), changed: false }

  const now = Math.max(
    options.now ?? Date.now(),
    target.preference_updated_at + 1,
    neighbor.preference_updated_at + 1,
  )
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE user_address_preferences
         SET sort_order = CASE
               WHEN address_id = ?1 THEN ?2
               WHEN address_id = ?3 THEN ?4
             END,
             updated_at = ?5
         WHERE user_id = ?6
           AND (
             (address_id = ?1 AND sort_order = ?4)
             OR (address_id = ?3 AND sort_order = ?2)
           )
           AND 2 = (
             SELECT COUNT(*) FROM user_address_preferences
             WHERE user_id = ?6
               AND (
                 (address_id = ?1 AND sort_order = ?4)
                 OR (address_id = ?3 AND sort_order = ?2)
               )
           )`,
      )
      .bind(
        target.id,
        neighbor.sort_order,
        neighbor.id,
        target.sort_order,
        now,
        options.actor.userId,
      ),
    createPersonalAddressPreferenceGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'personal_address.order_changed',
        targetType: 'user',
        targetReference: options.actor.userId,
        outcome: 'succeeded',
        reasonCode: options.direction,
        occurredAt: now,
      },
      {
        userId: options.actor.userId,
        addressId: target.id,
        customLabel: target.custom_label,
        isPinned: target.is_pinned === 1,
        sortOrder: neighbor.sort_order,
        isDefaultSender: target.is_default_sender === 1,
        updatedAt: now,
      },
    ),
  ])
  if (results[0]?.meta.changes !== 2 || results[1]?.meta.changes !== 1) {
    throw new PersonalAddressTargetError('state_conflict', '地址顺序已经发生变化，请刷新后重试')
  }
  return {
    addresses: await listPersonalAddresses(options.database, options.actor.userId),
    changed: true,
  }
}

export async function deletePersonalAlias(options: {
  database: D1Database
  actor: PersonalAddressActor
  targetUserId: string
  asAdministrator: boolean
  addressId: string
  audit: AuditContext
  now?: number
}) {
  authorizeTargetUser(options.actor, options.targetUserId, options.asAdministrator)
  const target = await findPersonalAddress(
    options.database,
    options.targetUserId,
    options.addressId,
  )
  if (!target) throw new PersonalAddressTargetError('not_found', '该个人邮箱地址不存在')
  if (target.address_role === 'primary') {
    throw new PersonalAddressTargetError('primary_protected', '主邮箱地址不能单独删除')
  }
  const primary = (await listPersonalAddressRows(options.database, options.targetUserId)).find(
    (address) => address.address_role === 'primary',
  )
  if (!primary) throw new PersonalAddressTargetError('state_conflict', '用户当前没有可用主地址')

  const now = options.now ?? Date.now()
  const addressPolicy = await readAddressPolicySnapshot(options.database)
  const retentionDays = addressPolicy.aliasRetentionDays
  const reservedUntil = retentionDays > 0 ? now + retentionDays * 86_400_000 : null
  const deletionOperationId = crypto.randomUUID()
  const releaseStepId = crypto.randomUUID()
  const reconcileStepId = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `UPDATE address_bindings
         SET ended_at = ?1, ended_reason = 'alias_deleted'
         WHERE id = ?2 AND address_id = ?3 AND user_id = ?4
           AND owner_type = 'user' AND address_role = 'alias' AND ended_at IS NULL`,
      )
      .bind(now, target.binding_id, target.id, options.targetUserId),
    options.database
      .prepare(
        `DELETE FROM user_address_preferences
         WHERE user_id = ?1 AND address_id = ?2
           AND EXISTS (
             SELECT 1 FROM address_bindings
             WHERE id = ?3 AND ended_at = ?4
           )`,
      )
      .bind(options.targetUserId, target.id, target.binding_id, now),
    reservedUntil === null
      ? options.database
          .prepare(
            `DELETE FROM address_claims
             WHERE address_id = ?1 AND status = 'active'
               AND EXISTS (
                 SELECT 1 FROM address_bindings
                 WHERE id = ?2 AND ended_at = ?3
               )`,
          )
          .bind(target.id, target.binding_id, now)
      : options.database
          .prepare(
            `UPDATE address_claims
             SET status = 'reserved', reserved_until = ?1, updated_at = ?2
             WHERE address_id = ?3 AND status = 'active' AND reserved_until IS NULL
               AND EXISTS (
                 SELECT 1 FROM address_bindings
                 WHERE id = ?4 AND ended_at = ?2
               )`,
          )
          .bind(reservedUntil, now, target.id, target.binding_id),
    options.database
      .prepare(
        `UPDATE email_addresses
         SET retired_at = ?1
         WHERE id = ?2 AND retired_at IS NULL`,
      )
      .bind(now, target.id),
    options.database
      .prepare(
        `INSERT INTO deletion_operations (
          id, operation_kind, target_type, target_reference,
          requested_by_user_id, policy_version, is_recoverable,
          requested_at, recovery_due_at, operation_status,
          completed_at, created_at, updated_at
         ) VALUES (
          ?1, 'alias_release', 'email_address', ?2,
          ?3, ?4, 0, ?5, NULL, 'ready', NULL, ?5, ?5
         )`,
      )
      .bind(deletionOperationId, target.id, options.actor.userId, addressPolicy.policyVersion, now),
    options.database
      .prepare(
        `INSERT INTO deletion_operation_steps (
          id, deletion_operation_id, step_key, sequence_number,
          step_kind, is_required, step_status, attempt_count,
          next_attempt_at, started_at, completed_at, created_at, updated_at
         ) VALUES (
          ?1, ?2, 'release_address_claim', 0,
          'release_identity', 1, ?3, 0,
          ?4, NULL, ?5, ?6, ?6
         )`,
      )
      .bind(
        releaseStepId,
        deletionOperationId,
        reservedUntil === null ? 'succeeded' : 'pending',
        reservedUntil,
        reservedUntil === null ? now : null,
        now,
      ),
    options.database
      .prepare(
        `INSERT INTO deletion_operation_steps (
          id, deletion_operation_id, step_key, sequence_number,
          step_kind, is_required, step_status, attempt_count,
          next_attempt_at, started_at, completed_at, created_at, updated_at
         ) VALUES (
          ?1, ?2, 'reconcile_address_release', 1,
          'reconcile', 1, ?3, 0,
          ?4, NULL, ?5, ?6, ?6
         )`,
      )
      .bind(
        reconcileStepId,
        deletionOperationId,
        reservedUntil === null ? 'succeeded' : 'pending',
        reservedUntil,
        reservedUntil === null ? now : null,
        now,
      ),
  ]
  if (reservedUntil === null) {
    statements.push(
      options.database
        .prepare(
          `UPDATE deletion_operations
           SET operation_status = 'completed', completed_at = ?1, updated_at = ?1
           WHERE id = ?2 AND operation_status = 'ready'`,
        )
        .bind(now, deletionOperationId),
    )
  } else {
    const taskId = crypto.randomUUID()
    const taskKeyDigest = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          `alias_release:${target.id}:${reservedUntil}:${addressPolicy.policyVersion}`,
        ),
      ),
    )
    statements.push(
      options.database
        .prepare(
          `INSERT INTO background_tasks (
            id, task_type, target_type, target_reference, input_version,
            task_key_digest, task_status, priority, attempt_count,
            max_attempts, next_attempt_at, lease_owner_reference,
            lease_token, lease_expires_at, created_at, updated_at
           ) VALUES (
            ?1, 'alias_release', 'deletion_operation', ?2, ?3,
            ?4, 'pending', 5, 0, 10, ?5, NULL, 0, NULL, ?6, ?6
           )`,
        )
        .bind(
          taskId,
          deletionOperationId,
          addressPolicy.policyVersion,
          taskKeyDigest,
          reservedUntil,
          now,
        ),
    )
  }
  if (target.is_default_sender === 1) {
    statements.push(
      options.database
        .prepare(
          `UPDATE user_address_preferences
           SET is_default_sender = 1, updated_at = ?1
           WHERE user_id = ?2 AND address_id = ?3
             AND EXISTS (
               SELECT 1 FROM address_bindings
               WHERE user_id = ?2 AND address_id = ?3
                 AND address_role = 'primary' AND ended_at IS NULL
             )`,
        )
        .bind(now, options.targetUserId, primary.id),
    )
  }
  statements.push(
    createDeletedPersonalAliasGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'personal_alias.deleted',
        targetType: 'email_address',
        targetReference: target.id,
        outcome: 'succeeded',
        reasonCode: options.asAdministrator ? 'administrator_deleted' : 'user_deleted',
        occurredAt: now,
      },
      {
        bindingId: target.binding_id,
        addressId: target.id,
        endedAt: now,
        reservedUntil,
      },
    ),
  )

  const results = await options.database.batch(statements)
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new PersonalAddressTargetError('state_conflict', '个人别名已经发生变化，请刷新后重试')
  }

  const policy = await findAliasPolicyUser(options.database, options.targetUserId)
  if (!policy) throw new PersonalAddressTargetError('state_conflict', '用户别名策略不存在')
  const remainingAddresses = await listPersonalAddresses(options.database, options.targetUserId)
  const defaultSender = remainingAddresses.find((address) => address.isDefaultSender)
  if (!defaultSender) {
    throw new PersonalAddressTargetError('state_conflict', '用户当前没有默认发件地址')
  }
  return {
    deletedAddressId: target.id,
    canonicalAddress: target.canonical_address,
    releasedImmediately: reservedUntil === null,
    retentionDays,
    releaseAt: reservedUntil === null ? null : toIso(reservedUntil),
    deletionOperationId,
    defaultSenderAddressId: defaultSender.id,
    policy: aliasPolicyFromRow(policy),
  }
}

async function listPersonalAddresses(
  database: D1Database,
  userId: string,
): Promise<PersonalAddressSummary[]> {
  return (await listPersonalAddressRows(database, userId)).map(personalAddressFromRow)
}

async function listPersonalAddressRows(
  database: D1Database,
  userId: string,
): Promise<PersonalAddressRow[]> {
  const result = await database
    .prepare(
      `SELECT
        email_addresses.id,
        email_addresses.canonical_address,
        email_addresses.domain_id,
        mail_domains.display_name AS domain_display_name,
        address_bindings.address_role,
        address_bindings.id AS binding_id,
        user_address_preferences.custom_label,
        user_address_preferences.is_pinned,
        user_address_preferences.sort_order,
        user_address_preferences.is_default_sender,
        user_address_preferences.updated_at AS preference_updated_at,
        email_addresses.created_at
       FROM address_bindings
       JOIN email_addresses ON email_addresses.id = address_bindings.address_id
       JOIN mail_domains ON mail_domains.id = email_addresses.domain_id
       JOIN user_address_preferences
         ON user_address_preferences.user_id = address_bindings.user_id
        AND user_address_preferences.address_id = address_bindings.address_id
       WHERE address_bindings.user_id = ?1
         AND address_bindings.owner_type = 'user'
         AND address_bindings.address_role IN ('primary', 'alias')
         AND address_bindings.ended_at IS NULL
       ORDER BY user_address_preferences.is_pinned DESC,
                user_address_preferences.sort_order,
                email_addresses.canonical_address,
                email_addresses.id`,
    )
    .bind(userId)
    .all<PersonalAddressRow>()
  return result.results
}

async function findPersonalAddress(
  database: D1Database,
  userId: string,
  addressId: string,
): Promise<PersonalAddressRow | null> {
  if (!isUuid(addressId)) return null
  return database
    .prepare(
      `SELECT
        email_addresses.id,
        email_addresses.canonical_address,
        email_addresses.domain_id,
        mail_domains.display_name AS domain_display_name,
        address_bindings.address_role,
        address_bindings.id AS binding_id,
        user_address_preferences.custom_label,
        user_address_preferences.is_pinned,
        user_address_preferences.sort_order,
        user_address_preferences.is_default_sender,
        user_address_preferences.updated_at AS preference_updated_at,
        email_addresses.created_at
       FROM address_bindings
       JOIN email_addresses ON email_addresses.id = address_bindings.address_id
       JOIN mail_domains ON mail_domains.id = email_addresses.domain_id
       JOIN user_address_preferences
         ON user_address_preferences.user_id = address_bindings.user_id
        AND user_address_preferences.address_id = address_bindings.address_id
       WHERE address_bindings.user_id = ?1 AND address_bindings.address_id = ?2
         AND address_bindings.owner_type = 'user'
         AND address_bindings.address_role IN ('primary', 'alias')
         AND address_bindings.ended_at IS NULL
       LIMIT 1`,
    )
    .bind(userId, addressId)
    .first<PersonalAddressRow>()
}

async function findAliasPolicyUser(
  database: D1Database,
  userId: string,
): Promise<AliasPolicyUserRow | null> {
  if (!isUuid(userId)) return null
  return database
    .prepare(`${aliasPolicyUsersSql()} HAVING users.id = ?1 LIMIT 1`)
    .bind(userId)
    .first<AliasPolicyUserRow>()
}

function aliasPolicyUsersSql(): string {
  return `SELECT
    users.id,
    users.display_name,
    users.status,
    primary_address.canonical_address AS primary_address,
    user_alias_policies.alias_limit,
    user_alias_policies.self_creation_enabled,
    user_alias_policies.created_at,
    user_alias_policies.updated_at,
    COUNT(alias_bindings.id) AS alias_used
   FROM users
   JOIN user_alias_policies ON user_alias_policies.user_id = users.id
   JOIN address_bindings AS primary_binding
     ON primary_binding.user_id = users.id
    AND primary_binding.owner_type = 'user'
    AND primary_binding.address_role = 'primary'
    AND primary_binding.ended_at IS NULL
   JOIN email_addresses AS primary_address ON primary_address.id = primary_binding.address_id
   LEFT JOIN address_bindings AS alias_bindings
     ON alias_bindings.user_id = users.id
    AND alias_bindings.owner_type = 'user'
    AND alias_bindings.address_role = 'alias'
    AND alias_bindings.ended_at IS NULL
   WHERE users.status IN ('active', 'disabled')
   GROUP BY users.id`
}

async function listActiveDomains(database: D1Database): Promise<ActiveDomainRow[]> {
  const result = await database
    .prepare(
      `SELECT id, display_name, canonical_name
       FROM mail_domains
       WHERE status = 'active'
       ORDER BY canonical_name, id`,
    )
    .all<ActiveDomainRow>()
  return result.results
}

async function findActiveDomain(
  database: D1Database,
  domainId: string,
): Promise<ActiveDomainRow | null> {
  if (!isUuid(domainId)) return null
  return database
    .prepare(
      `SELECT id, display_name, canonical_name
       FROM mail_domains WHERE id = ?1 AND status = 'active' LIMIT 1`,
    )
    .bind(domainId)
    .first<ActiveDomainRow>()
}

async function nextSortOrder(database: D1Database, userId: string): Promise<number> {
  const result = await database
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
       FROM user_address_preferences WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<{ next_order: number }>()
  return result?.next_order ?? 0
}

function requireAdministrator(actor: PersonalAddressActor): void {
  if (!actor.isAdministrator)
    throw new PersonalAddressPermissionError('只有系统管理员可以修改用户别名策略')
}

function authorizeTargetUser(
  actor: PersonalAddressActor,
  targetUserId: string,
  asAdministrator: boolean,
): void {
  if (
    !isUuid(targetUserId) ||
    (asAdministrator && !actor.isAdministrator) ||
    (!asAdministrator && actor.userId !== targetUserId)
  ) {
    throw new PersonalAddressPermissionError()
  }
}

function normalizeCustomLabel(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.trim()
  if (!normalized) return null
  if ([...normalized].length > 80 || containsControlCharacter(normalized)) {
    throw new PersonalAddressInputError('customLabel', '地址显示名称最多包含 80 个有效字符')
  }
  return normalized
}

function classifyAliasCreationFailure(error: unknown): Error {
  if (error instanceof PersonalAddressTargetError || error instanceof PersonalAliasCreationError) {
    return error
  }
  if (error instanceof Error) {
    if (/额度已用完/iu.test(error.message)) {
      return new PersonalAliasCreationError('alias_quota_exceeded', '个人别名额度已用完')
    }
    if (/没有可用的个人别名策略/iu.test(error.message)) {
      return new PersonalAliasCreationError('user_unavailable', '目标用户当前不能建立个人别名')
    }
    if (/个人别名地址不可用/iu.test(error.message)) {
      return new PersonalAliasCreationError(
        'domain_unavailable',
        '邮件域名或地址当前不可用',
        'domainId',
      )
    }
    if (/unique constraint|foreign key constraint|not null constraint/iu.test(error.message)) {
      return new PersonalAliasCreationError(
        'address_unavailable',
        '该邮箱地址已经被使用或当前不能创建',
        'localPart',
      )
    }
  }
  return error instanceof Error ? error : new Error('个人别名创建失败')
}

function personalAddressFromRow(row: PersonalAddressRow): PersonalAddressSummary {
  return {
    id: row.id,
    address: row.canonical_address,
    domainId: row.domain_id,
    domainDisplayName: row.domain_display_name,
    role: row.address_role as 'primary' | 'alias',
    customLabel: row.custom_label,
    isPinned: row.is_pinned === 1,
    sortOrder: row.sort_order,
    isDefaultSender: row.is_default_sender === 1,
    createdAt: toIso(row.created_at),
  }
}

function aliasPolicyFromRow(row: AliasPolicyUserRow): UserAliasPolicySummary {
  return {
    aliasLimit: row.alias_limit,
    aliasUsed: row.alias_used,
    selfCreationEnabled: row.self_creation_enabled === 1,
    overLimit: row.alias_used > row.alias_limit,
  }
}

function administratorAliasPolicyUserFromRow(
  row: AliasPolicyUserRow,
  aliases: PersonalAddressSummary[],
): AdministratorAliasPolicyUser {
  return {
    id: row.id,
    displayName: row.display_name,
    primaryAddress: row.primary_address,
    status: row.status as 'active' | 'disabled',
    policy: aliasPolicyFromRow(row),
    aliases,
  }
}

function domainSummary(domain: ActiveDomainRow) {
  return {
    id: domain.id,
    displayName: domain.display_name,
    canonicalName: domain.canonical_name,
  }
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
