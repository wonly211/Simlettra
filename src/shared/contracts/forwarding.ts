export type ExternalEmailTargetStatus = 'pending' | 'verified' | 'expired' | 'disabled' | 'deleted'

export type ForwardingRuleScope = 'all_personal' | 'selected_personal_addresses'
export type ForwardingRuleStatus = 'active' | 'paused'
export type ForwardingResultStatus =
  'pending' | 'submitting' | 'submitted' | 'failed' | 'unknown' | 'cancelled' | 'rejected_loop'

export interface ExternalEmailTargetSummary {
  id: string
  emailAddress: string
  status: ExternalEmailTargetStatus
  verifiedAt: number | null
  latestVerificationStatus: string | null
  verificationExpiresAt: number | null
  createdAt: number
}

export interface ForwardingPersonalAddressSummary {
  id: string
  address: string
  role: 'primary' | 'alias'
}

export interface ForwardingRuleSummary {
  id: string
  ruleKey: string
  version: number
  targetId: string
  targetAddress: string
  scope: ForwardingRuleScope
  addressIds: string[]
  status: ForwardingRuleStatus
  updatedAt: number
}

export interface ForwardingResultSummary {
  id: string
  sourceMessageId: string
  subject: string
  actualAddress: string
  targetAddress: string
  status: ForwardingResultStatus
  errorCode: string | null
  errorSummary: string | null
  createdAt: number
  completedAt: number | null
}

export interface ForwardingOverviewResponse {
  data: {
    targets: ExternalEmailTargetSummary[]
    addresses: ForwardingPersonalAddressSummary[]
    rules: ForwardingRuleSummary[]
    recentResults: ForwardingResultSummary[]
  }
}

export interface CreateExternalEmailTargetRequest {
  emailAddress: string
}

export interface CreateExternalEmailTargetResponse {
  data: {
    target: ExternalEmailTargetSummary
  }
}

export interface VerifyExternalEmailTargetRequest {
  code: string
}

export interface VerifyExternalEmailTargetResponse {
  data: {
    target: ExternalEmailTargetSummary
  }
}

export interface DeleteExternalEmailTargetResponse {
  data: {
    deletedTargetId: string
  }
}

export interface SaveForwardingRuleRequest {
  ruleId?: string
  targetId: string
  scope: ForwardingRuleScope
  addressIds: string[]
  enabled: boolean
}

export interface SaveForwardingRuleResponse {
  data: {
    rule: ForwardingRuleSummary
  }
}

export interface ChangeForwardingRuleStatusRequest {
  status: ForwardingRuleStatus
}

export interface ChangeForwardingRuleStatusResponse {
  data: {
    rule: ForwardingRuleSummary
  }
}

export interface DeleteForwardingRuleResponse {
  data: {
    deletedRuleId: string
  }
}
