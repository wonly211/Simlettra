import type {
  AddressPolicySummary,
  UpdateAddressPolicyRequest,
} from '../../../shared/contracts/address-policy-management'
import {
  createAddressPolicyGuardedAuditEventStatement,
  type AuditContext,
} from '../../audit/public'
import { AddressValidationError, normalizeLocalPart } from '../domain/email-address'
import type { PersonalAddressActor } from './personal-address-management'

interface AddressPolicySettingsRow {
  minimum_local_part_length: number
  alias_retention_days: number
  policy_version: number
  updated_at: number
}

interface AddressPolicyTermRow {
  term_kind: 'blocked_substring' | 'reserved_name'
  normalized_value: string
}

export interface AddressPolicySnapshot {
  minimumLocalPartLength: number
  aliasRetentionDays: number
  blockedSubstrings: string[]
  reservedNames: string[]
  policyVersion: number
  updatedAt: number
}

export class AddressPolicyInputError extends Error {
  constructor(
    readonly field:
      | 'minimumLocalPartLength'
      | 'aliasRetentionDays'
      | 'blockedSubstrings'
      | 'reservedNames'
      | 'expectedVersion'
      | 'localPart',
    message: string,
  ) {
    super(message)
  }
}

export class AddressPolicyConflictError extends Error {}
export class AddressPolicyPermissionError extends Error {}

export async function getAddressPolicy(database: D1Database): Promise<AddressPolicySummary> {
  return addressPolicySummary(await readAddressPolicySnapshot(database))
}

export async function readAddressPolicySnapshot(
  database: D1Database,
): Promise<AddressPolicySnapshot> {
  const [settings, terms] = await Promise.all([
    database
      .prepare(
        `SELECT minimum_local_part_length, alias_retention_days, policy_version, updated_at
         FROM address_policy_settings WHERE singleton_id = 1`,
      )
      .first<AddressPolicySettingsRow>(),
    database
      .prepare(
        `SELECT term_kind, normalized_value
         FROM address_policy_terms
         ORDER BY term_kind, normalized_value, id`,
      )
      .all<AddressPolicyTermRow>(),
  ])
  if (!settings) throw new Error('地址策略不存在，请先应用正式数据库迁移')
  return {
    minimumLocalPartLength: settings.minimum_local_part_length,
    aliasRetentionDays: settings.alias_retention_days,
    blockedSubstrings: terms.results
      .filter((term) => term.term_kind === 'blocked_substring')
      .map((term) => term.normalized_value),
    reservedNames: terms.results
      .filter((term) => term.term_kind === 'reserved_name')
      .map((term) => term.normalized_value),
    policyVersion: settings.policy_version,
    updatedAt: settings.updated_at,
  }
}

export async function updateAddressPolicy(options: {
  database: D1Database
  actor: PersonalAddressActor
  input: UpdateAddressPolicyRequest
  audit: AuditContext
  now?: number
}): Promise<AddressPolicySummary> {
  if (!options.actor.isAdministrator) {
    throw new AddressPolicyPermissionError('只有系统管理员可以修改地址策略')
  }
  const normalized = normalizePolicyInput(options.input)
  const current = await readAddressPolicySnapshot(options.database)
  if (current.policyVersion !== normalized.expectedVersion) {
    throw new AddressPolicyConflictError('地址策略已经发生变化，请刷新后重试')
  }
  const nextVersion = current.policyVersion + 1
  const now = Math.max(options.now ?? Date.now(), current.updatedAt + 1)
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `UPDATE address_policy_settings
         SET minimum_local_part_length = ?1,
             alias_retention_days = ?2,
             policy_version = ?3,
             updated_by_user_id = ?4,
             updated_at = ?5
         WHERE singleton_id = 1 AND policy_version = ?6 AND updated_at = ?7`,
      )
      .bind(
        normalized.minimumLocalPartLength,
        normalized.aliasRetentionDays,
        nextVersion,
        options.actor.userId,
        now,
        current.policyVersion,
        current.updatedAt,
      ),
    options.database
      .prepare(
        `DELETE FROM address_policy_terms
         WHERE EXISTS (
           SELECT 1 FROM address_policy_settings
           WHERE singleton_id = 1 AND policy_version = ?1 AND updated_at = ?2
         )`,
      )
      .bind(nextVersion, now),
  ]
  for (const [kind, values] of [
    ['blocked_substring', normalized.blockedSubstrings],
    ['reserved_name', normalized.reservedNames],
  ] as const) {
    for (const value of values) {
      statements.push(
        options.database
          .prepare(
            `INSERT INTO address_policy_terms (
              id, term_kind, normalized_value, created_by_user_id, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (
               SELECT 1 FROM address_policy_settings
               WHERE singleton_id = 1 AND policy_version = ?6 AND updated_at = ?5
             )`,
          )
          .bind(crypto.randomUUID(), kind, value, options.actor.userId, now, nextVersion),
      )
    }
  }
  const auditIndex = statements.length
  statements.push(
    createAddressPolicyGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'address_policy.updated',
        targetType: 'address_policy',
        targetReference: 'singleton',
        outcome: 'succeeded',
        reasonCode: 'administrator_requested',
        occurredAt: now,
      },
      {
        policyVersion: nextVersion,
        minimumLocalPartLength: normalized.minimumLocalPartLength,
        aliasRetentionDays: normalized.aliasRetentionDays,
        updatedAt: now,
      },
    ),
  )

  const results = await options.database.batch(statements)
  if (
    results[0]?.meta.changes !== 1 ||
    results.slice(2, auditIndex).some((result) => result.meta.changes !== 1) ||
    results[auditIndex]?.meta.changes !== 1
  ) {
    throw new AddressPolicyConflictError('地址策略已经发生变化，请刷新后重试')
  }
  return {
    minimumLocalPartLength: normalized.minimumLocalPartLength,
    aliasRetentionDays: normalized.aliasRetentionDays,
    blockedSubstrings: normalized.blockedSubstrings,
    reservedNames: normalized.reservedNames,
    policyVersion: nextVersion,
    updatedAt: new Date(now).toISOString(),
  }
}

