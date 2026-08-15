import type {
  MailDomainStatus,
  ManagedMailDomain,
} from '../../../shared/contracts/domain-management'
import {
  createAuditEventStatement,
  createDeletedMailDomainAuditEventStatement,
  createMailDomainStateGuardedAuditEventStatement,
  type AuditContext,
} from '../../audit/public'
import { AddressValidationError, normalizeDomain } from '../domain/email-address'

interface AdministratorActor {
  userId: string
  isAdministrator: boolean
}

interface MailDomainRow {
  id: string
  display_name: string
  canonical_name: string
  status: string
  catch_all_mode: string
  address_count: number
  created_at: number
  updated_at: number
  paused_at: number | null
}

export class DomainManagementPermissionError extends Error {
  constructor() {
    super('只有系统管理员可以管理邮件域名')
  }
}

export class DomainManagementInputError extends Error {
  readonly field = 'domainName'
}

export class MailDomainConflictError extends Error {
  readonly code = 'domain_conflict'
}

export class MailDomainTargetError extends Error {
  constructor(
    readonly code: 'not_found' | 'state_conflict' | 'delete_blocked',
    message: string,
    readonly addressCount = 0,
  ) {
    super(message)
  }
}

export async function listManagedMailDomains(options: {
  database: D1Database
  actor: AdministratorActor
}): Promise<ManagedMailDomain[]> {
  requireAdministrator(options.actor)
  const result = await options.database
    .prepare(
      `SELECT
        mail_domains.id,
        mail_domains.display_name,
        mail_domains.canonical_name,
        mail_domains.status,
        mail_domains.catch_all_mode,
        mail_domains.created_at,
        mail_domains.updated_at,
        mail_domains.paused_at,
        COUNT(email_addresses.id) AS address_count
       FROM mail_domains
       LEFT JOIN email_addresses ON email_addresses.domain_id = mail_domains.id
       WHERE mail_domains.status IN ('active', 'paused')
       GROUP BY mail_domains.id
       ORDER BY mail_domains.created_at, mail_domains.id`,
    )
    .all<MailDomainRow>()
  return result.results.map(domainFromRow)
}

export async function createManagedMailDomain(options: {
  database: D1Database
  actor: AdministratorActor
  domainName: string
  audit: AuditContext
  now?: number
}): Promise<ManagedMailDomain> {
  requireAdministrator(options.actor)
  let normalized
  try {
    normalized = normalizeDomain(options.domainName)
  } catch (error) {
    if (error instanceof AddressValidationError) {
      throw new DomainManagementInputError(error.message)
    }
    throw error
  }

  const existing = await options.database
    .prepare('SELECT 1 FROM mail_domains WHERE canonical_name = ?1 COLLATE NOCASE LIMIT 1')
    .bind(normalized.canonicalDomain)
    .first()
  if (existing) throw new MailDomainConflictError('该邮件域名已经存在')

  const now = options.now ?? Date.now()
  const domainId = crypto.randomUUID()
  try {
    const results = await options.database.batch([
      options.database
        .prepare(
          `INSERT INTO mail_domains (
            id, canonical_name, display_name, status, catch_all_mode,
            paused_at, created_at, updated_at
           ) VALUES (?1, ?2, ?3, 'active', 'reject', NULL, ?4, ?4)`,
        )
        .bind(domainId, normalized.canonicalDomain, normalized.displayDomain, now),
      createAuditEventStatement(options.database, {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'mail_domain.created',
        targetType: 'mail_domain',
        targetReference: domainId,
        outcome: 'succeeded',
        reasonCode: 'administrator_created',
        occurredAt: now,
      }),
    ])
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new MailDomainConflictError('邮件域名没有完整建立')
    }
  } catch (error) {
    if (error instanceof MailDomainConflictError || isUniqueConstraint(error)) {
      throw new MailDomainConflictError('该邮件域名已经存在')
    }
    throw error
  }

  return {
    id: domainId,
    displayName: normalized.displayDomain,
    canonicalName: normalized.canonicalDomain,
    status: 'active',
    catchAllMode: 'reject',
    addressCount: 0,
    createdAt: toIso(now),
    pausedAt: null,
  }
}

