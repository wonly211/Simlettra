import type {
  ChangeForwardingRuleStatusRequest,
  CreateExternalEmailTargetRequest,
  ExternalEmailTargetSummary,
  ForwardingOverviewResponse,
  ForwardingPersonalAddressSummary,
  ForwardingResultSummary,
  ForwardingRuleSummary,
  SaveForwardingRuleRequest,
} from '../../../shared/contracts/forwarding'
import { normalizeRecipientEmailAddress } from '../../addresses/domain/email-address'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'
import { sha256Bytes } from '../../mail-receiving/domain/content-digest'
import {
  decryptOutboundCredential,
  submitOutboundProviderMessage,
  type OutboundProviderType,
} from '../../sending/public'
import {
  createExternalEmailVerificationCode,
  verifyExternalEmailCode,
} from '../domain/verification-code'

const VERIFICATION_LIFETIME_MS = 30 * 60 * 1000
const VERIFICATION_MAX_FAILURES = 5
const VERIFICATION_SEND_WINDOW_MS = 15 * 60 * 1000
const VERIFICATION_SEND_LIMIT = 5
const MAX_MESSAGE_BYTES = 20_000_000

type ForwardingField = 'emailAddress' | 'code' | 'targetId' | 'ruleId' | 'scope' | 'addressIds'

interface TargetRow {
  id: string
  display_email_address: string
  canonical_email_address: string
  target_status: ExternalEmailTargetSummary['status']
  verified_at: number | null
  created_at: number
  latest_verification_status: string | null
  verification_expires_at: number | null
}

interface RuleRow {
  id: string
  rule_key: string
  rule_version: number
  external_email_target_id: string
  target_address: string
  scope_kind: ForwardingRuleSummary['scope']
  rule_status: ForwardingRuleSummary['status']
  updated_at: number
}

interface ResultRow {
  id: string
  source_message_id: string
  subject: string
  sender_address: string
  target_canonical_email_address: string
  operation_status: ForwardingResultSummary['status']
  error_code: string | null
  error_summary: string | null
  created_at: number
  completed_at: number | null
}

interface SenderRow {
  domain_id: string
  canonical_address: string
  display_name: string | null
}

interface ActiveRouteEntryRow {
  route_id: string
  route_version: number
  provider_config_id: string
  configuration_key: string
  configuration_version: number
  provider_type: OutboundProviderType
  public_options_json: string
  priority_number: number
  credential_ciphertext: ArrayBuffer
  credential_nonce: ArrayBuffer
}

interface VerificationRow {
  id: string
  external_email_target_id: string
  verification_code_hash: ArrayBuffer
  verification_code_salt: ArrayBuffer
  expires_at: number
  max_failure_count: number
  failure_count: number
  verification_status: string
}

export class ForwardingInputError extends Error {
  constructor(
    readonly field: ForwardingField,
    message: string,
  ) {
    super(message)
  }
}

export class ForwardingAccessError extends Error {
  constructor(
    readonly code: 'not_found' | 'state_conflict' | 'rate_limited' | 'route_unavailable',
    message: string,
  ) {
    super(message)
  }
}

export async function getForwardingOverview(options: {
  database: D1Database
  userId: string
}): Promise<ForwardingOverviewResponse['data']> {
  const [targets, addresses, rules, ruleAddresses, recentResults] = await Promise.all([
    listTargets(options.database, options.userId),
    listPersonalAddresses(options.database, options.userId),
    listRules(options.database, options.userId),
    listRuleAddresses(options.database, options.userId),
    listRecentResults(options.database, options.userId),
  ])
  const addressesByRule = new Map<string, string[]>()
  for (const row of ruleAddresses) {
    const values = addressesByRule.get(row.mail_forwarding_rule_id) ?? []
    values.push(row.email_address_id)
    addressesByRule.set(row.mail_forwarding_rule_id, values)
  }
  return {
    targets: targets.map(targetSummary),
    addresses,
    rules: rules.map((rule) => ruleSummary(rule, addressesByRule.get(rule.id) ?? [])),
    recentResults: recentResults.map(resultSummary),
  }
}

