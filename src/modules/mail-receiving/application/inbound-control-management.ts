import type {
  InboundAddressSummary,
  InboundControlScopeType,
  InboundDomainSummary,
  InboundReceiveStatus,
  InboundRejectionRule,
  InboundRejectionRuleStatus,
  InboundRejectionRuleType,
  InboundUserSummary,
} from '../../../shared/contracts/inbound-control'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'
import {
  AddressValidationError,
  normalizeDomain,
  normalizeRecipientEmailAddress,
} from '../../addresses/domain/email-address'

interface AdministratorActor {
  userId: string
  isAdministrator: boolean
}

interface DomainRow {
  id: string
  canonical_name: string
  display_name: string
  domain_status: 'active' | 'paused'
  catch_all_mode: 'reject' | 'unallocated'
  receive_status: InboundReceiveStatus | null
  unallocated_access_user_ids: string | null
  unallocated_message_count: number
}

interface AddressRow {
  id: string
  canonical_address: string
  owner_type: 'user' | 'organization'
  owner_name: string
  receive_status: InboundReceiveStatus | null
}

interface UserRow {
  id: string
  display_name: string
  primary_address: string
  user_status: string
  receive_status: InboundReceiveStatus | null
}

interface RuleRow {
  id: string
  rule_type: InboundRejectionRuleType
  match_value: string
  rule_status: InboundRejectionRuleStatus
  created_at: number
  updated_at: number
}

export class InboundControlPermissionError extends Error {
  constructor() {
    super('只有系统管理员可以管理收信控制')
  }
}

export class InboundControlInputError extends Error {
  constructor(
    readonly field:
      | 'scopeType'
      | 'scopeId'
      | 'status'
      | 'ruleType'
      | 'matchValue'
      | 'ruleId'
      | 'mode'
      | 'enabled',
    message: string,
  ) {
    super(message)
  }
}

export class InboundControlTargetError extends Error {
  constructor(
    readonly code: 'not_found' | 'state_conflict' | 'rule_conflict',
    message: string,
  ) {
    super(message)
  }
}

