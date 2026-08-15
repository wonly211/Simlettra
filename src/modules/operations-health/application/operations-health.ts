import type { StorageMode } from '../../../shared/contracts/storage-mode'
import type {
  InboundOperationsHealth,
  OperationsHealthOverviewResponse,
  OperationsHealthStatus,
  OutboundOperationsHealth,
  ScheduledOperationsHealth,
  StorageOperationsHealth,
} from '../../../shared/contracts/operations-health'

const STALLED_OPERATION_MS = 15 * 60 * 1000
const RECENT_FAILURE_MS = 24 * 60 * 60 * 1000
const SCHEDULED_STALE_MS = 2 * 60 * 60 * 1000

interface InboundRow {
  total_count: number
  last_accepted_at: number | null
  last_visible_at: number | null
  stalled_count: number
  attention_count: number
  latest_error_code: string | null
}

interface OutboundConfigurationRow {
  active_provider_count: number
  failed_provider_count: number
  active_route_count: number
  domains_without_route_count: number
}

interface OutboundActivityRow {
  last_activity_at: number | null
  stalled_recipient_count: number
  unknown_recipient_count: number
  recent_provider_rejection_count: number
  latest_error_code: string | null
}

interface ResourceSnapshotRow {
  resource_kind: string
  free_limit_bytes: number
  current_resource_limit_bytes: number
  account_used_bytes: number | null
  simlettra_used_bytes: number | null
  data_source: string
  fetch_status: string
  fetched_at: number
  error_code: string | null
  warning_ratio_bps: number
  stop_ratio_bps: number
}

interface ScheduledRunRow {
  run_status: string
  started_at: number
  completed_at: number | null
  error_code: string | null
}

interface ScheduledAggregateRow {
  last_succeeded_at: number | null
  last_failed_at: number | null
  latest_error_code: string | null
}

interface TaskHealthRow {
  needs_attention_count: number
  overdue_count: number
  latest_error_code: string | null
}

export class OperationsHealthPermissionError extends Error {
  constructor() {
    super('只有系统管理员可以查看运行健康状态')
  }
}

export async function getOperationsHealthOverview(options: {
  database: D1Database
  actorUserId: string
  storageMode: StorageMode
  now?: number
}): Promise<OperationsHealthOverviewResponse['data']> {
  const now = options.now ?? Date.now()
  await requireAdministrator(options.database, options.actorUserId)

  const [inbound, outbound, storage, scheduled] = await Promise.all([
    getInboundHealth(options.database, now),
    getOutboundHealth(options.database, now),
    getStorageHealth(options.database, options.storageMode),
    getScheduledHealth(options.database, now),
  ])
  const statuses = [inbound.status, outbound.status, storage.status, scheduled.status]
  return {
    overallStatus: statuses.includes('attention')
      ? 'attention'
      : statuses.every((status) => status === 'healthy')
        ? 'healthy'
        : 'unknown',
    checkedAt: now,
    inbound,
    outbound,
    storage,
    scheduled,
  }
}

