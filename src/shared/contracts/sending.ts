export type SendDeliveryStatus =
  | 'waiting'
  | 'submitting'
  | 'submitted'
  | 'delayed'
  | 'delivered'
  | 'bounced'
  | 'failed'
  | 'unknown'

export interface SendDraftRequest {
  requestKey: string
  expectedRevisionNumber: number
}

export interface SendRecipientResult {
  id: string
  role: 'to' | 'cc' | 'bcc'
  address: string
  channel: 'internal' | 'external'
  status: SendDeliveryStatus
  failureCode: string | null
}

export interface SendOperationResult {
  id: string
  messageId: string
  sentMailboxEntryId: string
  workflowStatus: 'accepted' | 'processing' | 'finished'
  acceptedAt: number
  subject: string
  senderAddress: string
  payloadSizeBytes: number
  recipients: SendRecipientResult[]
}

export interface SendDraftResponse {
  data: {
    replayed: boolean
    send: SendOperationResult
  }
}

export interface SendOperationResponse {
  data: { send: SendOperationResult }
}

export type OutboundProviderType = 'resend' | 'smtp2go'

export interface OutboundProviderSummary {
  id: string
  configurationKey: string
  configurationVersion: number
  displayName: string
  providerType: OutboundProviderType
  status: 'active' | 'disabled' | 'retired'
  credential: string
  callbackUsername: string | null
  callbackSecret: string
  lastTestedAt: number | null
  lastTestResult: 'success' | 'failed' | null
  lastTestSummary: string | null
}

export interface OutboundRouteSummary {
  id: string
  domainId: string
  domainName: string
  routeVersion: number
  status: 'active' | 'disabled'
  providerConfigIds: string[]
}

export interface OutboundManagementOverviewResponse {
  data: {
    encryptionConfigured: boolean
    providers: OutboundProviderSummary[]
    routes: OutboundRouteSummary[]
    dailyDefaultRecipientLimit: number
    domainMonthlyDefaultLimit: number | null
    userDailyQuotas: OutboundUserDailyQuotaSummary[]
    domainMonthlyQuotas: OutboundDomainMonthlyQuotaSummary[]
  }
}

export interface SaveOutboundProviderRequest {
  id?: string
  displayName: string
  providerType: OutboundProviderType
  credential: string
  callbackUsername?: string | null
  callbackSecret: string
}

export interface SaveOutboundProviderResponse {
  data: { provider: OutboundProviderSummary }
}

export interface SaveDomainOutboundRouteRequest {
  providerConfigIds: string[]
}

export interface SaveDomainOutboundRouteResponse {
  data: { route: OutboundRouteSummary }
}

export interface OutboundUserDailyQuotaSummary {
  userId: string
  displayName: string
  primaryAddress: string
  limit: number
  usesDefault: boolean
  usedInPast24Hours: number
}

export interface OutboundDomainMonthlyQuotaSummary {
  domainId: string
  domainName: string
  limit: number | null
  usesDefault: boolean
  committed: number
  reserved: number
  unknownHeld: number
}

export interface SaveOutboundQuotaRequest {
  limit: number | null
  useDefault?: boolean
}

export interface SaveOutboundQuotaResponse {
  data: { saved: true }
}