export async function getInboundControlOverview(options: {
  database: D1Database
  actor: AdministratorActor
}): Promise<{
  domains: InboundDomainSummary[]
  addresses: InboundAddressSummary[]
  users: InboundUserSummary[]
  rules: InboundRejectionRule[]
}> {
  requireAdministrator(options.actor)
  const [domains, addresses, users, rules] = await Promise.all([
    options.database
      .prepare(
        `SELECT domain.id, domain.canonical_name, domain.display_name,
                domain.status AS domain_status, domain.catch_all_mode,
                control.receive_status,
                GROUP_CONCAT(grant_access.user_id) AS unallocated_access_user_ids,
                (
                  SELECT COUNT(*)
                  FROM unallocated_message_deliveries AS delivery
                  JOIN unallocated_address_periods AS period
                    ON period.id = delivery.unallocated_period_id
                  WHERE period.domain_id = domain.id
                    AND period.period_status = 'open'
                ) AS unallocated_message_count
         FROM mail_domains AS domain
         LEFT JOIN inbound_receive_controls AS control
           ON control.scope_type = 'domain' AND control.domain_id = domain.id
         LEFT JOIN unallocated_access_grants AS grant_access
           ON grant_access.domain_id = domain.id
         WHERE domain.status IN ('active', 'paused')
         GROUP BY domain.id
         ORDER BY domain.created_at, domain.id`,
      )
      .all<DomainRow>(),
    options.database
      .prepare(
        `SELECT address.id, address.canonical_address, binding.owner_type,
                CASE binding.owner_type
                  WHEN 'user' THEN user.display_name
                  ELSE organization.name
                END AS owner_name,
                control.receive_status
         FROM email_addresses AS address
         JOIN address_bindings AS binding
           ON binding.address_id = address.id AND binding.ended_at IS NULL
         LEFT JOIN users AS user ON user.id = binding.user_id
         LEFT JOIN organizations AS organization ON organization.id = binding.organization_id
         LEFT JOIN inbound_receive_controls AS control
           ON control.scope_type = 'address' AND control.address_id = address.id
         WHERE address.retired_at IS NULL
         ORDER BY address.canonical_address, address.id`,
      )
      .all<AddressRow>(),
    options.database
      .prepare(
        `SELECT user.id, user.display_name, user.status AS user_status,
                address.canonical_address AS primary_address,
                control.receive_status
         FROM users AS user
         JOIN address_bindings AS binding
           ON binding.user_id = user.id
          AND binding.owner_type = 'user'
          AND binding.address_role = 'primary'
          AND binding.ended_at IS NULL
         JOIN email_addresses AS address ON address.id = binding.address_id
         LEFT JOIN inbound_receive_controls AS control
           ON control.scope_type = 'user' AND control.user_id = user.id
         WHERE user.status <> 'deleted'
         ORDER BY user.created_at, user.id`,
      )
      .all<UserRow>(),
    options.database
      .prepare(
        `SELECT id, rule_type, match_value, rule_status, created_at, updated_at
         FROM inbound_rejection_rules
         ORDER BY created_at, id`,
      )
      .all<RuleRow>(),
  ])

  return {
    domains: domains.results.map((row) => ({
      id: row.id,
      canonicalName: row.canonical_name,
      displayName: row.display_name,
      domainStatus: row.domain_status,
      catchAllMode: row.catch_all_mode,
      receiveStatus: row.receive_status ?? 'accepting',
      unallocatedAccessUserIds: row.unallocated_access_user_ids
        ? row.unallocated_access_user_ids.split(',')
        : [],
      unallocatedMessageCount: row.unallocated_message_count,
    })),
    addresses: addresses.results.map((row) => ({
      id: row.id,
      canonicalAddress: row.canonical_address,
      ownerType: row.owner_type,
      ownerName: row.owner_name,
      receiveStatus: row.receive_status ?? 'accepting',
    })),
    users: users.results.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      primaryAddress: row.primary_address,
      userStatus: row.user_status,
      receiveStatus: row.receive_status ?? 'accepting',
    })),
    rules: rules.results.map(ruleFromRow),
  }
}

export async function changeDomainCatchAllMode(options: {
  database: D1Database
  actor: AdministratorActor
  domainId: string
  mode: 'reject' | 'unallocated'
  audit: AuditContext
  now?: number
}): Promise<{ domainId: string; mode: 'reject' | 'unallocated'; changed: boolean }> {
  requireAdministrator(options.actor)
  const current = await options.database
    .prepare(
      `SELECT catch_all_mode, updated_at FROM mail_domains
       WHERE id = ?1 AND status IN ('active', 'paused') LIMIT 1`,
    )
    .bind(options.domainId)
    .first<{ catch_all_mode: 'reject' | 'unallocated'; updated_at: number }>()
  if (!current) throw new InboundControlTargetError('not_found', '邮件域名不存在')
  if (current.catch_all_mode === options.mode) {
    return { domainId: options.domainId, mode: options.mode, changed: false }
  }
  const now = Math.max(options.now ?? Date.now(), current.updated_at + 1)
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `UPDATE mail_domains
         SET catch_all_mode = ?1, updated_at = ?2
         WHERE id = ?3 AND catch_all_mode = ?4 AND updated_at = ?5`,
      )
      .bind(options.mode, now, options.domainId, current.catch_all_mode, current.updated_at),
  ]
  if (options.mode === 'reject') {
    statements.push(
      options.database
        .prepare('DELETE FROM unallocated_access_grants WHERE domain_id = ?1')
        .bind(options.domainId),
    )
  }
  statements.push(
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actor.userId,
      actionName: 'inbound_catch_all.changed',
      targetType: 'mail_domain',
      targetReference: options.domainId,
      outcome: 'succeeded',
      reasonCode: options.mode,
      occurredAt: now,
    }),
  )
  const results = await options.database.batch(statements)
  if (results[0]?.meta.changes !== 1 || results.at(-1)?.meta.changes !== 1) {
    throw new InboundControlTargetError('state_conflict', '全域收信设置已经变化，请刷新后重试')
  }
  return { domainId: options.domainId, mode: options.mode, changed: true }
}

