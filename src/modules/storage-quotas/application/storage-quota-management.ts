import type { StorageMode } from '../../../shared/contracts/storage-mode'
import type {
  SaveStorageQuotaDefaultRequest,
  SaveStorageQuotaOverrideRequest,
  StorageQuotaDefaultSummary,
  StorageQuotaOverviewResponse,
  StorageQuotaOwnerType,
  StorageQuotaSubjectSummary,
} from '../../../shared/contracts/storage-quotas'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'

const MINIMUM_LIMIT_BYTES = 1_000_000
const MAXIMUM_LIMIT_BYTES = 1_000_000_000_000

interface DefaultRow {
  owner_type: StorageQuotaOwnerType
  policy_version: number
  limit_bytes: number
}

interface SubjectRow {
  owner_type: StorageQuotaOwnerType
  owner_id: string
  display_name: string
  committed_bytes: number
  reserved_bytes: number
  override_policy_id: string | null
  override_policy_version: number | null
  override_limit_bytes: number | null
  default_policy_version: number
  default_limit_bytes: number
}

export class StorageQuotaPermissionError extends Error {}

export class StorageQuotaInputError extends Error {
  constructor(
    readonly field: 'ownerType' | 'ownerId' | 'limitBytes',
    message: string,
  ) {
    super(message)
  }
}

export async function getStorageQuotaOverview(options: {
  database: D1Database
  actorUserId: string
  storageMode: StorageMode
}): Promise<StorageQuotaOverviewResponse['data']> {
  await requireAdministrator(options.database, options.actorUserId)
  const [defaults, users, organizations] = await Promise.all([
    loadDefaults(options.database, options.storageMode),
    loadSubjects(options.database, options.storageMode, 'user'),
    loadSubjects(options.database, options.storageMode, 'organization'),
  ])
  return {
    storageMode: options.storageMode,
    defaults: defaults.map((row) => defaultSummary(options.storageMode, row)),
    users: users.map(subjectSummary),
    organizations: organizations.map(subjectSummary),
  }
}

export async function saveStorageQuotaDefault(options: {
  database: D1Database
  actorUserId: string
  storageMode: StorageMode
  ownerType: string
  input: SaveStorageQuotaDefaultRequest
  audit: AuditContext
  now?: number
}): Promise<StorageQuotaDefaultSummary> {
  await requireAdministrator(options.database, options.actorUserId)
  const ownerType = normalizeOwnerType(options.ownerType)
  const limitBytes = normalizeLimit(options.input.limitBytes)
  const now = options.now ?? Date.now()
  const current = await options.database
    .prepare(
      `SELECT id, policy_version FROM logical_storage_quota_policies
       WHERE storage_mode = ?1 AND owner_type = 'system_default'
         AND default_owner_type = ?2 AND policy_status = 'active' LIMIT 1`,
    )
    .bind(options.storageMode, ownerType)
    .first<{ id: string; policy_version: number }>()
  if (!current) throw new StorageQuotaInputError('ownerType', '当前存储模式缺少默认配额策略')
  const nextVersion = current.policy_version + 1
  const policyId = crypto.randomUUID()
  await options.database.batch([
    options.database
      .prepare(
        `UPDATE logical_storage_quota_policies
         SET policy_status = 'retired', retired_at = ?1, updated_at = ?1
         WHERE id = ?2 AND policy_status = 'active'`,
      )
      .bind(now, current.id),
    options.database
      .prepare(
        `INSERT INTO logical_storage_quota_policies (
           id, storage_mode, owner_type, default_owner_type, user_id, organization_id,
           policy_version, limit_bytes, policy_status, effective_at,
           retired_at, created_at, updated_at
         ) VALUES (?1, ?2, 'system_default', ?3, NULL, NULL, ?4, ?5,
                   'active', ?6, NULL, ?6, ?6)`,
      )
      .bind(policyId, options.storageMode, ownerType, nextVersion, limitBytes, now),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actorUserId,
      actionName: 'storage_quota.default_updated',
      targetType: 'storage_quota_default',
      targetReference: `${options.storageMode}:${ownerType}`,
      outcome: 'succeeded',
      reasonCode: String(limitBytes),
      occurredAt: now,
    }),
  ])
  return { ownerType, storageMode: options.storageMode, limitBytes, policyVersion: nextVersion }
}