async function getInboundHealth(
  database: D1Database,
  now: number,
): Promise<InboundOperationsHealth> {
  const row = await database
    .prepare(
      `SELECT
         COUNT(*) AS total_count,
         MAX(accepted_at) AS last_accepted_at,
         MAX(CASE WHEN operation_status = 'visible' THEN visible_at END) AS last_visible_at,
         SUM(CASE WHEN operation_status IN (
           'intent', 'raw_stored', 'parsing', 'derived_stored', 'waiting_consistency', 'committing'
         ) AND updated_at <= ?1 THEN 1 ELSE 0 END) AS stalled_count,
         SUM(CASE WHEN operation_status = 'needs_attention'
           OR (operation_status IN ('parse_failed', 'damaged') AND completed_at >= ?2)
           THEN 1 ELSE 0 END) AS attention_count,
         (
           SELECT error_code FROM receive_operations
           WHERE error_code IS NOT NULL
           ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC LIMIT 1
         ) AS latest_error_code
       FROM receive_operations`,
    )
    .bind(now - STALLED_OPERATION_MS, now - RECENT_FAILURE_MS)
    .first<InboundRow>()
  const totalCount = numberValue(row?.total_count)
  const stalledCount = numberValue(row?.stalled_count)
  const attentionCount = numberValue(row?.attention_count)
  const status: OperationsHealthStatus =
    stalledCount > 0 || attentionCount > 0 ? 'attention' : totalCount === 0 ? 'unknown' : 'healthy'
  return {
    status,
    summary:
      status === 'attention'
        ? `${stalledCount} 个收信操作停滞，${attentionCount} 个结果需要检查`
        : status === 'unknown'
          ? '尚无收信运行记录'
          : '最近收信操作没有发现停滞或需人工处理的结果',
    lastAcceptedAt: nullableNumber(row?.last_accepted_at),
    lastVisibleAt: nullableNumber(row?.last_visible_at),
    stalledCount,
    attentionCount,
    latestErrorCode: row?.latest_error_code ?? null,
  }
}

