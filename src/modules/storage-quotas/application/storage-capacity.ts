import type { StorageMode } from '../../../shared/contracts/storage-mode'
import type { StorageQuotaOwnerType } from '../../../shared/contracts/storage-quotas'
import { sha256Bytes } from '../../mail-receiving/domain/content-digest'

const RESERVATION_TTL_MS = 24 * 60 * 60 * 1000

export type LogicalStorageOperationKind =
  'receive' | 'draft' | 'sent_copy' | 'migration' | 'manual_adjustment'
export type LogicalStorageEntryKind =
  | 'message'
  | 'draft'
  | 'sent_copy'
  | 'deletion'
  | 'migration'
  | 'reconciliation'
  | 'manual_adjustment'

export interface LogicalStorageOwner {
  ownerType: StorageQuotaOwnerType
  ownerId: string
}

export interface LogicalStorageReservation {
  id: string
  accountId: string
  owner: LogicalStorageOwner
  operationKind: LogicalStorageOperationKind
  operationReference: string
  reservedBytes: number
  created: boolean
}

interface CapacityRow {
  account_id: string
  committed_bytes: number
  reserved_bytes: number
  policy_id: string
  policy_version: number
  limit_bytes: number
}

interface ExistingReservationRow {
  id: string
  storage_usage_account_id: string
  reserved_bytes: number
}

export class LogicalStorageCapacityError extends Error {
  constructor(
    readonly owner: LogicalStorageOwner,
    message = '当前邮箱的存储配额不足',
  ) {
    super(message)
  }
}

export async function reserveLogicalStorage(options: {
  database: D1Database
  storageMode: StorageMode
  owner: LogicalStorageOwner
  operationKind: LogicalStorageOperationKind
  operationReference: string
  bytes: number
  now?: number
}): Promise<LogicalStorageReservation | null> {
  const bytes = Math.ceil(options.bytes)
  if (bytes <= 0) return null
  const now = options.now ?? Date.now()
  const capacity = await loadCapacity(options.database, options.storageMode, options.owner)
  if (!capacity) throw new LogicalStorageCapacityError(options.owner, '当前邮箱缺少存储配额账户')

  const existing = await options.database
    .prepare(
      `SELECT id, storage_usage_account_id, reserved_bytes
       FROM logical_storage_reservations
       WHERE storage_usage_account_id = ?1 AND operation_kind = ?2
         AND operation_reference = ?3 AND reservation_status = 'reserved'
       LIMIT 1`,
    )
    .bind(capacity.account_id, options.operationKind, options.operationReference)
    .first<ExistingReservationRow>()
  if (existing) {
    if (existing.reserved_bytes !== bytes) {
      throw new LogicalStorageCapacityError(options.owner, '同一操作的存储配额预留大小不一致')
    }
    return {
      id: existing.id,
      accountId: existing.storage_usage_account_id,
      owner: options.owner,
      operationKind: options.operationKind,
      operationReference: options.operationReference,
      reservedBytes: bytes,
      created: false,
    }
  }

  const attempt = await options.database
    .prepare(
      `SELECT COUNT(*) AS count FROM logical_storage_reservations
       WHERE storage_usage_account_id = ?1 AND operation_kind = ?2 AND operation_reference = ?3`,
    )
    .bind(capacity.account_id, options.operationKind, options.operationReference)
    .first<{ count: number }>()
  const id = crypto.randomUUID()
  const digest = await sha256Bytes(
    `${capacity.account_id}\n${options.operationKind}\n${options.operationReference}\n${(attempt?.count ?? 0) + 1}`,
  )
  try {
    await options.database
      .prepare(
        `INSERT INTO logical_storage_reservations (
           id, storage_usage_account_id, quota_policy_id, operation_kind,
           operation_reference, reserved_bytes, limit_bytes_snapshot,
           reservation_key_digest, reservation_status, expires_at,
           committed_at, released_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'reserved', ?9,
                   NULL, NULL, ?10, ?10)`,
      )
      .bind(
        id,
        capacity.account_id,
        capacity.policy_id,
        options.operationKind,
        options.operationReference,
        bytes,
        capacity.limit_bytes,
        digest,
        now + RESERVATION_TTL_MS,
        now,
      )
      .run()
  } catch (error) {
    const raced = await options.database
      .prepare(
        `SELECT id, storage_usage_account_id, reserved_bytes
         FROM logical_storage_reservations
         WHERE storage_usage_account_id = ?1 AND operation_kind = ?2
           AND operation_reference = ?3 AND reservation_status = 'reserved'
         LIMIT 1`,
      )
      .bind(capacity.account_id, options.operationKind, options.operationReference)
      .first<ExistingReservationRow>()
    if (raced && raced.reserved_bytes === bytes) {
      return {
        id: raced.id,
        accountId: raced.storage_usage_account_id,
        owner: options.owner,
        operationKind: options.operationKind,
        operationReference: options.operationReference,
        reservedBytes: bytes,
        created: false,
      }
    }
    if (String(error).includes('逻辑存储配额不足')) {
      throw new LogicalStorageCapacityError(options.owner)
    }
    throw error
  }
  return {
    id,
    accountId: capacity.account_id,
    owner: options.owner,
    operationKind: options.operationKind,
    operationReference: options.operationReference,
    reservedBytes: bytes,
    created: true,
  }
}