export async function saveStorageQuotaOverride(options: {
  database: D1Database
  actorUserId: string
  storageMode: StorageMode
  ownerType: string
  ownerId: string
  input: SaveStorageQuotaOverrideRequest
  audit: AuditContext
  now?: number
}): Promise<StorageQuotaSubjectSummary> {
  await requireAdministrator(options.database, options.actorUserId)
  const ownerType = normalizeOwnerType(options.ownerType)
  if (!isUuid(options.ownerId)) throw new StorageQuotaInputError('ownerId', '配额主体不存在')
  const limitBytes =
    options.input.limitBytes === null ? null : normalizeLimit(options.input.limitBytes)
  const ownerColumn = ownerType === 'user' ? 'user_id' : 'organization_id'
  const account = await options.database
    .prepare(
      `SELECT id FROM logical_storage_usage_accounts
       WHERE storage_mode = ?1 AND owner_type = ?2 AND ${ownerColumn} = ?3 LIMIT 1`,
    )
    .bind(options.storageMode, ownerType, options.ownerId)
    .first<{ id: string }>()
  if (!account) throw new StorageQuotaInputError('ownerId', '配额主体不存在')
  const now = options.now ?? Date.now()
  const current = await options.database
    .prepare(
      `SELECT id, policy_version FROM logical_storage_quota_policies
       WHERE storage_mode = ?1 AND owner_type = ?2 AND ${ownerColumn} = ?3
         AND policy_status = 'active' LIMIT 1`,
    )
    .bind(options.storageMode, ownerType, options.ownerId)
    .first<{ id: string; policy_version: number }>()
  const statements: D1PreparedStatement[] = []
  if (current) {
    statements.push(
      options.database
        .prepare(
          `UPDATE logical_storage_quota_policies
           SET policy_status = 'retired', retired_at = ?1, updated_at = ?1
           WHERE id = ?2 AND policy_status = 'active'`,
        )
        .bind(now, current.id),
    )
  }
  if (limitBytes !== null) {
    statements.push(
      options.database
        .prepare(
          `INSERT INTO logical_storage_quota_policies (
             id, storage_mode, owner_type, default_owner_type, user_id, organization_id,
             policy_version, limit_bytes, policy_status, effective_at,
             retired_at, created_at, updated_at
           ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, 'active', ?8, NULL, ?8, ?8)`,
        )
        .bind(
          crypto.randomUUID(),
          options.storageMode,
          ownerType,
          ownerType === 'user' ? options.ownerId : null,
          ownerType === 'organization' ? options.ownerId : null,
          (current?.policy_version ?? 0) + 1,
          limitBytes,
          now,
        ),
    )
  }
  statements.push(
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actorUserId,
      actionName: 'storage_quota.override_updated',
      targetType: ownerType,
      targetReference: options.ownerId,
      outcome: 'succeeded',
      reasonCode: limitBytes === null ? 'use_default' : String(limitBytes),
      occurredAt: now,
    }),
  )
  await options.database.batch(statements)
  const subject = (
    await loadSubjects(options.database, options.storageMode, ownerType, options.ownerId)
  )[0]
  if (!subject) throw new StorageQuotaInputError('ownerId', '配额主体不存在')
  return subjectSummary(subject)
}