export async function createExternalEmailTarget(options: {
  database: D1Database
  userId: string
  encryptionKeyBase64?: string
  input: CreateExternalEmailTargetRequest
  audit: AuditContext
  fetcher?: typeof fetch
  now?: number
}): Promise<ExternalEmailTargetSummary> {
  const now = options.now ?? Date.now()
  const normalized = normalizeTargetAddress(options.input.emailAddress)
  await rejectManagedDomain(options.database, normalized.canonicalDomain)
  const recent = await options.database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM external_email_verifications verification
       JOIN external_email_targets target ON target.id = verification.external_email_target_id
       WHERE target.user_id = ?1 AND verification.created_at >= ?2`,
    )
    .bind(options.userId, now - VERIFICATION_SEND_WINDOW_MS)
    .first<{ count: number }>()
  if ((recent?.count ?? 0) >= VERIFICATION_SEND_LIMIT) {
    throw new ForwardingAccessError('rate_limited', '验证邮件发送过于频繁，请稍后再试')
  }

  const sender = await loadDefaultSender(options.database, options.userId)
  if (!sender) {
    throw new ForwardingAccessError('route_unavailable', '当前没有可用于发送验证邮件的个人地址')
  }
  const routeEntries = await loadActiveRouteEntries(options.database, sender.domain_id)
  if (routeEntries.length === 0) {
    throw new ForwardingAccessError('route_unavailable', '当前个人发件地址尚未配置域外发信服务')
  }

  const existing = await options.database
    .prepare(
      `SELECT id, target_status FROM external_email_targets
       WHERE user_id = ?1 AND canonical_email_address = ?2 AND target_status <> 'deleted'
       LIMIT 1`,
    )
    .bind(options.userId, normalized.canonicalAddress)
    .first<{ id: string; target_status: string }>()
  if (existing?.target_status === 'verified') {
    throw new ForwardingAccessError('state_conflict', '这个外部邮箱已经完成验证')
  }

  const targetId = existing?.id ?? crypto.randomUUID()
  const verificationId = crypto.randomUUID()
  const routeSnapshotId = crypto.randomUUID()
  const code = await createExternalEmailVerificationCode()
  const subject = '澄笺外部邮箱验证'
  const body = [
    '你正在把这个邮箱设置为澄笺的自动转发目标。',
    '',
    `验证码：${code.displayCode}`,
    '',
    '验证码将在 30 分钟后失效。如果不是你本人操作，可以忽略此邮件。',
  ].join('\n')
  const payloadBytes = new TextEncoder().encode(
    [sender.canonical_address, normalized.canonicalAddress, subject, body].join('\n'),
  )
  const payloadDigest = await sha256Bytes(payloadBytes)
  const entryIds = routeEntries.map(() => crypto.randomUUID())
  const routeEntryDigests = await Promise.all(
    routeEntries.map((entry) => sha256Bytes(entry.public_options_json)),
  )
  const statements: D1PreparedStatement[] = []
  if (existing) {
    statements.push(
      options.database
        .prepare(
          `UPDATE external_email_targets
           SET display_email_address = ?1, target_status = 'pending',
               verified_at = NULL, disabled_at = NULL, updated_at = ?2
           WHERE id = ?3 AND user_id = ?4 AND target_status <> 'deleted'`,
        )
        .bind(normalized.canonicalAddress, now, targetId, options.userId),
      options.database
        .prepare(
          `UPDATE external_email_verifications
           SET verification_status = 'cancelled', completed_at = ?1, updated_at = ?1,
               error_code = 'replaced', error_summary = '用户重新发送了验证码'
           WHERE external_email_target_id = ?2
             AND verification_status IN ('pending_delivery', 'pending_input')`,
        )
        .bind(now, targetId),
    )
  } else {
    statements.push(
      options.database
        .prepare(
          `INSERT INTO external_email_targets (
            id, user_id, display_email_address, canonical_email_address,
            target_status, verified_at, disabled_at, deleted_at, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?3, 'pending', NULL, NULL, NULL, ?4, ?4)`,
        )
        .bind(targetId, options.userId, normalized.canonicalAddress, now),
    )
  }
  statements.push(
    options.database
      .prepare(
        `INSERT INTO outbound_route_snapshots (
          id, mail_domain_id, source_route_id, source_route_version,
          execution_kind, execution_reference, payload_sha256,
          payload_size_bytes, created_at
         ) VALUES (?1, ?2, ?3, ?4, 'external_email_verification', ?5, ?6, ?7, ?8)`,
      )
      .bind(
        routeSnapshotId,
        sender.domain_id,
        routeEntries[0]!.route_id,
        routeEntries[0]!.route_version,
        verificationId,
        payloadDigest,
        payloadBytes.byteLength,
        now,
      ),
    ...routeEntries.map((entry, index) =>
      options.database
        .prepare(
          `INSERT INTO outbound_route_snapshot_entries (
            id, route_snapshot_id, priority_number, provider_config_id,
            configuration_key, configuration_version, provider_type,
            effective_size_limit_bytes, provider_options_digest, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .bind(
          entryIds[index],
          routeSnapshotId,
          entry.priority_number,
          entry.provider_config_id,
          entry.configuration_key,
          entry.configuration_version,
          entry.provider_type,
          MAX_MESSAGE_BYTES,
          routeEntryDigests[index],
          now,
        ),
    ),
    options.database
      .prepare(
        `INSERT INTO external_email_verifications (
          id, external_email_target_id, verification_code_hash,
          verification_code_salt, expires_at, max_failure_count, failure_count,
          verification_status, outbound_route_snapshot_id, delivered_at,
          verified_at, completed_at, error_code, error_summary, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'pending_delivery', ?7,
                   NULL, NULL, NULL, NULL, NULL, ?8, ?8)`,
      )
      .bind(
        verificationId,
        targetId,
        code.digest,
        code.salt,
        now + VERIFICATION_LIFETIME_MS,
        VERIFICATION_MAX_FAILURES,
        routeSnapshotId,
        now,
      ),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName: existing
        ? 'external_email_verification_replaced'
        : 'external_email_target_created',
      targetType: 'external_email_target',
      targetReference: targetId,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  )
  const results = await options.database.batch(statements)
  const incomplete = existing
    ? results[0]?.meta.changes !== 1 || results.slice(2).some((result) => result.meta.changes !== 1)
    : results.some((result) => result.meta.changes !== 1)
  if (incomplete) {
    throw new ForwardingAccessError('state_conflict', '外部邮箱设置已经发生变化，请刷新后重试')
  }

  await submitVerificationMessage({
    ...options,
    fetcher: options.fetcher ?? fetch,
    verificationId,
    sender,
    targetAddress: normalized.canonicalAddress,
    subject,
    body,
    routeEntries,
    entryIds,
    now,
  })
  return readTargetSummary(options.database, options.userId, targetId)
}

