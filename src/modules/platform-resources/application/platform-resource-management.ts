import type { StorageMode } from '../../../shared/contracts/storage-mode'
import type {
  PlatformResourceConfigurationSummary,
  PlatformResourceKind,
  PlatformResourceOverviewResponse,
  PlatformResourceSummary,
  SavePlatformResourceConfigurationRequest,
  SavePlatformResourceThresholdRequest,
} from '../../../shared/contracts/platform-resources'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'
import {
  decryptPlatformResourceToken,
  encryptPlatformResourceToken,
  PlatformResourceCredentialError,
  RESOURCE_CREDENTIAL_ALGORITHM,
} from './resource-credential'

const D1_ACCOUNT_FREE_LIMIT_BYTES = 5_000_000_000
const D1_DATABASE_FREE_LIMIT_BYTES = 500_000_000
const KV_FREE_LIMIT_BYTES = 1_000_000_000
const R2_FREE_LIMIT_BYTES = 10_000_000_000
const LOCAL_ESTIMATE_MAX_STOP_BPS = 8000
const SNAPSHOT_STALE_MS = 2 * 60 * 60 * 1000

interface ConfigurationRow {
  account_id: string
  d1_database_id: string
  storage_resource_reference: string
  api_token_ciphertext: ArrayBuffer
  api_token_nonce: ArrayBuffer
  configuration_version: number
  configuration_status: string
  last_tested_at: number | null
  last_test_result: string | null
  last_test_summary: string | null
}

interface ThresholdRow {
  id: string
  resource_kind: PlatformResourceKind
  warning_ratio_bps: number
  stop_ratio_bps: number
}

interface SnapshotRow {
  id: string
  resource_kind: PlatformResourceKind
  scope_kind: 'account' | 'local_only'
  scope_reference: string
  free_limit_bytes: number
  current_resource_limit_bytes: number
  account_used_bytes: number | null
  simlettra_used_bytes: number | null
  remaining_bytes: number | null
  current_resource_remaining_bytes: number | null
  item_count: number | null
  data_source: 'cloudflare_api' | 'local_estimate'
  fetch_status: 'success' | 'stale' | 'unavailable' | 'permission_denied'
  observed_at: number | null
  fetched_at: number
  error_code: string | null
}

interface SnapshotInsert {
  resourceKind: PlatformResourceKind
  scopeKind: 'account' | 'local_only'
  scopeReference: string
  freeLimitBytes: number
  currentResourceLimitBytes: number
  accountUsedBytes: number | null
  simlettraUsedBytes: number | null
  remainingBytes: number | null
  currentResourceRemainingBytes: number | null
  itemCount: number | null
  dataSource: 'cloudflare_api' | 'local_estimate'
  fetchStatus: 'success' | 'stale' | 'unavailable' | 'permission_denied'
  observedAt: number | null
  fetchedAt: number
  errorCode: string | null
}

interface CloudflareApiEnvelope<T> {
  success?: boolean
  result?: T
  result_info?: { page?: number; total_pages?: number }
  errors?: Array<{ code?: number; message?: string }>
}

export class PlatformResourcePermissionError extends Error {}

export class PlatformResourceInputError extends Error {
  constructor(
    readonly field:
      | 'accountId'
      | 'd1DatabaseId'
      | 'storageResourceReference'
      | 'apiToken'
      | 'resourceKind'
      | 'warningPercent'
      | 'stopPercent'
      | 'encryptionKey',
    message: string,
  ) {
    super(message)
  }
}

export class PlatformResourceRefreshError extends Error {
  constructor(
    readonly code: 'configuration_missing' | 'permission_denied' | 'cloudflare_unavailable',
    message: string,
  ) {
    super(message)
  }
}

export async function getPlatformResourceOverview(options: {
  database: D1Database
  actorUserId: string
  storageMode: StorageMode
  encryptionKeyBase64?: string
  now?: number
}): Promise<PlatformResourceOverviewResponse['data']> {
  await requireAdministrator(options.database, options.actorUserId)
  const now = options.now ?? Date.now()
  const configuration = await loadConfiguration(options.database)
  const [thresholds, snapshots] = await Promise.all([
    loadThresholds(options.database),
    ensureReadableSnapshots(options.database, options.storageMode, now),
  ])
  let token = ''
  if (configuration?.configuration_status === 'active') {
    try {
      token = await decryptPlatformResourceToken({
        ...(options.encryptionKeyBase64
          ? { encryptionKeyBase64: options.encryptionKeyBase64 }
          : {}),
        configurationVersion: configuration.configuration_version,
        ciphertext: configuration.api_token_ciphertext,
        nonce: configuration.api_token_nonce,
      })
    } catch (error) {
      if (error instanceof PlatformResourceCredentialError) {
        throw new PlatformResourceInputError('encryptionKey', error.message)
      }
      throw error
    }
  }
  return {
    storageMode: options.storageMode,
    configuration: configurationSummary(configuration, token),
    resources: buildResourceSummaries(options.storageMode, thresholds, snapshots, now),
  }
}