export async function changeUnallocatedAccessGrant(options: {
  database: D1Database
  actor: AdministratorActor
  domainId: string
  userId: string
  enabled: boolean
  audit: AuditContext
  now?: number
}): Promise<{ domainId: string; userId: string; enabled: boolean; changed: boolean }> {
  requireAdministrator(options.actor)
  const target = await options.database
    .prepare(
      `SELECT 1 AS present
       FROM mail_domains AS domain
       JOIN users AS user ON user.id = ?2 AND user.status = 'active'
       WHERE domain.id = ?1 AND domain.status = 'active'
         AND domain.catch_all_mode = 'unallocated'
       LIMIT 1`,
    )
    .bind(options.domainId, options.userId)
    .first()
  if (!target) {
    throw new InboundControlTargetError(
      'state_conflict',
      '只有启用全域收信的活动域名才能授权当前启用用户',
    )
  }
  const existing = await options.database
    .prepare(
      `SELECT 1 AS present FROM unallocated_access_grants
       WHERE domain_id = ?1 AND user_id = ?2 LIMIT 1`,
    )
    .bind(options.domainId, options.userId)
    .first()
  if (Boolean(existing) === options.enabled) {
    return {
      domainId: options.domainId,
      userId: options.userId,
      enabled: options.enabled,
      changed: false,
    }
  }
  const now = options.now ?? Date.now()
  const mutation = options.enabled
    ? options.database
        .prepare(
          `INSERT INTO unallocated_access_grants (
            domain_id, user_id, granted_by_user_id, created_at
           ) VALUES (?1, ?2, ?3, ?4)`,
        )
        .bind(options.domainId, options.userId, options.actor.userId, now)
    : options.database
        .prepare(
          `DELETE FROM unallocated_access_grants
           WHERE domain_id = ?1 AND user_id = ?2`,
        )
        .bind(options.domainId, options.userId)
  const results = await options.database.batch([
    mutation,
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actor.userId,
      actionName: options.enabled ? 'unallocated_access.granted' : 'unallocated_access.revoked',
      targetType: 'unallocated_access',
      targetReference: `${options.domainId}:${options.userId}`,
      outcome: 'succeeded',
      reasonCode: 'administrator_requested',
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new InboundControlTargetError('state_conflict', '未分配来信授权已经变化，请刷新后重试')
  }
  return {
    domainId: options.domainId,
    userId: options.userId,
    enabled: options.enabled,
    changed: true,
  }
}

export async function changeInboundReceiveStatus(options: {
  database: D1Database
  actor: AdministratorActor
  scopeType: InboundControlScopeType
  scopeId: string
  status: InboundReceiveStatus
  audit: AuditContext
  now?: number
}): Promise<{
  scopeType: InboundControlScopeType
  scopeId: string
  status: InboundReceiveStatus
  changed: boolean
}> {
  requireAdministrator(options.actor)
  if (!isUuid(options.scopeId))
    throw new InboundControlTargetError('not_found', '收信控制目标不存在')
  const targetExists = await options.database
    .prepare(targetExistsSql(options.scopeType))
    .bind(options.scopeId)
    .first()
  if (!targetExists) throw new InboundControlTargetError('not_found', '收信控制目标不存在')

  const existing = await options.database
    .prepare(
      `SELECT id, receive_status
       FROM inbound_receive_controls
       WHERE scope_type = ?1
         AND ((?1 = 'domain' AND domain_id = ?2)
           OR (?1 = 'address' AND address_id = ?2)
           OR (?1 = 'user' AND user_id = ?2))
       LIMIT 1`,
    )
    .bind(options.scopeType, options.scopeId)
    .first<{ id: string; receive_status: InboundReceiveStatus }>()
  const currentStatus = existing?.receive_status ?? 'accepting'
  if (currentStatus === options.status) {
    return {
      scopeType: options.scopeType,
      scopeId: options.scopeId,
      status: options.status,
      changed: false,
    }
  }

  const now = options.now ?? Date.now()
  const controlId = existing?.id ?? crypto.randomUUID()
  const targetColumns = {
    domain: [options.scopeId, null, null],
    address: [null, options.scopeId, null],
    user: [null, null, options.scopeId],
  }[options.scopeType]
  const results = await options.database.batch([
    options.database
      .prepare(
        `INSERT INTO inbound_receive_controls (
          id, scope_type, domain_id, address_id, user_id, receive_status,
          updated_by_user_id, paused_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         ON CONFLICT(id) DO UPDATE SET
          receive_status = excluded.receive_status,
          updated_by_user_id = excluded.updated_by_user_id,
          paused_at = excluded.paused_at,
          updated_at = excluded.updated_at`,
      )
      .bind(
        controlId,
        options.scopeType,
        ...targetColumns,
        options.status,
        options.actor.userId,
        options.status === 'paused' ? now : null,
        now,
      ),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actor.userId,
      actionName:
        options.status === 'paused' ? 'inbound_receive.paused' : 'inbound_receive.resumed',
      targetType: `inbound_${options.scopeType}`,
      targetReference: options.scopeId,
      outcome: 'succeeded',
      reasonCode: 'administrator_requested',
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new InboundControlTargetError('state_conflict', '收信控制状态已经变化，请刷新后重试')
  }
  return {
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    status: options.status,
    changed: true,
  }
}

export async function createInboundRejectionRule(options: {
  database: D1Database
  actor: AdministratorActor
  ruleType: InboundRejectionRuleType
  matchValue: string
  audit: AuditContext
  now?: number
}): Promise<InboundRejectionRule> {
  requireAdministrator(options.actor)
  const normalizedValue = normalizeRuleValue(options.ruleType, options.matchValue)
  const id = crypto.randomUUID()
  const now = options.now ?? Date.now()
  try {
    const results = await options.database.batch([
      options.database
        .prepare(
          `INSERT INTO inbound_rejection_rules (
            id, rule_type, match_value, rule_status,
            created_by_user_id, updated_by_user_id, created_at, updated_at
           ) VALUES (?1, ?2, ?3, 'active', ?4, ?4, ?5, ?5)`,
        )
        .bind(id, options.ruleType, normalizedValue, options.actor.userId, now),
      createAuditEventStatement(options.database, {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'inbound_rejection_rule.created',
        targetType: 'inbound_rejection_rule',
        targetReference: id,
        outcome: 'succeeded',
        reasonCode: options.ruleType,
        occurredAt: now,
      }),
    ])
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new InboundControlTargetError('state_conflict', '拒收规则没有完整建立')
    }
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new InboundControlTargetError('rule_conflict', '相同的拒收规则已经存在')
    }
    throw error
  }
  return {
    id,
    ruleType: options.ruleType,
    matchValue: normalizedValue,
    status: 'active',
    createdAt: toIso(now),
    updatedAt: toIso(now),
  }
}