export async function verifyExternalEmailTarget(options: {
  database: D1Database
  userId: string
  targetId: string
  code: string
  audit: AuditContext
  now?: number
}): Promise<ExternalEmailTargetSummary> {
  assertUuid(options.targetId, 'targetId')
  const now = options.now ?? Date.now()
  const verification = await options.database
    .prepare(
      `SELECT verification.id, verification.external_email_target_id,
              verification.verification_code_hash, verification.verification_code_salt,
              verification.expires_at, verification.max_failure_count,
              verification.failure_count, verification.verification_status
       FROM external_email_verifications verification
       JOIN external_email_targets target ON target.id = verification.external_email_target_id
       WHERE target.id = ?1 AND target.user_id = ?2 AND target.target_status = 'pending'
       ORDER BY verification.created_at DESC LIMIT 1`,
    )
    .bind(options.targetId, options.userId)
    .first<VerificationRow>()
  if (!verification) throw new ForwardingAccessError('not_found', '待验证的外部邮箱不存在')
  if (verification.verification_status !== 'pending_input') {
    throw new ForwardingAccessError('state_conflict', '当前验证码尚未成功发送或已经失效')
  }
  if (verification.expires_at <= now) {
    await options.database.batch([
      options.database
        .prepare(
          `UPDATE external_email_verifications
           SET verification_status = 'expired', completed_at = ?1, updated_at = ?1,
               error_code = 'code_expired', error_summary = '验证码已经过期'
           WHERE id = ?2 AND verification_status = 'pending_input'`,
        )
        .bind(now, verification.id),
      options.database
        .prepare(
          `UPDATE external_email_targets SET target_status = 'expired', updated_at = ?1
           WHERE id = ?2 AND user_id = ?3 AND target_status = 'pending'`,
        )
        .bind(now, options.targetId, options.userId),
    ])
    throw new ForwardingAccessError('state_conflict', '验证码已经过期，请重新发送')
  }
  const valid = await verifyExternalEmailCode(
    options.code,
    verification.verification_code_salt,
    verification.verification_code_hash,
  )
  if (!valid) {
    const failures = verification.failure_count + 1
    if (failures >= verification.max_failure_count) {
      await options.database.batch([
        options.database
          .prepare(
            `UPDATE external_email_verifications
             SET failure_count = ?1, verification_status = 'cancelled',
                 completed_at = ?2, updated_at = ?2, error_code = 'attempts_exhausted',
                 error_summary = '验证码错误次数已经达到上限'
             WHERE id = ?3 AND verification_status = 'pending_input' AND failure_count = ?4`,
          )
          .bind(failures, now, verification.id, verification.failure_count),
        options.database
          .prepare(
            `UPDATE external_email_targets SET target_status = 'expired', updated_at = ?1
             WHERE id = ?2 AND user_id = ?3 AND target_status = 'pending'`,
          )
          .bind(now, options.targetId, options.userId),
      ])
    } else {
      await options.database
        .prepare(
          `UPDATE external_email_verifications SET failure_count = ?1, updated_at = ?2
           WHERE id = ?3 AND verification_status = 'pending_input' AND failure_count = ?4`,
        )
        .bind(failures, now, verification.id, verification.failure_count)
        .run()
    }
    throw new ForwardingInputError('code', '验证码不正确')
  }

  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE external_email_verifications
         SET verification_status = 'verified', verified_at = ?1,
             completed_at = ?1, updated_at = ?1, error_code = NULL, error_summary = NULL
         WHERE id = ?2 AND verification_status = 'pending_input' AND failure_count = ?3`,
      )
      .bind(now, verification.id, verification.failure_count),
    options.database
      .prepare(
        `UPDATE external_email_targets
         SET target_status = 'verified', verified_at = ?1,
             disabled_at = NULL, updated_at = ?1
         WHERE id = ?2 AND user_id = ?3 AND target_status = 'pending'`,
      )
      .bind(now, options.targetId, options.userId),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName: 'external_email_target_verified',
      targetType: 'external_email_target',
      targetReference: options.targetId,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new ForwardingAccessError('state_conflict', '验证状态已经发生变化，请刷新后重试')
  }
  return readTargetSummary(options.database, options.userId, options.targetId)
}

export async function deleteExternalEmailTarget(options: {
  database: D1Database
  userId: string
  targetId: string
  audit: AuditContext
  now?: number
}): Promise<void> {
  assertUuid(options.targetId, 'targetId')
  const now = options.now ?? Date.now()
  const target = await options.database
    .prepare(
      `SELECT id FROM external_email_targets
       WHERE id = ?1 AND user_id = ?2 AND target_status <> 'deleted' LIMIT 1`,
    )
    .bind(options.targetId, options.userId)
    .first<{ id: string }>()
  if (!target) throw new ForwardingAccessError('not_found', '外部邮箱不存在')
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE mail_forwarding_rules
         SET rule_status = 'deleted', deleted_at = ?1, updated_at = ?1
         WHERE user_id = ?2 AND external_email_target_id = ?3
           AND rule_status IN ('active', 'paused')`,
      )
      .bind(now, options.userId, options.targetId),
    options.database
      .prepare(
        `UPDATE external_email_targets
         SET target_status = 'deleted', deleted_at = ?1, disabled_at = NULL, updated_at = ?1
         WHERE id = ?2 AND user_id = ?3 AND target_status <> 'deleted'`,
      )
      .bind(now, options.targetId, options.userId),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName: 'external_email_target_deleted',
      targetType: 'external_email_target',
      targetReference: options.targetId,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ])
  if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
    throw new ForwardingAccessError('state_conflict', '外部邮箱状态已经发生变化')
  }
}