export async function changeManagedMailDomainStatus(options: {
  database: D1Database
  actor: AdministratorActor
  domainId: string
  status: MailDomainStatus
  audit: AuditContext
  now?: number
}): Promise<{ domain: ManagedMailDomain; changed: boolean }> {
  requireAdministrator(options.actor)
  const target = await findDomain(options.database, options.domainId)
  if (!target) throw new MailDomainTargetError('not_found', '该邮件域名不存在')
  if (target.status !== 'active' && target.status !== 'paused') {
    throw new MailDomainTargetError('state_conflict', '该域名正在删除，不能改变状态')
  }
  if (target.status === options.status) return { domain: domainFromRow(target), changed: false }

  const now = Math.max(options.now ?? Date.now(), target.updated_at + 1)
  const pausedAt = options.status === 'paused' ? now : null
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE mail_domains
         SET status = ?1, paused_at = ?2, updated_at = ?3
         WHERE id = ?4 AND status = ?5 AND updated_at = ?6`,
      )
      .bind(options.status, pausedAt, now, target.id, target.status, target.updated_at),
    createMailDomainStateGuardedAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: options.status === 'paused' ? 'mail_domain.paused' : 'mail_domain.resumed',
        targetType: 'mail_domain',
        targetReference: target.id,
        outcome: 'succeeded',
        reasonCode: 'administrator_requested',
        occurredAt: now,
      },
      { domainId: target.id, status: options.status, updatedAt: now },
    ),
  ])
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new MailDomainTargetError('state_conflict', '域名状态已经发生变化，请刷新后重试')
  }

  return {
    domain: domainFromRow({
      ...target,
      status: options.status,
      paused_at: pausedAt,
      updated_at: now,
    }),
    changed: true,
  }
}

export async function deleteManagedMailDomain(options: {
  database: D1Database
  actor: AdministratorActor
  domainId: string
  audit: AuditContext
  now?: number
}): Promise<{ deletedDomainId: string; canonicalName: string }> {
  requireAdministrator(options.actor)
  const target = await findDomain(options.database, options.domainId)
  if (!target) throw new MailDomainTargetError('not_found', '该邮件域名不存在')
  if (target.address_count > 0) {
    throw new MailDomainTargetError(
      'delete_blocked',
      `该域名仍有 ${target.address_count} 个关联地址，不能删除`,
      target.address_count,
    )
  }

  const now = options.now ?? Date.now()
  const results = await options.database.batch([
    options.database
      .prepare(
        `DELETE FROM mail_domains
         WHERE id = ?1
           AND status IN ('active', 'paused')
           AND NOT EXISTS (
             SELECT 1 FROM email_addresses WHERE domain_id = ?1
           )`,
      )
      .bind(target.id),
    createDeletedMailDomainAuditEventStatement(
      options.database,
      {
        ...options.audit,
        actorType: 'user',
        actorUserId: options.actor.userId,
        actionName: 'mail_domain.deleted',
        targetType: 'mail_domain',
        targetReference: target.id,
        outcome: 'succeeded',
        reasonCode: 'empty_domain_confirmed',
        occurredAt: now,
      },
      target.id,
    ),
  ])
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new MailDomainTargetError('state_conflict', '域名已经变化或新增了关联地址')
  }

  return { deletedDomainId: target.id, canonicalName: target.canonical_name }
}

async function findDomain(database: D1Database, domainId: string): Promise<MailDomainRow | null> {
  if (!isUuid(domainId)) return null
  return database
    .prepare(
      `SELECT
        mail_domains.id,
        mail_domains.display_name,
        mail_domains.canonical_name,
        mail_domains.status,
        mail_domains.catch_all_mode,
        mail_domains.created_at,
        mail_domains.updated_at,
        mail_domains.paused_at,
        COUNT(email_addresses.id) AS address_count
       FROM mail_domains
       LEFT JOIN email_addresses ON email_addresses.domain_id = mail_domains.id
       WHERE mail_domains.id = ?1
       GROUP BY mail_domains.id
       LIMIT 1`,
    )
    .bind(domainId)
    .first<MailDomainRow>()
}

function requireAdministrator(actor: AdministratorActor): void {
  if (!actor.isAdministrator) throw new DomainManagementPermissionError()
}

function domainFromRow(row: MailDomainRow): ManagedMailDomain {
  return {
    id: row.id,
    displayName: row.display_name,
    canonicalName: row.canonical_name,
    status: row.status as MailDomainStatus,
    catchAllMode: row.catch_all_mode as 'reject' | 'unallocated',
    addressCount: row.address_count,
    createdAt: toIso(row.created_at),
    pausedAt: row.paused_at === null ? null : toIso(row.paused_at),
  }
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
