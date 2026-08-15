import type { StorageMode } from './storage-mode'

export type PlatformResourceKind = 'd1' | 'kv' | 'r2'
export type PlatformResourceDataSource = 'cloudflare_api' | 'local_estimate'
export type PlatformResourceFetchStatus = 'success' | 'stale' | 'unavailable' | 'permission_denied'

export interface PlatformResourceConfigurationSummary {
  configured: boolean
  accountId: string
  d1DatabaseId: string
  storageResourceReference: string
  apiToken: string
  configurationVersion: number | null
  lastTestedAt: number | null
  lastTestResult: 'success' | 'failed' | null
  lastTestSummary: string | null
}

export interface PlatformResourceSummary {
  resourceKind: PlatformResourceKind
  freeLimitBytes: number
  currentResourceLimitBytes: number
  accountUsedBytes: number | null
  simlettraUsedBytes: number | null
  remainingBytes: number | null
  currentResourceRemainingBytes: number | null
  itemCount: number | null
  dataSource: PlatformResourceDataSource
  fetchStatus: PlatformResourceFetchStatus
  scopeKind: 'account' | 'local_only'
  scopeReference: string
  observedAt: number | null
  fetchedAt: number
  errorCode: string | null
  warningPercent: number
  stopPercent: number
  effectiveStopPercent: number
  warningReached: boolean
  stopped: boolean
}

export interface PlatformResourceOverviewResponse {
  data: {
    storageMode: StorageMode
    configuration: PlatformResourceConfigurationSummary
    resources: PlatformResourceSummary[]
  }
}

export interface SavePlatformResourceConfigurationRequest {
  accountId: string
  d1DatabaseId: string
  storageResourceReference: string
  apiToken: string
}

export interface SavePlatformResourceConfigurationResponse {
  data: {
    configuration: PlatformResourceConfigurationSummary
  }
}

export interface DeletePlatformResourceConfigurationResponse {
  data: { deleted: true }
}

export interface RefreshPlatformResourcesResponse {
  data: { resources: PlatformResourceSummary[] }
}

export interface SavePlatformResourceThresholdRequest {
  warningPercent: number
  stopPercent: number
}

export interface SavePlatformResourceThresholdResponse {
  data: { resource: PlatformResourceSummary }
}