export async function saveForwardingRule(options: {
  database: D1Database
  userId: string
  input: SaveForwardingRuleRequest
  audit: AuditContext
  now?: number
}): Promise<ForwardingRuleSummary> {
  const input = normalizeRuleInput(options.input)
  const now = options.now ?? Date.now()
  const target = await options.database
    .prepare(
      `SELECT id FROM external_email_targets
       WHERE id = ?1 AND user_id = ?2 AND target_status = 'verified' LIMIT 1`,
    )
    .bind(input.targetId, options.userId)
    .first<{ id: string }>()
  if (!target) throw new ForwardingInputError('targetId', '请选择自己的已验证外部邮箱')
  await assertSelectedAddresses(options.database, options.userId, input.scope, input.addressIds)

  let previous: { id: string; rule_key: string; rule_version: number } | null = null
  if (input.ruleId) {
    previous = await options.database
      .prepare(
        `SELECT id, rule_key, rule_version FROM mail_forwarding_rules
         WHERE id = ?1 AND user_id = ?2 AND rule_status IN ('active', 'paused') LIMIT 1`,
      )
      .bind(input.ruleId, options.userId)
      .first<{ id: string; rule_key: string; rule_version: number }>()
    if (!previous) throw new ForwardingAccessError('not_found', '转发规则不存在')
  }
  const id = crypto.randomUUID()
  const ruleKey = previous?.rule_key ?? crypto.randomUUID()
  const version = (previous?.rule_version ?? 0) + 1
  const statements: D1PreparedStatement[] = []
  if (previous) {
    statements.push(
      options.database
        .prepare(
          `UPDATE mail_forwarding_rules
           SET rule_status = 'superseded', superseded_at = ?1, updated_at = ?1
           WHERE id = ?2 AND user_id = ?3 AND rule_status IN ('active', 'paused')`,
        )
        .bind(now, previous.id, options.userId),
    )
  }
  statements.push(
    options.database
      .prepare(
        `INSERT INTO mail_forwarding_rules (
          id, rule_key, user_id, external_email_target_id, rule_version,
          scope_kind, rule_status, created_at, updated_at, superseded_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, NULL, NULL)`,
      )
      .bind(
        id,
        ruleKey,
        options.userId,
        input.targetId,
        version,
        input.scope,
        input.enabled ? 'active' : 'paused',
        now,
      ),
    ...input.addressIds.map((addressId) =>
      options.database
        .prepare(
          `INSERT INTO mail_forwarding_rule_addresses (
            mail_forwarding_rule_id, email_address_id, created_at
           ) VALUES (?1, ?2, ?3)`,
        )
        .bind(id, addressId, now),
    ),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName: previous ? 'mail_forwarding_rule_replaced' : 'mail_forwarding_rule_created',
      targetType: 'mail_forwarding_rule',
      targetReference: id,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  )
  const results = await options.database.batch(statements)
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new ForwardingAccessError('state_conflict', '转发规则没有完整保存，请刷新后重试')
  }
  return readRuleSummary(options.database, options.userId, id)
}