export function validateLocalPartAgainstAddressPolicy(
  localPart: string,
  policy: AddressPolicySnapshot,
): void {
  if (localPart.length < policy.minimumLocalPartLength) {
    throw new AddressPolicyInputError(
      'localPart',
      `邮箱前缀至少需要 ${policy.minimumLocalPartLength} 个字符`,
    )
  }
  const blocked = policy.blockedSubstrings.find((term) => localPart.includes(term))
  if (blocked) {
    throw new AddressPolicyInputError('localPart', `邮箱前缀不能包含“${blocked}”`)
  }
  if (policy.reservedNames.includes(localPart)) {
    throw new AddressPolicyInputError('localPart', '该邮箱前缀是系统保留名称')
  }
}

function normalizePolicyInput(input: UpdateAddressPolicyRequest): UpdateAddressPolicyRequest {
  if (
    !Number.isInteger(input.minimumLocalPartLength) ||
    input.minimumLocalPartLength < 1 ||
    input.minimumLocalPartLength > 64
  ) {
    throw new AddressPolicyInputError(
      'minimumLocalPartLength',
      '邮箱前缀最短长度必须是 1 至 64 的整数',
    )
  }
  if (
    !Number.isInteger(input.aliasRetentionDays) ||
    input.aliasRetentionDays < 0 ||
    input.aliasRetentionDays > 30
  ) {
    throw new AddressPolicyInputError('aliasRetentionDays', '个人别名保留期必须是 0 至 30 天的整数')
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new AddressPolicyInputError('expectedVersion', '地址策略版本无效，请刷新后重试')
  }
  return {
    minimumLocalPartLength: input.minimumLocalPartLength,
    aliasRetentionDays: input.aliasRetentionDays,
    blockedSubstrings: normalizeTerms(input.blockedSubstrings, 'blockedSubstrings'),
    reservedNames: normalizeTerms(input.reservedNames, 'reservedNames', true),
    expectedVersion: input.expectedVersion,
  }
}

function normalizeTerms(
  input: string[],
  field: 'blockedSubstrings' | 'reservedNames',
  completeLocalPart = false,
): string[] {
  if (!Array.isArray(input) || input.length > 100) {
    throw new AddressPolicyInputError(field, '每类地址规则最多保存 100 项')
  }
  const values = input.map((item) => item.trim().toLowerCase()).filter(Boolean)
  for (const value of values) {
    if (completeLocalPart) {
      try {
        normalizeLocalPart(value)
      } catch (error) {
        if (error instanceof AddressValidationError) {
          throw new AddressPolicyInputError(field, `保留名称“${value}”格式无效`)
        }
        throw error
      }
    } else if (value.length > 64 || !/^[a-z0-9._-]+$/u.test(value)) {
      throw new AddressPolicyInputError(
        field,
        `禁止文字“${value}”只能使用邮箱前缀允许的 ASCII 字符`,
      )
    }
  }
  return [...new Set(values)].sort()
}

function addressPolicySummary(policy: AddressPolicySnapshot): AddressPolicySummary {
  return {
    minimumLocalPartLength: policy.minimumLocalPartLength,
    aliasRetentionDays: policy.aliasRetentionDays,
    blockedSubstrings: policy.blockedSubstrings,
    reservedNames: policy.reservedNames,
    policyVersion: policy.policyVersion,
    updatedAt: new Date(policy.updatedAt).toISOString(),
  }
}