export async function savePlatformResourceConfiguration(options: {
  database: D1Database
  actorUserId: string
  storageMode: StorageMode
  encryptionKeyBase64?: string
  input: SavePlatformResourceConfigurationRequest
  audit: AuditContext
  fetcher?: typeof fetch
  now?: number
}): Promise<PlatformResourceConfigurationSummary> {
  await requireAdministrator(options.database, options.actorUserId)
  const input = normalizeConfiguration(options.input)
  const now = options.now ?? Date.now()
  const previous = await loadConfiguration(options.database)
  const version = (previous?.configuration_version ?? 0) + 1
  let encrypted
  try {
    encrypted = await encryptPlatformResourceToken({
      ...(options.encryptionKeyBase64 ? { encryptionKeyBase64: options.encryptionKeyBase64 } : {}),
      configurationVersion: version,
      token: input.apiToken,
    })
  } catch (error) {
    if (error instanceof PlatformResourceCredentialError) {
      throw new PlatformResourceInputError('encryptionKey', error.message)
    }
    throw error
  }
  const test = await fetchD1Usage({
    fetcher: options.fetcher ?? fetch,
    accountId: input.accountId,
    databaseId: input.d1DatabaseId,
    apiToken: input.apiToken,
  })
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO cloudflare_resource_configurations (
           singleton_id, account_id, d1_database_id, storage_resource_reference,
           api_token_ciphertext, api_token_nonce, credential_algorithm,
           credential_key_version, configuration_version, configuration_status,
           last_tested_at, last_test_result, last_test_summary,
           deleted_at, created_at, updated_at
         ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, 'active',
                   ?8, ?9, ?10, NULL, ?8, ?8)
         ON CONFLICT(singleton_id) DO UPDATE SET
           account_id = excluded.account_id,
           d1_database_id = excluded.d1_database_id,
           storage_resource_reference = excluded.storage_resource_reference,
           api_token_ciphertext = excluded.api_token_ciphertext,
           api_token_nonce = excluded.api_token_nonce,
           credential_algorithm = excluded.credential_algorithm,
           credential_key_version = excluded.credential_key_version,
           configuration_version = excluded.configuration_version,
           configuration_status = 'active',
           last_tested_at = excluded.last_tested_at,
           last_test_result = excluded.last_test_result,
           last_test_summary = excluded.last_test_summary,
           deleted_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.accountId,
        input.d1DatabaseId,
        input.storageResourceReference,
        encrypted.ciphertext,
        encrypted.nonce,
        RESOURCE_CREDENTIAL_ALGORITHM,
        version,
        now,
        test.status === 'success' ? 'success' : 'failed',
        test.status === 'success' ? 'D1 只读接口验证成功' : test.summary,
      ),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actorUserId,
      actionName: previous
        ? 'cloudflare_resource_configuration_replaced'
        : 'cloudflare_resource_configuration_created',
      targetType: 'cloudflare_resource_configuration',
      targetReference: '1',
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ]
  const results = await options.database.batch(statements)
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new PlatformResourceInputError('apiToken', 'Cloudflare 资源配置已发生变化，请刷新后重试')
  }
  if (test.status === 'success') {
    await refreshPlatformResourceSnapshots({
      database: options.database,
      actorUserId: options.actorUserId,
      storageMode: options.storageMode,
      ...(options.encryptionKeyBase64 ? { encryptionKeyBase64: options.encryptionKeyBase64 } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      now,
      skipPermissionCheck: true,
    })
  }
  return configurationSummary(await loadConfiguration(options.database), input.apiToken)
}