export async function changeForwardingRuleStatus(options: {
  database: D1Database
  userId: string
  ruleId: string
  input: ChangeForwardingRuleStatusRequest
  audit: AuditContext
  now?: number
}): Promise<ForwardingRuleSummary> {
  assertUuid(options.ruleId, 'ruleId')
  if (!['active', 'paused'].includes(options.input.status)) {
    throw new ForwardingInputError('scope', '转发规则状态无效')
  }
  const current = await options.database
    .prepare(
      `SELECT rule.id, target.target_status
       FROM mail_forwarding_rules rule
       JOIN external_email_targets target ON target.id = rule.external_email_target_id
       WHERE rule.id = ?1 AND rule.user_id = ?2 AND rule.rule_status IN ('active', 'paused')
       LIMIT 1`,
    )
    .bind(options.ruleId, options.userId)
    .first<{ id: string; target_status: string }>()
  if (!current) throw new ForwardingAccessError('not_found', '转发规则不存在')
  if (options.input.status === 'active' && current.target_status !== 'verified') {
    throw new ForwardingAccessError('state_conflict', '转发目标当前不可用')
  }
  const now = options.now ?? Date.now()
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE mail_forwarding_rules SET rule_status = ?1, updated_at = ?2
         WHERE id = ?3 AND user_id = ?4 AND rule_status IN ('active', 'paused')`,
      )
      .bind(options.input.status, now, options.ruleId, options.userId),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName: `mail_forwarding_rule_${options.input.status}`,
      targetType: 'mail_forwarding_rule',
      targetReference: options.ruleId,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new ForwardingAccessError('state_conflict', '转发规则状态已经发生变化')
  }
  return readRuleSummary(options.database, options.userId, options.ruleId)
}

export async function deleteForwardingRule(options: {
  database: D1Database
  userId: string
  ruleId: string
  audit: AuditContext
  now?: number
}): Promise<void> {
  assertUuid(options.ruleId, 'ruleId')
  const now = options.now ?? Date.now()
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE mail_forwarding_rules
         SET rule_status = 'deleted', deleted_at = ?1, updated_at = ?1
         WHERE id = ?2 AND user_id = ?3 AND rule_status IN ('active', 'paused')`,
      )
      .bind(now, options.ruleId, options.userId),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName: 'mail_forwarding_rule_deleted',
      targetType: 'mail_forwarding_rule',
      targetReference: options.ruleId,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new ForwardingAccessError('not_found', '转发规则不存在或已经删除')
  }
}

