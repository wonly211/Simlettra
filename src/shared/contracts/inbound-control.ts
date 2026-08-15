export type InboundControlScopeType = 'domain' | 'address' | 'user'
export type InboundReceiveStatus = 'accepting' | 'paused'
export type InboundRejectionRuleType =
  'sender_address' | 'sender_domain' | 'subject_keyword' | 'body_keyword'
export type InboundRejectionRuleStatus = 'active' | 'paused'

export interface InboundDomainSummary {
  id: string
  canonicalName: string
  displayName: string
  domainStatus: 'active' | 'paused'
  catchAllMode: 'reject' | 'unallocated'
  receiveStatus: InboundReceiveStatus
  unallocatedAccessUserIds: string[]
  unallocatedMessageCount: number
}

export interface InboundAddressSummary {
  id: string
  canonicalAddress: string
  ownerType: 'user' | 'organization'
  ownerName: string
  receiveStatus: InboundReceiveStatus
}

export interface InboundUserSummary {
  id: string
  displayName: string
  primaryAddress: string
  userStatus: string
  receiveStatus: InboundReceiveStatus
}

export interface InboundRejectionRule {
  id: string
  ruleType: InboundRejectionRuleType
  matchValue: string
  status: InboundRejectionRuleStatus
  createdAt: string
  updatedAt: string
}

export interface InboundControlOverviewResponse {
  data: {
    domains: InboundDomainSummary[]
    addresses: InboundAddressSummary[]
    users: InboundUserSummary[]
    rules: InboundRejectionRule[]
  }
}

export interface ChangeInboundReceiveStatusRequest {
  status: InboundReceiveStatus
}

export interface ChangeInboundReceiveStatusResponse {
  data: {
    scopeType: InboundControlScopeType
    scopeId: string
    status: InboundReceiveStatus
    changed: boolean
  }
}

export interface CreateInboundRejectionRuleRequest {
  ruleType: InboundRejectionRuleType
  matchValue: string
}

export interface CreateInboundRejectionRuleResponse {
  data: { rule: InboundRejectionRule }
}

export interface ChangeInboundRejectionRuleStatusRequest {
  status: InboundRejectionRuleStatus
}

export interface ChangeInboundRejectionRuleStatusResponse {
  data: { rule: InboundRejectionRule; changed: boolean }
}

export interface DeleteInboundRejectionRuleResponse {
  data: { deletedRuleId: string }
}

export interface ChangeDomainCatchAllModeRequest {
  mode: 'reject' | 'unallocated'
}

export interface ChangeDomainCatchAllModeResponse {
  data: {
    domainId: string
    mode: 'reject' | 'unallocated'
    changed: boolean
  }
}

export interface ChangeUnallocatedAccessGrantRequest {
  enabled: boolean
}

export interface ChangeUnallocatedAccessGrantResponse {
  data: {
    domainId: string
    userId: string
    enabled: boolean
    changed: boolean
  }
}