export async function deletePlatformResourceConfiguration(options: {
  database: D1Database
  actorUserId: string
  audit: AuditContext
  now?: number
}): Promise<void> {
  await requireAdministrator(options.database, options.actorUserId)
  const now = options.now ?? Date.now()
  const current = await loadConfiguration(options.database)
  if (!current || current.configuration_status !== 'active') {
    throw new PlatformResourceInputError('apiToken', '当前没有可删除的 Cloudflare 资源配置')
  }
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE cloudflare_resource_configurations
         SET configuration_status = 'deleted', deleted_at = ?1, updated_at = ?1
         WHERE singleton_id = 1 AND configuration_status = 'active'`,
      )
      .bind(now),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actorUserId,
      actionName: 'cloudflare_resource_configuration_deleted',
      targetType: 'cloudflare_resource_configuration',
      targetReference: '1',
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ])
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new PlatformResourceInputError('apiToken', '当前没有可删除的 Cloudflare 资源配置')
  }
}

export async function savePlatformResourceThreshold(options: {
  database: D1Database
  actorUserId: string
  resourceKind: string
  input: SavePlatformResourceThresholdRequest
  storageMode: StorageMode
  encryptionKeyBase64?: string
  audit: AuditContext
  now?: number
}): Promise<PlatformResourceSummary> {
  await requireAdministrator(options.database, options.actorUserId)
  const resourceKind = normalizeResourceKind(options.resourceKind)
  if (resourceKind !== 'd1' && resourceKind !== options.storageMode) {
    throw new PlatformResourceInputError('resourceKind', '当前部署未使用这个对象存储资源')
  }
  const input = normalizeThreshold(options.input)
  const now = options.now ?? Date.now()
  const current = await options.database
    .prepare(
      `SELECT id, threshold_version FROM platform_resource_thresholds
       WHERE resource_kind = ?1 AND threshold_status = 'active' LIMIT 1`,
    )
    .bind(resourceKind)
    .first<{ id: string; threshold_version: number }>()
  if (!current) throw new PlatformResourceInputError('resourceKind', '资源阈值不存在')
  const id = crypto.randomUUID()
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE platform_resource_thresholds
         SET threshold_status = 'retired', retired_at = ?1, updated_at = ?1
         WHERE id = ?2 AND threshold_status = 'active'`,
      )
      .bind(now, current.id),
    options.database
      .prepare(
        `INSERT INTO platform_resource_thresholds (
           id, resource_kind, threshold_version, warning_ratio_bps, stop_ratio_bps,
           threshold_status, effective_at, retired_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, NULL, ?6, ?6)`,
      )
      .bind(
        id,
        resourceKind,
        current.threshold_version + 1,
        input.warningPercent * 100,
        input.stopPercent * 100,
        now,
      ),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actorUserId,
      actionName: 'platform_resource_threshold_changed',
      targetType: 'platform_resource',
      targetReference: resourceKind,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new PlatformResourceInputError('stopPercent', '资源阈值已经发生变化，请刷新后重试')
  }
  const overview = await getPlatformResourceOverview(options)
  const resource = overview.resources.find((item) => item.resourceKind === resourceKind)
  if (!resource) throw new Error('资源阈值保存后无法读取')
  return resource
}

export async function refreshPlatformResourceSnapshots(options: {
  database: D1Database
  actorUserId?: string
  storageMode: StorageMode
  encryptionKeyBase64?: string
  fetcher?: typeof fetch
  now?: number
  skipPermissionCheck?: boolean
}): Promise<PlatformResourceSummary[]> {
  if (!options.skipPermissionCheck) {
    if (!options.actorUserId)
      throw new PlatformResourcePermissionError('只有系统管理员可以刷新资源用量')
    await requireAdministrator(options.database, options.actorUserId)
  }
  const now = options.now ?? Date.now()
  const configuration = await loadConfiguration(options.database)
  const local = await collectLocalEstimates(options.database, options.storageMode)
  const thresholds = await loadThresholds(options.database)
  if (!configuration || configuration.configuration_status !== 'active') {
    await insertLocalEstimateSnapshots(
      options.database,
      options.storageMode,
      local,
      now,
      'configuration_missing',
    )
    return buildResourceSummaries(
      options.storageMode,
      thresholds,
      await loadLatestSnapshots(options.database, options.storageMode),
      now,
    )
  }

  let token: string
  try {
    token = await decryptPlatformResourceToken({
      ...(options.encryptionKeyBase64 ? { encryptionKeyBase64: options.encryptionKeyBase64 } : {}),
      configurationVersion: configuration.configuration_version,
      ciphertext: configuration.api_token_ciphertext,
      nonce: configuration.api_token_nonce,
    })
  } catch (error) {
    if (error instanceof PlatformResourceCredentialError) {
      throw new PlatformResourceInputError('encryptionKey', error.message)
    }
    throw error
  }
  const fetcher = options.fetcher ?? fetch
  const d1 = await fetchD1Usage({
    fetcher,
    accountId: configuration.account_id,
    databaseId: configuration.d1_database_id,
    apiToken: token,
  })
  const storage = await fetchObjectStorageUsage({
    fetcher,
    storageMode: options.storageMode,
    accountId: configuration.account_id,
    resourceReference: configuration.storage_resource_reference,
    apiToken: token,
  })
  await insertRefreshSnapshots({
    database: options.database,
    storageMode: options.storageMode,
    configuration,
    local,
    d1,
    storage,
    now,
  })
  await reconcileIncludedReservations(options.database, now)
  await options.database
    .prepare(
      `UPDATE cloudflare_resource_configurations
       SET last_tested_at = ?1, last_test_result = ?2, last_test_summary = ?3, updated_at = ?1
       WHERE singleton_id = 1 AND configuration_status = 'active'`,
    )
    .bind(
      now,
      d1.status === 'success' && storage.status === 'success' ? 'success' : 'failed',
      d1.status === 'success' && storage.status === 'success'
        ? 'D1 与当前对象存储指标刷新成功'
        : [d1.summary, storage.summary].filter(Boolean).join('；'),
    )
    .run()
  return buildResourceSummaries(
    options.storageMode,
    thresholds,
    await loadLatestSnapshots(options.database, options.storageMode),
    now,
  )
}