async function loadDefaults(database: D1Database, storageMode: StorageMode): Promise<DefaultRow[]> {
  const rows = await database
    .prepare(
      `SELECT default_owner_type AS owner_type, policy_version, limit_bytes
       FROM logical_storage_quota_policies
       WHERE storage_mode = ?1 AND owner_type = 'system_default'
         AND policy_status = 'active'
       ORDER BY default_owner_type`,
    )
    .bind(storageMode)
    .all<DefaultRow>()
  return rows.results
}

async function loadSubjects(
  database: D1Database,
  storageMode: StorageMode,
  ownerType: StorageQuotaOwnerType,
  ownerId?: string,
): Promise<SubjectRow[]> {
  const ownerColumn = ownerType === 'user' ? 'user_id' : 'organization_id'
  const sourceTable = ownerType === 'user' ? 'users' : 'organizations'
  const displayColumn = ownerType === 'user' ? 'display_name' : 'name'
  const rows = await database
    .prepare(
      `SELECT ?1 AS owner_type, owner.id AS owner_id, owner.${displayColumn} AS display_name,
              account.committed_bytes, account.reserved_bytes,
              override.id AS override_policy_id,
              override.policy_version AS override_policy_version,
              override.limit_bytes AS override_limit_bytes,
              defaults.policy_version AS default_policy_version,
              defaults.limit_bytes AS default_limit_bytes
       FROM logical_storage_usage_accounts AS account
       JOIN ${sourceTable} AS owner ON owner.id = account.${ownerColumn}
       JOIN logical_storage_quota_policies AS defaults
         ON defaults.storage_mode = account.storage_mode
        AND defaults.owner_type = 'system_default'
        AND defaults.default_owner_type = ?1 AND defaults.policy_status = 'active'
       LEFT JOIN logical_storage_quota_policies AS override
         ON override.storage_mode = account.storage_mode
        AND override.owner_type = ?1 AND override.${ownerColumn} = owner.id
        AND override.policy_status = 'active'
       WHERE account.storage_mode = ?2 AND account.owner_type = ?1
         AND (?3 IS NULL OR owner.id = ?3)
       ORDER BY owner.${displayColumn}, owner.id`,
    )
    .bind(ownerType, storageMode, ownerId ?? null)
    .all<SubjectRow>()
  return rows.results
}

function defaultSummary(storageMode: StorageMode, row: DefaultRow): StorageQuotaDefaultSummary {
  return {
    ownerType: row.owner_type,
    storageMode,
    limitBytes: row.limit_bytes,
    policyVersion: row.policy_version,
  }
}

function subjectSummary(row: SubjectRow): StorageQuotaSubjectSummary {
  const limitBytes = row.override_limit_bytes ?? row.default_limit_bytes
  return {
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    displayName: row.display_name,
    committedBytes: row.committed_bytes,
    reservedBytes: row.reserved_bytes,
    limitBytes,
    remainingBytes: Math.max(0, limitBytes - row.committed_bytes - row.reserved_bytes),
    usesDefault: row.override_policy_id === null,
    policyVersion: row.override_policy_version ?? row.default_policy_version,
    overLimit: row.committed_bytes + row.reserved_bytes > limitBytes,
  }
}

function normalizeOwnerType(value: string): StorageQuotaOwnerType {
  if (value === 'user' || value === 'organization') return value
  throw new StorageQuotaInputError('ownerType', '配额主体类型无效')
}

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < MINIMUM_LIMIT_BYTES || value > MAXIMUM_LIMIT_BYTES) {
    throw new StorageQuotaInputError('limitBytes', '存储配额必须是 1 MB 至 1 TB 的整数值')
  }
  return value
}

async function requireAdministrator(database: D1Database, actorUserId: string): Promise<void> {
  const allowed = await database
    .prepare(
      `SELECT 1 AS allowed FROM system_instances
       WHERE singleton_id = 1 AND current_admin_user_id = ?1`,
    )
    .bind(actorUserId)
    .first<{ allowed: number }>()
  if (!allowed) throw new StorageQuotaPermissionError('只有系统管理员可以管理存储配额')
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
