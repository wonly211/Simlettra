export interface AddressPolicySummary {
  minimumLocalPartLength: number
  aliasRetentionDays: number
  blockedSubstrings: string[]
  reservedNames: string[]
  policyVersion: number
  updatedAt: string
}

export interface AddressPolicyResponse {
  data: { policy: AddressPolicySummary }
}

export interface UpdateAddressPolicyRequest {
  minimumLocalPartLength: number
  aliasRetentionDays: number
  blockedSubstrings: string[]
  reservedNames: string[]
  expectedVersion: number
}

export type UpdateAddressPolicyResponse = AddressPolicyResponse