export async function refreshConfiguredPlatformResources(options: {
  database: D1Database
  storageMode: StorageMode
  encryptionKeyBase64?: string
  fetcher?: typeof fetch
  now?: number
}): Promise<void> {
  try {
    await refreshPlatformResourceSnapshots({ ...options, skipPermissionCheck: true })
  } catch {
    const now = options.now ?? Date.now()
    const local = await collectLocalEstimates(options.database, options.storageMode)
    await insertLocalEstimateSnapshots(
      options.database,
      options.storageMode,
      local,
      now,
      'refresh_failed',
    )
  }
}

type UsageResult =
  | {
      status: 'success'
      accountUsedBytes: number
      simlettraUsedBytes: number
      itemCount: number | null
      observedAt: number
      summary: null
    }
  | { status: 'permission_denied' | 'unavailable'; summary: string }

async function fetchD1Usage(options: {
  fetcher: typeof fetch
  accountId: string
  databaseId: string
  apiToken: string
}): Promise<UsageResult> {
  try {
    const headers = { Authorization: `Bearer ${options.apiToken}`, Accept: 'application/json' }
    const databaseResponse = await options.fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}`,
      { headers },
    )
    const listResult = await fetchAllD1Databases(options, headers)
    if (
      databaseResponse.status === 401 ||
      databaseResponse.status === 403 ||
      listResult.status === 'permission_denied'
    ) {
      return { status: 'permission_denied', summary: 'Cloudflare Token 缺少 D1 只读权限或已经失效' }
    }
    if (!databaseResponse.ok || listResult.status !== 'success') {
      return { status: 'unavailable', summary: 'Cloudflare D1 用量接口暂时不可用' }
    }
    const databasePayload = (await databaseResponse.json()) as CloudflareApiEnvelope<{
      file_size?: number
    }>
    const simlettraUsedBytes = nonnegativeInteger(databasePayload.result?.file_size)
    const accountUsedBytes = listResult.databases.reduce(
      (sum, database) => sum + (nonnegativeInteger(database.file_size) ?? 0),
      0,
    )
    if (
      !databasePayload.success ||
      simlettraUsedBytes === null ||
      accountUsedBytes < simlettraUsedBytes
    ) {
      return { status: 'unavailable', summary: 'Cloudflare D1 用量响应缺少必要字段' }
    }
    return {
      status: 'success',
      accountUsedBytes,
      simlettraUsedBytes,
      itemCount: listResult.databases.length,
      observedAt: Date.now(),
      summary: null,
    }
  } catch {
    return { status: 'unavailable', summary: '无法连接 Cloudflare D1 用量接口' }
  }
}

async function fetchAllD1Databases(
  options: Pick<Parameters<typeof fetchD1Usage>[0], 'fetcher' | 'accountId'>,
  headers: Record<string, string>,
): Promise<
  | { status: 'success'; databases: Array<{ uuid?: string; file_size?: number }> }
  | { status: 'permission_denied' | 'unavailable' }
> {
  const databases: Array<{ uuid?: string; file_size?: number }> = []
  for (let page = 1; page <= 100; page += 1) {
    const response = await options.fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database?per_page=100&page=${page}`,
      { headers },
    )
    if (response.status === 401 || response.status === 403) return { status: 'permission_denied' }
    if (!response.ok) return { status: 'unavailable' }
    const payload = (await response.json()) as CloudflareApiEnvelope<
      Array<{ uuid?: string; file_size?: number }>
    >
    if (!payload.success || !Array.isArray(payload.result)) return { status: 'unavailable' }
    databases.push(...payload.result)
    const totalPages = nonnegativeInteger(payload.result_info?.total_pages) ?? 1
    if (page >= totalPages) return { status: 'success', databases }
  }
  return { status: 'unavailable' }
}