async function getOutboundHealth(
  database: D1Database,
  now: number,
): Promise<OutboundOperationsHealth> {
  const [configuration, activity] = await Promise.all([
    database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM outbound_provider_configs
             WHERE configuration_status = 'active') AS active_provider_count,
           (SELECT COUNT(*) FROM outbound_provider_configs
             WHERE configuration_status = 'active' AND last_test_result = 'failed') AS failed_provider_count,
           (SELECT COUNT(*) FROM domain_outbound_routes
             WHERE route_status = 'active') AS active_route_count,
           (SELECT COUNT(*) FROM mail_domains AS domain
             WHERE domain.status = 'active' AND NOT EXISTS (
               SELECT 1 FROM domain_outbound_routes AS route
               WHERE route.mail_domain_id = domain.id AND route.route_status = 'active'
             )) AS domains_without_route_count`,
      )
      .first<OutboundConfigurationRow>(),
    database
      .prepare(
        `SELECT
           MAX(status_updated_at) AS last_activity_at,
           SUM(CASE WHEN delivery_status IN ('waiting', 'submitting') AND status_updated_at <= ?1
             THEN 1 ELSE 0 END) AS stalled_recipient_count,
           SUM(CASE WHEN delivery_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_recipient_count,
           (SELECT COUNT(*) FROM outbound_submission_attempts
             WHERE attempt_status = 'not_accepted' AND completed_at >= ?2) AS recent_provider_rejection_count,
           (SELECT error_code FROM outbound_submission_attempts
             WHERE error_code IS NOT NULL
             ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC LIMIT 1) AS latest_error_code
         FROM send_recipients`,
      )
      .bind(now - STALLED_OPERATION_MS, now - RECENT_FAILURE_MS)
      .first<OutboundActivityRow>(),
  ])
  const activeProviderCount = numberValue(configuration?.active_provider_count)
  const activeRouteCount = numberValue(configuration?.active_route_count)
  const domainsWithoutRouteCount = numberValue(configuration?.domains_without_route_count)
  const failedProviderCount = numberValue(configuration?.failed_provider_count)
  const stalledRecipientCount = numberValue(activity?.stalled_recipient_count)
  const unknownRecipientCount = numberValue(activity?.unknown_recipient_count)
  const recentProviderRejectionCount = numberValue(activity?.recent_provider_rejection_count)
  const notConfigured = activeProviderCount === 0 || activeRouteCount === 0
  const hasAttention =
    failedProviderCount > 0 ||
    domainsWithoutRouteCount > 0 ||
    stalledRecipientCount > 0 ||
    unknownRecipientCount > 0 ||
    recentProviderRejectionCount > 0
  const status: OperationsHealthStatus = notConfigured
    ? 'not_configured'
    : hasAttention
      ? 'attention'
      : 'healthy'
  return {
    status,
    summary:
      status === 'not_configured'
        ? '尚未形成可用的域外发信服务与域名路线'
        : status === 'attention'
          ? `${stalledRecipientCount} 名收件人提交停滞，${unknownRecipientCount} 名结果未知，${recentProviderRejectionCount} 次服务未接受`
          : '域外发信配置可用，未发现停滞或结果未知的收件人',
    activeProviderCount,
    activeRouteCount,
    domainsWithoutRouteCount,
    lastActivityAt: nullableNumber(activity?.last_activity_at),
    stalledRecipientCount,
    unknownRecipientCount,
    recentProviderRejectionCount,
    latestErrorCode: activity?.latest_error_code ?? null,
  }
}

async function getStorageHealth(
  database: D1Database,
  storageMode: StorageMode,
): Promise<StorageOperationsHealth> {
  const expectedKinds = ['d1', storageMode]
  const result = await database
    .prepare(
      `SELECT snapshot.resource_kind, snapshot.free_limit_bytes,
              snapshot.current_resource_limit_bytes, snapshot.account_used_bytes,
              snapshot.simlettra_used_bytes, snapshot.data_source, snapshot.fetch_status,
              snapshot.fetched_at, snapshot.error_code,
              threshold.warning_ratio_bps, threshold.stop_ratio_bps
       FROM platform_resource_snapshots AS snapshot
       JOIN platform_resource_thresholds AS threshold
         ON threshold.resource_kind = snapshot.resource_kind
        AND threshold.threshold_status = 'active'
       WHERE snapshot.resource_kind IN (?1, ?2)
         AND snapshot.id = (
           SELECT newer.id FROM platform_resource_snapshots AS newer
           WHERE newer.resource_kind = snapshot.resource_kind
           ORDER BY newer.fetched_at DESC, newer.id DESC LIMIT 1
         )`,
    )
    .bind(expectedKinds[0], expectedKinds[1])
    .all<ResourceSnapshotRow>()
  let warningResourceCount = 0
  let stoppedResourceCount = 0
  let unavailableResourceCount = 0
  let latestSnapshotAt: number | null = null
  let latestErrorCode: string | null = null
  for (const row of result.results) {
    latestSnapshotAt = Math.max(latestSnapshotAt ?? 0, row.fetched_at)
    if (row.error_code) latestErrorCode = row.error_code
    if (!['success', 'stale'].includes(row.fetch_status)) {
      unavailableResourceCount += 1
      continue
    }
    const accountRatio = ratioBps(row.account_used_bytes, row.free_limit_bytes)
    const currentRatio = ratioBps(row.simlettra_used_bytes, row.current_resource_limit_bytes)
    const usageRatio = Math.max(accountRatio, currentRatio)
    const effectiveStopRatio =
      row.data_source === 'local_estimate' ? Math.min(row.stop_ratio_bps, 8000) : row.stop_ratio_bps
    if (usageRatio >= effectiveStopRatio) stoppedResourceCount += 1
    else if (usageRatio >= row.warning_ratio_bps) warningResourceCount += 1
    if (row.fetch_status === 'stale') unavailableResourceCount += 1
  }
  const missingResourceCount = expectedKinds.length - result.results.length
  const status: OperationsHealthStatus =
    stoppedResourceCount > 0 || unavailableResourceCount > 0
      ? 'attention'
      : missingResourceCount > 0
        ? 'unknown'
        : warningResourceCount > 0
          ? 'attention'
          : 'healthy'
  return {
    status,
    summary:
      status === 'unknown'
        ? `${missingResourceCount} 项资源尚无用量快照`
        : status === 'attention'
          ? `${warningResourceCount} 项达到预警线，${stoppedResourceCount} 项达到停止线，${unavailableResourceCount} 项快照不可用或过期`
          : 'D1 与当前对象存储快照没有达到预警或停止线',
    latestSnapshotAt,
    warningResourceCount,
    stoppedResourceCount,
    unavailableResourceCount,
    missingResourceCount,
    latestErrorCode,
  }
}

async function getScheduledHealth(
  database: D1Database,
  now: number,
): Promise<ScheduledOperationsHealth> {
  const [latestRun, aggregate, tasks] = await Promise.all([
    database
      .prepare(
        `SELECT run_status, started_at, completed_at, error_code
         FROM scheduled_maintenance_runs ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .first<ScheduledRunRow>(),
    database
      .prepare(
        `SELECT
           MAX(CASE WHEN run_status = 'succeeded' THEN completed_at END) AS last_succeeded_at,
           MAX(CASE WHEN run_status = 'failed' THEN completed_at END) AS last_failed_at,
           (SELECT error_code FROM scheduled_maintenance_runs
             WHERE error_code IS NOT NULL ORDER BY completed_at DESC, id DESC LIMIT 1)
             AS latest_error_code
         FROM scheduled_maintenance_runs`,
      )
      .first<ScheduledAggregateRow>(),
    database
      .prepare(
        `SELECT
           SUM(CASE WHEN task_status = 'needs_attention' THEN 1 ELSE 0 END)
             AS needs_attention_count,
           SUM(CASE WHEN (
             task_status IN ('pending', 'retry_wait') AND next_attempt_at <= ?1
           ) OR (
             task_status = 'running' AND lease_expires_at <= ?2
           ) THEN 1 ELSE 0 END) AS overdue_count,
           (SELECT last_error_code FROM background_tasks
             WHERE last_error_code IS NOT NULL ORDER BY last_error_at DESC, id DESC LIMIT 1)
             AS latest_error_code
         FROM background_tasks`,
      )
      .bind(now - STALLED_OPERATION_MS, now)
      .first<TaskHealthRow>(),
  ])
  const needsAttentionTaskCount = numberValue(tasks?.needs_attention_count)
  const overdueTaskCount = numberValue(tasks?.overdue_count)
  const lastSucceededAt = nullableNumber(aggregate?.last_succeeded_at)
  const lastFailedAt = nullableNumber(aggregate?.last_failed_at)
  const latestRunAttention = Boolean(
    latestRun &&
    ((latestRun.run_status === 'running' && latestRun.started_at <= now - STALLED_OPERATION_MS) ||
      latestRun.run_status === 'failed' ||
      latestRun.started_at <= now - SCHEDULED_STALE_MS),
  )
  const status: OperationsHealthStatus = !latestRun
    ? 'unknown'
    : latestRunAttention || needsAttentionTaskCount > 0 || overdueTaskCount > 0
      ? 'attention'
      : 'healthy'
  return {
    status,
    summary:
      status === 'unknown'
        ? '尚无定时维护运行记录'
        : status === 'attention'
          ? `${needsAttentionTaskCount} 个任务需要人工处理，${overdueTaskCount} 个任务已经逾期`
          : latestRun?.run_status === 'running'
            ? '定时维护正在运行，后台任务没有需人工处理或逾期项目'
            : '最近定时维护成功，后台任务没有需人工处理或逾期项目',
    lastStartedAt: latestRun?.started_at ?? null,
    lastSucceededAt,
    lastFailedAt,
    needsAttentionTaskCount,
    overdueTaskCount,
    latestErrorCode: tasks?.latest_error_code ?? aggregate?.latest_error_code ?? null,
  }
}

async function requireAdministrator(database: D1Database, actorUserId: string): Promise<void> {
  const row = await database
    .prepare(
      `SELECT 1 AS allowed FROM system_instances
       WHERE singleton_id = 1 AND current_admin_user_id = ?1`,
    )
    .bind(actorUserId)
    .first<{ allowed: number }>()
  if (!row) throw new OperationsHealthPermissionError()
}

function numberValue(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nullableNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function ratioBps(used: number | null, limit: number): number {
  if (used === null || limit <= 0) return 0
  return Math.round((used / limit) * 10_000)
}