export async function logicalStorageCommitStatements(options: {
  database: D1Database
  reservation: LogicalStorageReservation
  entryKind: LogicalStorageEntryKind
  ownerReference: string
  now?: number
}): Promise<D1PreparedStatement[]> {
  const now = options.now ?? Date.now()
  const digest = await sha256Bytes(
    `logical-storage-commit\n${options.reservation.id}\n${options.ownerReference}`,
  )
  return [
    options.database
      .prepare(
        `UPDATE logical_storage_reservations
         SET reservation_status = 'committed', committed_at = ?1, updated_at = ?1
         WHERE id = ?2 AND reservation_status = 'reserved'`,
      )
      .bind(now, options.reservation.id),
    options.database
      .prepare(
        `INSERT OR IGNORE INTO logical_storage_usage_entries (
           id, storage_usage_account_id, storage_reservation_id, entry_kind,
           owner_reference, bytes_delta, idempotency_key_digest, committed_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      )
      .bind(
        crypto.randomUUID(),
        options.reservation.accountId,
        options.reservation.id,
        options.entryKind,
        options.ownerReference,
        options.reservation.reservedBytes,
        digest,
        now,
      ),
  ]
}

export async function commitLogicalStorageReservation(options: {
  database: D1Database
  reservation: LogicalStorageReservation | null
  entryKind: LogicalStorageEntryKind
  ownerReference: string
  now?: number
}): Promise<void> {
  if (!options.reservation) return
  await options.database.batch(
    await logicalStorageCommitStatements({
      database: options.database,
      reservation: options.reservation,
      entryKind: options.entryKind,
      ownerReference: options.ownerReference,
      ...(options.now !== undefined ? { now: options.now } : {}),
    }),
  )
}

export async function releaseLogicalStorageReservation(options: {
  database: D1Database
  reservation: LogicalStorageReservation | null
  now?: number
}): Promise<void> {
  if (!options.reservation) return
  const now = options.now ?? Date.now()
  await options.database
    .prepare(
      `UPDATE logical_storage_reservations
       SET reservation_status = 'released', released_at = ?1, updated_at = ?1
       WHERE id = ?2 AND reservation_status = 'reserved'`,
    )
    .bind(now, options.reservation.id)
    .run()
}

export async function releaseLogicalStorageReservationByReference(options: {
  database: D1Database
  storageMode: StorageMode
  owner: LogicalStorageOwner
  operationKind: LogicalStorageOperationKind
  operationReference: string
  now?: number
}): Promise<void> {
  const account = await loadAccount(options.database, options.storageMode, options.owner)
  if (!account) return
  await options.database
    .prepare(
      `UPDATE logical_storage_reservations
       SET reservation_status = 'released', released_at = ?1, updated_at = ?1
       WHERE storage_usage_account_id = ?2 AND operation_kind = ?3
         AND operation_reference = ?4 AND reservation_status = 'reserved'`,
    )
    .bind(options.now ?? Date.now(), account.id, options.operationKind, options.operationReference)
    .run()
}

export async function commitLogicalStorageReservationByReference(options: {
  database: D1Database
  storageMode: StorageMode
  owner: LogicalStorageOwner
  operationKind: LogicalStorageOperationKind
  operationReference: string
  entryKind: LogicalStorageEntryKind
  ownerReference: string
  now?: number
}): Promise<void> {
  await options.database.batch(await logicalStorageCommitStatementsByReference(options))
}

export async function logicalStorageCommitStatementsByReference(options: {
  database: D1Database
  storageMode: StorageMode
  owner: LogicalStorageOwner
  operationKind: LogicalStorageOperationKind
  operationReference: string
  entryKind: LogicalStorageEntryKind
  ownerReference: string
  now?: number
}): Promise<D1PreparedStatement[]> {
  const account = await loadAccount(options.database, options.storageMode, options.owner)
  if (!account) return []
  const reservation = await options.database
    .prepare(
      `SELECT id, reserved_bytes
       FROM logical_storage_reservations
       WHERE storage_usage_account_id = ?1 AND operation_kind = ?2
         AND operation_reference = ?3 AND reservation_status = 'reserved'
       LIMIT 1`,
    )
    .bind(account.id, options.operationKind, options.operationReference)
    .first<{ id: string; reserved_bytes: number }>()
  if (!reservation) return []
  return logicalStorageCommitStatements({
    database: options.database,
    reservation: {
      id: reservation.id,
      accountId: account.id,
      owner: options.owner,
      operationKind: options.operationKind,
      operationReference: options.operationReference,
      reservedBytes: reservation.reserved_bytes,
      created: true,
    },
    entryKind: options.entryKind,
    ownerReference: options.ownerReference,
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
}

export async function logicalStorageAdjustmentStatement(options: {
  database: D1Database
  storageMode: StorageMode
  owner: LogicalStorageOwner
  entryKind: LogicalStorageEntryKind
  ownerReference: string
  bytesDelta: number
  idempotencyKey: string
  now?: number
}): Promise<D1PreparedStatement | null> {
  const bytesDelta = Math.trunc(options.bytesDelta)
  if (bytesDelta === 0) return null
  const account = await loadAccount(options.database, options.storageMode, options.owner)
  if (!account) throw new LogicalStorageCapacityError(options.owner, '当前邮箱缺少存储配额账户')
  const digest = await sha256Bytes(`logical-storage-adjustment\n${options.idempotencyKey}`)
  const now = options.now ?? Date.now()
  return options.database
    .prepare(
      `INSERT OR IGNORE INTO logical_storage_usage_entries (
         id, storage_usage_account_id, storage_reservation_id, entry_kind,
         owner_reference, bytes_delta, idempotency_key_digest, committed_at, created_at
       ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?7)`,
    )
    .bind(
      crypto.randomUUID(),
      account.id,
      options.entryKind,
      options.ownerReference,
      bytesDelta,
      digest,
      now,
    )
}

export async function expireLogicalStorageReservations(
  database: D1Database,
  now = Date.now(),
): Promise<void> {
  await database
    .prepare(
      `UPDATE logical_storage_reservations
       SET reservation_status = 'expired', released_at = ?1, updated_at = ?1
       WHERE reservation_status = 'reserved' AND expires_at <= ?1`,
    )
    .bind(now)
    .run()
}

async function loadCapacity(
  database: D1Database,
  storageMode: StorageMode,
  owner: LogicalStorageOwner,
): Promise<CapacityRow | null> {
  const ownerColumn = owner.ownerType === 'user' ? 'user_id' : 'organization_id'
  return database
    .prepare(
      `SELECT account.id AS account_id, account.committed_bytes, account.reserved_bytes,
              COALESCE(override.id, defaults.id) AS policy_id,
              COALESCE(override.policy_version, defaults.policy_version) AS policy_version,
              COALESCE(override.limit_bytes, defaults.limit_bytes) AS limit_bytes
       FROM logical_storage_usage_accounts AS account
       JOIN logical_storage_quota_policies AS defaults
         ON defaults.storage_mode = account.storage_mode
        AND defaults.owner_type = 'system_default'
        AND defaults.default_owner_type = account.owner_type
        AND defaults.policy_status = 'active'
       LEFT JOIN logical_storage_quota_policies AS override
         ON override.storage_mode = account.storage_mode
        AND override.owner_type = ?1 AND override.${ownerColumn} = ?2
        AND override.policy_status = 'active'
       WHERE account.storage_mode = ?3 AND account.owner_type = ?1
         AND account.${ownerColumn} = ?2
       LIMIT 1`,
    )
    .bind(owner.ownerType, owner.ownerId, storageMode)
    .first<CapacityRow>()
}

async function loadAccount(
  database: D1Database,
  storageMode: StorageMode,
  owner: LogicalStorageOwner,
): Promise<{ id: string } | null> {
  const ownerColumn = owner.ownerType === 'user' ? 'user_id' : 'organization_id'
  return database
    .prepare(
      `SELECT id FROM logical_storage_usage_accounts
       WHERE storage_mode = ?1 AND owner_type = ?2 AND ${ownerColumn} = ?3 LIMIT 1`,
    )
    .bind(storageMode, owner.ownerType, owner.ownerId)
    .first<{ id: string }>()
}