async function fetchObjectStorageUsage(options: {
  fetcher: typeof fetch
  storageMode: StorageMode
  accountId: string
  resourceReference: string
  apiToken: string
}): Promise<UsageResult> {
  const dataset =
    options.storageMode === 'kv' ? 'kvStorageAdaptiveGroups' : 'r2StorageAdaptiveGroups'
  const keyField = options.storageMode === 'kv' ? 'namespaceId' : 'bucketName'
  const query = `query SimlettraStorageUsage($accountTag: string!) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      ${dataset}(limit: 10000) {
        max { ${options.storageMode === 'kv' ? 'byteCount keyCount' : 'payloadSize metadataSize objectCount'} }
        dimensions { ${keyField} }
      }
    } }
  }`
  try {
    const response = await options.fetcher('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { accountTag: options.accountId },
      }),
    })
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'permission_denied',
        summary: 'Cloudflare Token 缺少账号分析只读权限或已经失效',
      }
    }
    if (!response.ok) return { status: 'unavailable', summary: 'Cloudflare 对象存储指标暂时不可用' }
    const payload = (await response.json()) as {
      data?: { viewer?: { accounts?: Array<Record<string, unknown>> } }
      errors?: unknown[]
    }
    if (payload.errors?.length)
      return { status: 'unavailable', summary: 'Cloudflare 对象存储指标查询失败' }
    const account = payload.data?.viewer?.accounts?.[0]
    const groups = account?.[dataset]
    if (!Array.isArray(groups))
      return { status: 'unavailable', summary: 'Cloudflare 对象存储指标响应缺少必要字段' }
    let accountUsedBytes = 0
    let simlettraUsedBytes = 0
    let simlettraItemCount = 0
    for (const group of groups) {
      if (!isRecord(group) || !isRecord(group.max) || !isRecord(group.dimensions)) continue
      const resource = group.dimensions[keyField]
      const isSimlettraResource = resource === options.resourceReference
      let groupBytes = 0
      let groupItemCount = 0
      if (options.storageMode === 'kv') {
        groupBytes = nonnegativeInteger(group.max.byteCount) ?? 0
        groupItemCount = nonnegativeInteger(group.max.keyCount) ?? 0
      } else {
        groupBytes =
          (nonnegativeInteger(group.max.payloadSize) ?? 0) +
          (nonnegativeInteger(group.max.metadataSize) ?? 0)
        groupItemCount = nonnegativeInteger(group.max.objectCount) ?? 0
      }
      accountUsedBytes += groupBytes
      if (isSimlettraResource) {
        simlettraUsedBytes += groupBytes
        simlettraItemCount += groupItemCount
      }
    }
    return {
      status: 'success',
      accountUsedBytes,
      simlettraUsedBytes,
      itemCount: simlettraItemCount,
      observedAt: Date.now(),
      summary: null,
    }
  } catch {
    return { status: 'unavailable', summary: '无法连接 Cloudflare 对象存储指标接口' }
  }
}

async function collectLocalEstimates(database: D1Database, storageMode: StorageMode) {
  const d1Probe = await database.prepare(`SELECT COUNT(*) AS item_count FROM sqlite_master`).run()
  const objects = await database
    .prepare(
      `SELECT
         COALESCE((
           SELECT SUM(expected_size_bytes)
           FROM object_registry
           WHERE storage_mode = ?1 AND object_status <> 'deleted'
         ), 0) + COALESCE((
           SELECT SUM(size_bytes)
           FROM export_artifacts
           WHERE storage_mode = ?1 AND artifact_status <> 'deleted'
         ), 0) AS used_bytes,
         COALESCE((
           SELECT COUNT(*) FROM object_registry
           WHERE storage_mode = ?1 AND object_status <> 'deleted'
         ), 0) + COALESCE((
           SELECT COUNT(*) FROM export_artifacts
           WHERE storage_mode = ?1 AND artifact_status <> 'deleted'
         ), 0) AS item_count`,
    )
    .bind(storageMode)
    .first<{ used_bytes: number; item_count: number }>()
  return {
    d1: { usedBytes: Math.max(0, d1Probe.meta.size_after), itemCount: null as number | null },
    storage: {
      usedBytes: Math.max(0, objects?.used_bytes ?? 0),
      itemCount: Math.max(0, objects?.item_count ?? 0),
    },
  }
}

