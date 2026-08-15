import type { StorageMode } from '../../../shared/contracts/storage-mode'
import { sha256Bytes } from '../../mail-receiving/domain/content-digest'
import { refreshConfiguredPlatformResources } from './platform-resource-management'

const RESERVATION_TTL_MS = 30 * 60 * 1000
const LOCAL_ESTIMATE_MAX_STOP_BPS = 8000

export type PlatformCapacityOperationKind =
  'receive' | 'draft_attachment' | 'sent_copy' | 'mail_export'

export interface PlatformCapacityReservation {
  operationKind: PlatformCapacityOperationKind
  operationReference: string
  resourceKinds: Array<'d1' | StorageMode>
  created: boolean
}

export class PlatformCapacityUnavailableError extends Error {
  constructor(
    readonly resourceKind: 'd1' | 'kv' | 'r2' | 'unknown',
    message = 'Cloudflare 免费资源容量不足或当前无法可靠判断剩余容量',
  ) {
    super(message)
  }
}

interface CapacityRow {
  snapshot_id: string
  threshold_id: string
  free_limit_bytes: number
  current_resource_limit_bytes: number
  account_used_bytes: number
  simlettra_used_bytes: number
  data_source: string
  fetch_status: string
  stop_ratio_bps: number
}

export async function reservePlatformCapacity(options: {
  database: D1Database
  storageMode: StorageMode
  operationKind: PlatformCapacityOperationKind
  operationReference: string
  d1EstimatedBytes: number
  objectEstimatedBytes: number
  now?: number
}): Promise<PlatformCapacityReservation> {
  const now = options.now ?? Date.now()
  const estimates = [
    { kind: 'd1' as const, bytes: normalizeBytes(options.d1EstimatedBytes) },
    { kind: options.storageMode, bytes: normalizeBytes(options.objectEstimatedBytes) },
  ]
  let created = false
  const statements: D1PreparedStatement[] = []
  for (const estimate of estimates) {
    const existing = await options.database
      .prepare(
        `SELECT 1 AS found FROM platform_capacity_reservations
         WHERE operation_kind = ?1 AND operation_reference = ?2 AND resource_kind = ?3
           AND reservation_status IN ('reserved', 'committed_pending_snapshot') LIMIT 1`,
      )
      .bind(options.operationKind, options.operationReference, estimate.kind)
      .first<{ found: number }>()
    if (existing) continue
    let capacity = await loadCapacity(options.database, estimate.kind)
    if (!capacity) {
      await refreshConfiguredPlatformResources({
        database: options.database,
        storageMode: options.storageMode,
        now,
      })
      capacity = await loadCapacity(options.database, estimate.kind)
    }
    if (!capacity || !['success', 'stale'].includes(capacity.fetch_status)) {
      throw new PlatformCapacityUnavailableError(estimate.kind)
    }
    const effectiveStopBps =
      capacity.data_source === 'local_estimate'
        ? Math.min(capacity.stop_ratio_bps, LOCAL_ESTIMATE_MAX_STOP_BPS)
        : capacity.stop_ratio_bps
    const stopLimit = Math.floor((capacity.free_limit_bytes * effectiveStopBps) / 10000)
    const currentResourceStopLimit = Math.floor(
      (capacity.current_resource_limit_bytes * effectiveStopBps) / 10000,
    )
    const safetyMargin =
      capacity.data_source === 'local_estimate'
        ? Math.max(1_000_000, Math.ceil(estimate.bytes * 0.25))
        : Math.max(64_000, Math.ceil(estimate.bytes * 0.05))
    const previousAttempts = await options.database
      .prepare(
        `SELECT COUNT(*) AS attempt_count FROM platform_capacity_reservations
         WHERE operation_kind = ?1 AND operation_reference = ?2 AND resource_kind = ?3`,
      )
      .bind(options.operationKind, options.operationReference, estimate.kind)
      .first<{ attempt_count: number }>()
    const key = await sha256Bytes(
      `${options.operationKind}\n${options.operationReference}\n${estimate.kind}\n${(previousAttempts?.attempt_count ?? 0) + 1}`,
    )
    statements.push(
      options.database
        .prepare(
          `INSERT INTO platform_capacity_reservations (
             id, platform_resource_snapshot_id, platform_resource_threshold_id,
             resource_kind, operation_kind, operation_reference, estimated_bytes,
             safety_margin_bytes, stop_limit_bytes_snapshot,
             current_resource_stop_limit_bytes_snapshot, reservation_key_digest,
             reservation_status, expires_at, committed_at, reconciled_at,
             released_at, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                     'reserved', ?12, NULL, NULL, NULL, ?13, ?13)`,
        )
        .bind(
          crypto.randomUUID(),
          capacity.snapshot_id,
          capacity.threshold_id,
          estimate.kind,
          options.operationKind,
          options.operationReference,
          estimate.bytes,
          safetyMargin,
          stopLimit,
          currentResourceStopLimit,
          key,
          now + RESERVATION_TTL_MS,
          now,
        ),
    )
  }
  try {
    if (statements.length) {
      await options.database.batch(statements)
      created = true
    }
  } catch (error) {
    const active = await countActiveOperationReservations(
      options.database,
      options.operationKind,
      options.operationReference,
    )
    if (active === estimates.length) {
      return {
        operationKind: options.operationKind,
        operationReference: options.operationReference,
        resourceKinds: ['d1', options.storageMode],
        created: false,
      }
    }
    if (String(error).includes('平台免费容量不足')) {
      throw new PlatformCapacityUnavailableError('unknown')
    }
    throw error
  }
  return {
    operationKind: options.operationKind,
    operationReference: options.operationReference,
    resourceKinds: ['d1', options.storageMode],
    created,
  }
}