async function submitVerificationMessage(options: {
  database: D1Database
  encryptionKeyBase64?: string
  fetcher: typeof fetch
  verificationId: string
  sender: SenderRow
  targetAddress: string
  subject: string
  body: string
  routeEntries: ActiveRouteEntryRow[]
  entryIds: string[]
  now: number
}): Promise<void> {
  await options.database
    .prepare(
      `UPDATE external_email_verifications
       SET verification_status = 'submitting', updated_at = ?1
       WHERE id = ?2 AND verification_status = 'pending_delivery'`,
    )
    .bind(options.now, options.verificationId)
    .run()
  for (const [index, entry] of options.routeEntries.entries()) {
    const attemptId = crypto.randomUUID()
    const selectionKind = index === 0 ? 'initial' : 'fallback'
    const prepared = await options.database.batch([
      options.database
        .prepare(
          `INSERT INTO external_email_verification_attempts (
            id, external_email_verification_id, route_snapshot_entry_id,
            attempt_number, selection_kind, fallback_reason, attempt_status,
            provider_submission_id, started_at, completed_at, error_code,
            error_summary, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', NULL, NULL, NULL, NULL, NULL, ?7, ?7)`,
        )
        .bind(
          attemptId,
          options.verificationId,
          options.entryIds[index],
          index + 1,
          selectionKind,
          selectionKind === 'fallback' ? 'temporary_rejection' : null,
          options.now,
        ),
      options.database
        .prepare(
          `UPDATE external_email_verification_attempts
           SET attempt_status = 'submitting', started_at = ?1, updated_at = ?1
           WHERE id = ?2 AND attempt_status = 'prepared'`,
        )
        .bind(options.now, attemptId),
    ])
    if (prepared.some((result) => result.meta.changes !== 1)) {
      throw new ForwardingAccessError('state_conflict', '验证邮件提交状态已经发生变化')
    }
    let result
    try {
      const credential = await decryptOutboundCredential({
        ...(options.encryptionKeyBase64
          ? { encryptionKeyBase64: options.encryptionKeyBase64 }
          : {}),
        configurationKey: entry.configuration_key,
        configurationVersion: entry.configuration_version,
        ciphertext: entry.credential_ciphertext,
        nonce: entry.credential_nonce,
      })
      result = await submitOutboundProviderMessage({
        fetcher: options.fetcher,
        providerType: entry.provider_type,
        credential,
        idempotencyKey: `simlettra-${attemptId}`,
        message: {
          senderAddress: options.sender.canonical_address,
          senderDisplayName: options.sender.display_name,
          recipientAddress: options.targetAddress,
          subject: options.subject,
          text: options.body,
          headers: { 'X-Simlettra-Purpose': 'external-email-verification' },
        },
      })
    } catch {
      result = {
        kind: 'not_accepted' as const,
        retryWithFallback: true,
        code: 'configuration_rejected',
      }
    }
    if (result.kind === 'accepted') {
      await finishVerificationAttempt(options.database, {
        verificationId: options.verificationId,
        attemptId,
        attemptStatus: 'accepted',
        verificationStatus: 'pending_input',
        providerSubmissionId: result.submissionId,
        errorCode: null,
        now: options.now,
      })
      return
    }
    if (result.kind === 'unknown') {
      await finishVerificationAttempt(options.database, {
        verificationId: options.verificationId,
        attemptId,
        attemptStatus: 'unknown',
        verificationStatus: 'delivery_unknown',
        providerSubmissionId: null,
        errorCode: result.code,
        now: options.now,
      })
      return
    }
    await options.database
      .prepare(
        `UPDATE external_email_verification_attempts
         SET attempt_status = 'not_accepted', completed_at = ?1, error_code = ?2,
             error_summary = '发信服务明确未接受验证邮件', updated_at = ?1
         WHERE id = ?3 AND attempt_status = 'submitting'`,
      )
      .bind(options.now, result.code, attemptId)
      .run()
    if (result.retryWithFallback && index + 1 < options.routeEntries.length) continue
    await options.database
      .prepare(
        `UPDATE external_email_verifications
         SET verification_status = 'delivery_failed', completed_at = ?1,
             error_code = ?2, error_summary = '验证邮件发送失败', updated_at = ?1
         WHERE id = ?3 AND verification_status = 'submitting'`,
      )
      .bind(options.now, result.code, options.verificationId)
      .run()
    return
  }
}