async function insertRefreshSnapshots(options: {
  database: D1Database
  storageMode: StorageMode
  configuration: ConfigurationRow
  local: Awaited<ReturnType<typeof collectLocalEstimates>>
  d1: UsageResult
  storage: UsageResult
  now: number
}) {
  const statements = [
    snapshotStatement(
      options.database,
      'd1',
      D1_ACCOUNT_FREE_LIMIT_BYTES,
      D1_DATABASE_FREE_LIMIT_BYTES,
      options.configuration.account_id,
      options.local.d1,
      options.d1,
      options.now,
    ),
    snapshotStatement(
      options.database,
      options.storageMode,
      freeLimit(options.storageMode),
      freeLimit(options.storageMode),
      options.configuration.account_id,
      options.local.storage,
      options.storage,
      options.now,
    ),
  ]
  await options.database.batch(statements)
}

function snapshotStatement(
  database: D1Database,
  resourceKind: PlatformResourceKind,
  accountLimit: number,
  currentResourceLimit: number,
  accountId: string,
  local: { usedBytes: number; itemCount: number | null },
  remote: UsageResult,
  now: number,
) {
  if (remote.status === 'success') {
    return insertSnapshotStatement(database, {
      resourceKind,
      scopeKind: 'account',
      scopeReference: accountId,
      freeLimitBytes: accountLimit,
      currentResourceLimitBytes: currentResourceLimit,
      accountUsedBytes: remote.accountUsedBytes,
      simlettraUsedBytes: remote.simlettraUsedBytes,
      remainingBytes: Math.max(0, accountLimit - remote.accountUsedBytes),
      currentResourceRemainingBytes: Math.max(0, currentResourceLimit - remote.simlettraUsedBytes),
      itemCount: remote.itemCount,
      dataSource: 'cloudflare_api',
      fetchStatus: 'success',
      observedAt: remote.observedAt,
      fetchedAt: now,
      errorCode: null,
    })
  }
  return insertSnapshotStatement(database, {
    resourceKind,
    scopeKind: 'local_only',
    scopeReference: 'simlettra',
    freeLimitBytes: currentResourceLimit,
    currentResourceLimitBytes: currentResourceLimit,
    accountUsedBytes: local.usedBytes,
    simlettraUsedBytes: local.usedBytes,
    remainingBytes: Math.max(0, currentResourceLimit - local.usedBytes),
    currentResourceRemainingBytes: Math.max(0, currentResourceLimit - local.usedBytes),
    itemCount: local.itemCount,
    dataSource: 'local_estimate',
    fetchStatus: 'stale',
    observedAt: now,
    fetchedAt: now,
    errorCode: remote.status,
  })
}

async function insertLocalEstimateSnapshots(
  database: D1Database,
  storageMode: StorageMode,
  local: Awaited<ReturnType<typeof collectLocalEstimates>>,
  now: number,
  errorCode: string,
) {
  await database.batch([
    insertSnapshotStatement(
      database,
      localSnapshot('d1', D1_DATABASE_FREE_LIMIT_BYTES, local.d1, now, errorCode),
    ),
    insertSnapshotStatement(
      database,
      localSnapshot(storageMode, freeLimit(storageMode), local.storage, now, errorCode),
    ),
  ])
}

function localSnapshot(
  resourceKind: PlatformResourceKind,
  limit: number,
  local: { usedBytes: number; itemCount: number | null },
  now: number,
  errorCode: string,
) {
  return {
    resourceKind,
    scopeKind: 'local_only' as const,
    scopeReference: 'simlettra',
    freeLimitBytes: limit,
    currentResourceLimitBytes: limit,
    accountUsedBytes: local.usedBytes,
    simlettraUsedBytes: local.usedBytes,
    remainingBytes: Math.max(0, limit - local.usedBytes),
    currentResourceRemainingBytes: Math.max(0, limit - local.usedBytes),
    itemCount: local.itemCount,
    dataSource: 'local_estimate' as const,
    fetchStatus: 'stale' as const,
    observedAt: now,
    fetchedAt: now,
    errorCode,
  }
}

function insertSnapshotStatement(database: D1Database, snapshot: SnapshotInsert) {
  return database
    .prepare(
      `INSERT INTO platform_resource_snapshots (
         id, resource_kind, scope_kind, scope_reference, free_limit_bytes,
         current_resource_limit_bytes, account_used_bytes, simlettra_used_bytes,
         remaining_bytes, current_resource_remaining_bytes, item_count,
         data_source, fetch_status, observed_at, fetched_at, error_code, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?15)`,
    )
    .bind(
      crypto.randomUUID(),
      snapshot.resourceKind,
      snapshot.scopeKind,
      snapshot.scopeReference,
      snapshot.freeLimitBytes,
      snapshot.currentResourceLimitBytes,
      snapshot.accountUsedBytes,
      snapshot.simlettraUsedBytes,
      snapshot.remainingBytes,
      snapshot.currentResourceRemainingBytes,
      snapshot.itemCount,
      snapshot.dataSource,
      snapshot.fetchStatus,
      snapshot.observedAt,
      snapshot.fetchedAt,
      snapshot.errorCode,
    )
}