export async function changeInboundRejectionRuleStatus(options: {
  database: D1Database
  actor: AdministratorActor
  ruleId: string
  status: InboundRejectionRuleStatus
  audit: AuditContext
  now?: number
}): Promise<{ rule: InboundRejectionRule; changed: boolean }> {
  requireAdministrator(options.actor)
  const current = await findRule(options.database, options.ruleId)
  if (!current) throw new InboundControlTargetError('not_found', '拒收规则不存在')
  if (current.rule_status === options.status) return { rule: ruleFromRow(current), changed: false }
  const now = Math.max(options.now ?? Date.now(), current.updated_at + 1)
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE inbound_rejection_rules
         SET rule_status = ?1, updated_by_user_id = ?2, updated_at = ?3
         WHERE id = ?4 AND rule_status = ?5 AND updated_at = ?6`,
      )
      .bind(
        options.status,
        options.actor.userId,
        now,
        current.id,
        current.rule_status,
        current.updated_at,
      ),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actor.userId,
      actionName:
        options.status === 'active'
          ? 'inbound_rejection_rule.resumed'
          : 'inbound_rejection_rule.paused',
      targetType: 'inbound_rejection_rule',
      targetReference: current.id,
      outcome: 'succeeded',
      reasonCode: current.rule_type,
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new InboundControlTargetError('state_conflict', '拒收规则状态已经变化，请刷新后重试')
  }
  return {
    rule: ruleFromRow({ ...current, rule_status: options.status, updated_at: now }),
    changed: true,
  }
}

export async function deleteInboundRejectionRule(options: {
  database: D1Database
  actor: AdministratorActor
  ruleId: string
  audit: AuditContext
  now?: number
}): Promise<{ deletedRuleId: string }> {
  requireAdministrator(options.actor)
  const current = await findRule(options.database, options.ruleId)
  if (!current) throw new InboundControlTargetError('not_found', '拒收规则不存在')
  const now = options.now ?? Date.now()
  const results = await options.database.batch([
    options.database.prepare('DELETE FROM inbound_rejection_rules WHERE id = ?1').bind(current.id),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actor.userId,
      actionName: 'inbound_rejection_rule.deleted',
      targetType: 'inbound_rejection_rule',
      targetReference: current.id,
      outcome: 'succeeded',
      reasonCode: current.rule_type,
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new InboundControlTargetError('state_conflict', '拒收规则已经变化，请刷新后重试')
  }
  return { deletedRuleId: current.id }
}

function targetExistsSql(scopeType: InboundControlScopeType): string {
  if (scopeType === 'domain') {
    return `SELECT 1 FROM mail_domains WHERE id = ?1 AND status IN ('active', 'paused') LIMIT 1`
  }
  if (scopeType === 'address') {
    return `SELECT 1 FROM email_addresses
            WHERE id = ?1 AND retired_at IS NULL LIMIT 1`
  }
  return `SELECT 1 FROM users WHERE id = ?1 AND status <> 'deleted' LIMIT 1`
}

function normalizeRuleValue(type: InboundRejectionRuleType, input: string): string {
  const value = input.trim()
  if (!value) throw new InboundControlInputError('matchValue', '拒收匹配内容不能为空')
  try {
    if (type === 'sender_address') {
      return normalizeRecipientEmailAddress(value).canonicalAddress
    }
    if (type === 'sender_domain') return normalizeDomain(value).canonicalDomain
  } catch (error) {
    if (error instanceof AddressValidationError) {
      throw new InboundControlInputError('matchValue', error.message)
    }
    throw error
  }
  const normalized = value.normalize('NFC').toLocaleLowerCase()
  if (normalized.length > 200) {
    throw new InboundControlInputError('matchValue', '主题或正文关键词不能超过 200 个字符')
  }
  return normalized
}

async function findRule(database: D1Database, ruleId: string): Promise<RuleRow | null> {
  if (!isUuid(ruleId)) return null
  return database
    .prepare(
      `SELECT id, rule_type, match_value, rule_status, created_at, updated_at
       FROM inbound_rejection_rules WHERE id = ?1 LIMIT 1`,
    )
    .bind(ruleId)
    .first<RuleRow>()
}

function ruleFromRow(row: RuleRow): InboundRejectionRule {
  return {
    id: row.id,
    ruleType: row.rule_type,
    matchValue: row.match_value,
    status: row.rule_status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function requireAdministrator(actor: AdministratorActor): void {
  if (!actor.isAdministrator) throw new InboundControlPermissionError()
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /unique constraint/iu.test(error.message)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function toIso(value: number): string {
  return new Date(value).toISOString()
}
