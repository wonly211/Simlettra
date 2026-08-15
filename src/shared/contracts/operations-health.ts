export type OperationsHealthStatus = 'healthy' | 'attention' | 'unknown' | 'not_configured'
export type OverallOperationsHealthStatus = 'healthy' | 'attention' | 'unknown'

export interface InboundOperationsHealth {
  status: OperationsHealthStatus
  summary: string
  lastAcceptedAt: number | null
  lastVisibleAt: number | null
  stalledCount: number
  attentionCount: number
  latestErrorCode: string | null
}

export interface OutboundOperationsHealth {
  status: OperationsHealthStatus
  summary: string
  activeProviderCount: number
  activeRouteCount: number
  domainsWithoutRouteCount: number
  lastActivityAt: number | null
  stalledRecipientCount: number
  unknownRecipientCount: number
  recentProviderRejectionCount: number
  latestErrorCode: string | null
}

export interface StorageOperationsHealth {
  status: OperationsHealthStatus
  summary: string
  latestSnapshotAt: number | null
  warningResourceCount: number
  stoppedResourceCount: number
  unavailableResourceCount: number
  missingResourceCount: number
  latestErrorCode: string | null
}

export interface ScheduledOperationsHealth {
  status: OperationsHealthStatus
  summary: string
  lastStartedAt: number | null
  lastSucceededAt: number | null
  lastFailedAt: number | null
  needsAttentionTaskCount: number
  overdueTaskCount: number
  latestErrorCode: string | null
}

export interface OperationsHealthOverviewResponse {
  data: {
    overallStatus: OverallOperationsHealthStatus
    checkedAt: number
    inbound: InboundOperationsHealth
    outbound: OutboundOperationsHealth
    storage: StorageOperationsHealth
    scheduled: ScheduledOperationsHealth
  }
}