async function ensureReadableSnapshots(
  database: D1Database,
  storageMode: StorageMode,
  now: number,
) {
  let snapshots = await loadLatestSnapshots(database, storageMode)
  if (snapshots.length < 2) {
    const local = await collectLocalEstimates(database, storageMode)
    await insertLocalEstimateSnapshots(database, storageMode, local, now, 'configuration_missing')
    snapshots = await loadLatestSnapshots(database, storageMode)
  }
  return snapshots
}

async function loadLatestSnapshots(
  database: D1Database,
  storageMode: StorageMode,
): Promise<SnapshotRow[]> {
  const rows = await database
    .prepare(
      `SELECT snapshot.*
       FROM platform_resource_snapshots snapshot
       WHERE snapshot.resource_kind IN ('d1', ?1)
         AND snapshot.id = (
           SELECT latest.id FROM platform_resource_snapshots latest
           WHERE latest.resource_kind = snapshot.resource_kind
           ORDER BY latest.fetched_at DESC, latest.id DESC LIMIT 1
         )
       ORDER BY CASE snapshot.resource_kind WHEN 'd1' THEN 0 ELSE 1 END`,
    )
    .bind(storageMode)
    .all<SnapshotRow>()
  return rows.results
}

async function loadThresholds(database: D1Database): Promise<ThresholdRow[]> {
  return (
    await database
      .prepare(
        `SELECT id, resource_kind, warning_ratio_bps, stop_ratio_bps
         FROM platform_resource_thresholds WHERE threshold_status = 'active'`,
      )
      .all<ThresholdRow>()
  ).results
}

function buildResourceSummaries(
  storageMode: StorageMode,
  thresholds: ThresholdRow[],
  snapshots: SnapshotRow[],
  now: number,
): PlatformResourceSummary[] {
  return (['d1', storageMode] as PlatformResourceKind[]).map((kind) => {
    const threshold = thresholds.find((item) => item.resource_kind === kind)
    const snapshot = snapshots.find((item) => item.resource_kind === kind)
    if (!threshold || !snapshot) throw new Error(`资源 ${kind} 缺少当前阈值或快照`)
    const stale = now - snapshot.fetched_at > SNAPSHOT_STALE_MS
    const fetchStatus =
      stale && snapshot.fetch_status === 'success' ? 'stale' : snapshot.fetch_status
    const effectiveStopBps =
      snapshot.data_source === 'local_estimate'
        ? Math.min(threshold.stop_ratio_bps, LOCAL_ESTIMATE_MAX_STOP_BPS)
        : threshold.stop_ratio_bps
    const accountUsed = snapshot.account_used_bytes ?? 0
    const currentResourceUsed = snapshot.simlettra_used_bytes ?? 0
    return {
      resourceKind: kind,
      freeLimitBytes: snapshot.free_limit_bytes,
      currentResourceLimitBytes: snapshot.current_resource_limit_bytes,
      accountUsedBytes: snapshot.account_used_bytes,
      simlettraUsedBytes: snapshot.simlettra_used_bytes,
      remainingBytes: snapshot.remaining_bytes,
      currentResourceRemainingBytes: snapshot.current_resource_remaining_bytes,
      itemCount: snapshot.item_count,
      dataSource: snapshot.data_source,
      fetchStatus,
      scopeKind: snapshot.scope_kind,
      scopeReference: snapshot.scope_reference,
      observedAt: snapshot.observed_at,
      fetchedAt: snapshot.fetched_at,
      errorCode: snapshot.error_code,
      warningPercent: threshold.warning_ratio_bps / 100,
      stopPercent: threshold.stop_ratio_bps / 100,
      effectiveStopPercent: effectiveStopBps / 100,
      warningReached:
        accountUsed * 10000 >= snapshot.free_limit_bytes * threshold.warning_ratio_bps ||
        currentResourceUsed * 10000 >=
          snapshot.current_resource_limit_bytes * threshold.warning_ratio_bps,
      stopped:
        accountUsed * 10000 >= snapshot.free_limit_bytes * effectiveStopBps ||
        currentResourceUsed * 10000 >= snapshot.current_resource_limit_bytes * effectiveStopBps,
    }
  })
}