async function finishVerificationAttempt(
  database: D1Database,
  options: {
    verificationId: string
    attemptId: string
    attemptStatus: 'accepted' | 'unknown'
    verificationStatus: 'pending_input' | 'delivery_unknown'
    providerSubmissionId: string | null
    errorCode: string | null
    now: number
  },
): Promise<void> {
  const results = await database.batch([
    database
      .prepare(
        `UPDATE external_email_verification_attempts
         SET attempt_status = ?1, provider_submission_id = ?2,
             completed_at = ?3, error_code = ?4, error_summary = ?5, updated_at = ?3
         WHERE id = ?6 AND attempt_status = 'submitting'`,
      )
      .bind(
        options.attemptStatus,
        options.providerSubmissionId,
        options.now,
        options.errorCode,
        options.errorCode ? '发信服务是否接受验证邮件暂时无法判断' : null,
        options.attemptId,
      ),
    database
      .prepare(
        `UPDATE external_email_verifications
         SET verification_status = ?1, delivered_at = ?2,
             completed_at = ?3, error_code = ?4, error_summary = ?5, updated_at = ?2
         WHERE id = ?6 AND verification_status = 'submitting'`,
      )
      .bind(
        options.verificationStatus,
        options.now,
        options.verificationStatus === 'delivery_unknown' ? options.now : null,
        options.errorCode,
        options.errorCode ? '发信服务是否接受验证邮件暂时无法判断' : null,
        options.verificationId,
      ),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new ForwardingAccessError('state_conflict', '验证邮件结果已经发生变化')
  }
}

async function loadDefaultSender(database: D1Database, userId: string): Promise<SenderRow | null> {
  return database
    .prepare(
      `SELECT address.domain_id, address.canonical_address,
              COALESCE(preference.sender_display_name, user.display_name) AS display_name
       FROM address_bindings binding
       JOIN users user ON user.id = binding.user_id AND user.status = 'active'
       JOIN email_addresses address ON address.id = binding.address_id AND address.retired_at IS NULL
       JOIN mail_domains domain ON domain.id = address.domain_id AND domain.status = 'active'
       JOIN address_claims claim
         ON claim.address_id = address.id AND claim.status = 'active' AND claim.reserved_until IS NULL
       LEFT JOIN user_address_preferences preference
         ON preference.user_id = binding.user_id AND preference.address_id = binding.address_id
       WHERE binding.user_id = ?1 AND binding.owner_type = 'user' AND binding.ended_at IS NULL
       ORDER BY COALESCE(preference.is_default_sender, 0) DESC,
                CASE binding.address_role WHEN 'primary' THEN 0 ELSE 1 END,
                binding.started_at, binding.id
       LIMIT 1`,
    )
    .bind(userId)
    .first<SenderRow>()
}

async function loadActiveRouteEntries(
  database: D1Database,
  domainId: string,
): Promise<ActiveRouteEntryRow[]> {
  const rows = await database
    .prepare(
      `SELECT route.id AS route_id, route.route_version,
              config.id AS provider_config_id, config.configuration_key,
              config.configuration_version, config.provider_type,
              config.public_options_json, entry.priority_number,
              config.credential_ciphertext, config.credential_nonce
       FROM domain_outbound_routes route
       JOIN domain_outbound_route_entries entry ON entry.route_id = route.id
       JOIN outbound_provider_configs config
         ON config.id = entry.provider_config_id AND config.configuration_status = 'active'
       WHERE route.mail_domain_id = ?1 AND route.route_status = 'active'
       ORDER BY entry.priority_number`,
    )
    .bind(domainId)
    .all<ActiveRouteEntryRow>()
  if (rows.results.some((row, index) => row.priority_number !== index)) {
    throw new ForwardingAccessError('route_unavailable', '域外发信路线顺序无效')
  }
  return rows.results
}

async function rejectManagedDomain(database: D1Database, domain: string): Promise<void> {
  const managed = await database
    .prepare(
      `SELECT 1 AS found FROM mail_domains WHERE canonical_name = ?1 AND status <> 'deleted'`,
    )
    .bind(domain)
    .first<{ found: number }>()
  if (managed)
    throw new ForwardingInputError('emailAddress', '转发目标不能使用本系统管理的邮件域名')
}

function normalizeTargetAddress(value: string) {
  try {
    return normalizeRecipientEmailAddress(value)
  } catch {
    throw new ForwardingInputError('emailAddress', '请输入有效的外部邮箱地址')
  }
}

function normalizeRuleInput(input: SaveForwardingRuleRequest): SaveForwardingRuleRequest & {
  addressIds: string[]
} {
  assertUuid(input.targetId, 'targetId')
  if (input.ruleId) assertUuid(input.ruleId, 'ruleId')
  if (!['all_personal', 'selected_personal_addresses'].includes(input.scope)) {
    throw new ForwardingInputError('scope', '请选择有效的转发范围')
  }
  const addressIds = [...new Set(Array.isArray(input.addressIds) ? input.addressIds : [])]
  if (addressIds.some((id) => !isUuid(id)) || addressIds.length > 100) {
    throw new ForwardingInputError('addressIds', '所选个人地址无效')
  }
  if (input.scope === 'all_personal' && addressIds.length > 0) {
    throw new ForwardingInputError('addressIds', '全部个人地址规则不需要单独选择地址')
  }
  if (input.scope === 'selected_personal_addresses' && addressIds.length === 0) {
    throw new ForwardingInputError('addressIds', '请至少选择一个个人地址')
  }
  return { ...input, addressIds }
}

async function assertSelectedAddresses(
  database: D1Database,
  userId: string,
  scope: SaveForwardingRuleRequest['scope'],
  addressIds: string[],
): Promise<void> {
  if (scope === 'all_personal') return
  const placeholders = addressIds.map((_, index) => `?${index + 2}`).join(', ')
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM address_bindings
       WHERE user_id = ?1 AND owner_type = 'user' AND ended_at IS NULL
         AND address_id IN (${placeholders})`,
    )
    .bind(userId, ...addressIds)
    .first<{ count: number }>()
  if ((count?.count ?? 0) !== addressIds.length) {
    throw new ForwardingInputError('addressIds', '只能选择自己当前可用的个人地址')
  }
}

async function listTargets(database: D1Database, userId: string): Promise<TargetRow[]> {
  const rows = await database
    .prepare(
      `SELECT target.id, target.display_email_address, target.canonical_email_address,
              target.target_status, target.verified_at, target.created_at,
              verification.verification_status AS latest_verification_status,
              verification.expires_at AS verification_expires_at
       FROM external_email_targets target
       LEFT JOIN external_email_verifications verification
         ON verification.id = (
           SELECT latest.id FROM external_email_verifications latest
           WHERE latest.external_email_target_id = target.id
           ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
         )
       WHERE target.user_id = ?1 AND target.target_status <> 'deleted'
       ORDER BY target.created_at DESC, target.id DESC`,
    )
    .bind(userId)
    .all<TargetRow>()
  return rows.results
}

async function listPersonalAddresses(
  database: D1Database,
  userId: string,
): Promise<ForwardingPersonalAddressSummary[]> {
  const rows = await database
    .prepare(
      `SELECT address.id, address.canonical_address AS address, binding.address_role AS role
       FROM address_bindings binding
       JOIN email_addresses address ON address.id = binding.address_id AND address.retired_at IS NULL
       JOIN address_claims claim
         ON claim.address_id = address.id AND claim.status = 'active' AND claim.reserved_until IS NULL
       WHERE binding.user_id = ?1 AND binding.owner_type = 'user' AND binding.ended_at IS NULL
       ORDER BY CASE binding.address_role WHEN 'primary' THEN 0 ELSE 1 END,
                binding.started_at, binding.id`,
    )
    .bind(userId)
    .all<ForwardingPersonalAddressSummary>()
  return rows.results
}

async function listRules(database: D1Database, userId: string): Promise<RuleRow[]> {
  const rows = await database
    .prepare(
      `SELECT rule.id, rule.rule_key, rule.rule_version,
              rule.external_email_target_id, target.canonical_email_address AS target_address,
              rule.scope_kind, rule.rule_status, rule.updated_at
       FROM mail_forwarding_rules rule
       JOIN external_email_targets target ON target.id = rule.external_email_target_id
       WHERE rule.user_id = ?1 AND rule.rule_status IN ('active', 'paused')
       ORDER BY rule.updated_at DESC, rule.id DESC`,
    )
    .bind(userId)
    .all<RuleRow>()
  return rows.results
}

async function listRuleAddresses(database: D1Database, userId: string) {
  const rows = await database
    .prepare(
      `SELECT selected.mail_forwarding_rule_id, selected.email_address_id
       FROM mail_forwarding_rule_addresses selected
       JOIN mail_forwarding_rules rule ON rule.id = selected.mail_forwarding_rule_id
       WHERE rule.user_id = ?1 AND rule.rule_status IN ('active', 'paused')
       ORDER BY selected.created_at, selected.email_address_id`,
    )
    .bind(userId)
    .all<{ mail_forwarding_rule_id: string; email_address_id: string }>()
  return rows.results
}

async function listRecentResults(database: D1Database, userId: string): Promise<ResultRow[]> {
  const rows = await database
    .prepare(
      `SELECT operation.id, operation.source_message_id, message.subject,
              operation.sender_address, operation.target_canonical_email_address,
              operation.operation_status, operation.error_code, operation.error_summary,
              operation.created_at, operation.completed_at
       FROM mail_forward_operations operation
       JOIN mail_forwarding_rules rule ON rule.id = operation.mail_forwarding_rule_id
       JOIN messages message ON message.id = operation.source_message_id
       WHERE rule.user_id = ?1
       ORDER BY operation.created_at DESC, operation.id DESC LIMIT 50`,
    )
    .bind(userId)
    .all<ResultRow>()
  return rows.results
}

async function readTargetSummary(
  database: D1Database,
  userId: string,
  targetId: string,
): Promise<ExternalEmailTargetSummary> {
  const targets = await listTargets(database, userId)
  const target = targets.find((row) => row.id === targetId)
  if (!target) throw new ForwardingAccessError('not_found', '外部邮箱不存在')
  return targetSummary(target)
}

async function readRuleSummary(
  database: D1Database,
  userId: string,
  ruleId: string,
): Promise<ForwardingRuleSummary> {
  const [rules, addresses] = await Promise.all([
    listRules(database, userId),
    listRuleAddresses(database, userId),
  ])
  const rule = rules.find((row) => row.id === ruleId)
  if (!rule) throw new ForwardingAccessError('not_found', '转发规则不存在')
  return ruleSummary(
    rule,
    addresses
      .filter((row) => row.mail_forwarding_rule_id === rule.id)
      .map((row) => row.email_address_id),
  )
}

function targetSummary(row: TargetRow): ExternalEmailTargetSummary {
  return {
    id: row.id,
    emailAddress: row.display_email_address,
    status: row.target_status,
    verifiedAt: row.verified_at,
    latestVerificationStatus: row.latest_verification_status,
    verificationExpiresAt: row.verification_expires_at,
    createdAt: row.created_at,
  }
}

function ruleSummary(row: RuleRow, addressIds: string[]): ForwardingRuleSummary {
  return {
    id: row.id,
    ruleKey: row.rule_key,
    version: row.rule_version,
    targetId: row.external_email_target_id,
    targetAddress: row.target_address,
    scope: row.scope_kind,
    addressIds,
    status: row.rule_status,
    updatedAt: row.updated_at,
  }
}

function resultSummary(row: ResultRow): ForwardingResultSummary {
  return {
    id: row.id,
    sourceMessageId: row.source_message_id,
    subject: row.subject,
    actualAddress: row.sender_address,
    targetAddress: row.target_canonical_email_address,
    status: row.operation_status,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function assertUuid(value: string, field: ForwardingField): void {
  if (!isUuid(value)) throw new ForwardingInputError(field, '请求中的标识无效')
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