export async function commitPlatformCapacityReservation(options: {
  database: D1Database
  reservation: PlatformCapacityReservation
  now?: number
}) {
  const now = options.now ?? Date.now()
  await options.database
    .prepare(
      `UPDATE platform_capacity_reservations
       SET reservation_status = 'committed_pending_snapshot', committed_at = ?1, updated_at = ?1
       WHERE operation_kind = ?2 AND operation_reference = ?3 AND reservation_status = 'reserved'`,
    )
    .bind(now, options.reservation.operationKind, options.reservation.operationReference)
    .run()
}

export async function releasePlatformCapacityReservation(options: {
  database: D1Database
  reservation: PlatformCapacityReservation
  now?: number
}) {
  if (!options.reservation.created) return
  const now = options.now ?? Date.now()
  await options.database
    .prepare(
      `UPDATE platform_capacity_reservations
       SET reservation_status = 'released', released_at = ?1, updated_at = ?1
       WHERE operation_kind = ?2 AND operation_reference = ?3 AND reservation_status IN ('reserved', 'committed_pending_snapshot')`,
    )
    .bind(now, options.reservation.operationKind, options.reservation.operationReference)
    .run()
}

async function countActiveOperationReservations(
  database: D1Database,
  operationKind: PlatformCapacityOperationKind,
  operationReference: string,
) {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS active_count FROM platform_capacity_reservations
       WHERE operation_kind = ?1 AND operation_reference = ?2
         AND reservation_status IN ('reserved', 'committed_pending_snapshot')`,
    )
    .bind(operationKind, operationReference)
    .first<{ active_count: number }>()
  return row?.active_count ?? 0
}

export async function expirePlatformCapacityReservations(database: D1Database, now = Date.now()) {
  await database
    .prepare(
      `UPDATE platform_capacity_reservations
       SET reservation_status = 'expired', released_at = ?1, updated_at = ?1
       WHERE reservation_status = 'reserved' AND expires_at <= ?1`,
    )
    .bind(now)
    .run()
}

async function loadCapacity(database: D1Database, kind: string): Promise<CapacityRow | null> {
  return database
    .prepare(
      `SELECT snapshot.id AS snapshot_id, threshold.id AS threshold_id,
              snapshot.free_limit_bytes, snapshot.current_resource_limit_bytes,
              snapshot.account_used_bytes, snapshot.simlettra_used_bytes,
              snapshot.data_source, snapshot.fetch_status, threshold.stop_ratio_bps
       FROM platform_resource_snapshots snapshot
       JOIN platform_resource_thresholds threshold
         ON threshold.resource_kind = snapshot.resource_kind AND threshold.threshold_status = 'active'
       WHERE snapshot.resource_kind = ?1
       ORDER BY snapshot.fetched_at DESC, snapshot.id DESC LIMIT 1`,
    )
    .bind(kind)
    .first<CapacityRow>()
}

function normalizeBytes(value: number) {
  return Math.max(1, Math.ceil(value))
}