async function reconcileIncludedReservations(database: D1Database, now: number) {
  await database
    .prepare(
      `UPDATE platform_capacity_reservations
       SET reservation_status = 'reconciled', reconciled_at = ?1, updated_at = ?1
       WHERE reservation_status = 'committed_pending_snapshot' AND committed_at < ?1`,
    )
    .bind(now)
    .run()
}

async function loadConfiguration(database: D1Database): Promise<ConfigurationRow | null> {
  return database
    .prepare(
      `SELECT account_id, d1_database_id, storage_resource_reference,
              api_token_ciphertext, api_token_nonce, configuration_version,
              configuration_status, last_tested_at, last_test_result, last_test_summary
       FROM cloudflare_resource_configurations WHERE singleton_id = 1 LIMIT 1`,
    )
    .first<ConfigurationRow>()
}

function configurationSummary(
  row: ConfigurationRow | null,
  token: string,
): PlatformResourceConfigurationSummary {
  if (!row || row.configuration_status !== 'active') {
    return {
      configured: false,
      accountId: '',
      d1DatabaseId: '',
      storageResourceReference: '',
      apiToken: '',
      configurationVersion: null,
      lastTestedAt: row?.last_tested_at ?? null,
      lastTestResult: row?.last_test_result as 'success' | 'failed' | null,
      lastTestSummary: row?.last_test_summary ?? null,
    }
  }
  return {
    configured: true,
    accountId: row.account_id,
    d1DatabaseId: row.d1_database_id,
    storageResourceReference: row.storage_resource_reference,
    apiToken: token,
    configurationVersion: row.configuration_version,
    lastTestedAt: row.last_tested_at,
    lastTestResult: row.last_test_result as 'success' | 'failed' | null,
    lastTestSummary: row.last_test_summary,
  }
}

function normalizeConfiguration(input: SavePlatformResourceConfigurationRequest) {
  const accountId = input.accountId?.trim()
  const d1DatabaseId = input.d1DatabaseId?.trim()
  const storageResourceReference = input.storageResourceReference?.trim()
  const apiToken = input.apiToken?.trim()
  if (!accountId || accountId.length < 16 || accountId.length > 64) {
    throw new PlatformResourceInputError('accountId', '请填写有效的 Cloudflare 账号编号')
  }
  if (!d1DatabaseId || d1DatabaseId.length < 16 || d1DatabaseId.length > 64) {
    throw new PlatformResourceInputError('d1DatabaseId', '请填写有效的 D1 数据库编号')
  }
  if (!storageResourceReference || storageResourceReference.length > 256) {
    throw new PlatformResourceInputError(
      'storageResourceReference',
      '请填写当前 KV 命名空间编号或 R2 存储桶名称',
    )
  }
  if (!apiToken || apiToken.length < 20 || apiToken.length > 4096) {
    throw new PlatformResourceInputError('apiToken', '请填写有效的 Cloudflare 只读 API Token')
  }
  return { accountId, d1DatabaseId, storageResourceReference, apiToken }
}

function normalizeThreshold(input: SavePlatformResourceThresholdRequest) {
  if (
    !Number.isInteger(input.warningPercent) ||
    input.warningPercent < 1 ||
    input.warningPercent > 100
  ) {
    throw new PlatformResourceInputError('warningPercent', '预警比例必须是 1 至 100 的整数')
  }
  if (!Number.isInteger(input.stopPercent) || input.stopPercent < 1 || input.stopPercent > 100) {
    throw new PlatformResourceInputError('stopPercent', '停止比例必须是 1 至 100 的整数')
  }
  if (input.warningPercent > input.stopPercent) {
    throw new PlatformResourceInputError('warningPercent', '预警比例不能高于停止比例')
  }
  return input
}

function normalizeResourceKind(value: string): PlatformResourceKind {
  if (value === 'd1' || value === 'kv' || value === 'r2') return value
  throw new PlatformResourceInputError('resourceKind', '资源类型无效')
}

async function requireAdministrator(database: D1Database, actorUserId: string) {
  const allowed = await database
    .prepare(
      `SELECT 1 AS allowed FROM system_instances WHERE singleton_id = 1 AND current_admin_user_id = ?1`,
    )
    .bind(actorUserId)
    .first<{ allowed: number }>()
  if (!allowed)
    throw new PlatformResourcePermissionError('只有系统管理员可以管理 Cloudflare 免费资源')
}

function freeLimit(kind: StorageMode): number {
  return kind === 'kv' ? KV_FREE_LIMIT_BYTES : R2_FREE_LIMIT_BYTES
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
