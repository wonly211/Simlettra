export type PersonalAddressRole = 'primary' | 'alias'

export interface PersonalAddressSummary {
  id: string
  address: string
  domainId: string
  domainDisplayName: string
  role: PersonalAddressRole
  customLabel: string | null
  isPinned: boolean
  sortOrder: number
  isDefaultSender: boolean
  createdAt: string
}

export interface UserAliasPolicySummary {
  aliasLimit: number
  aliasUsed: number
  selfCreationEnabled: boolean
  overLimit: boolean
}

export interface PersonalAddressOverviewResponse {
  data: {
    policy: UserAliasPolicySummary
    aliasRetentionDays: number
    addresses: PersonalAddressSummary[]
    activeDomains: Array<{
      id: string
      displayName: string
      canonicalName: string
    }>
  }
}

export interface AdministratorAliasPolicyUser {
  id: string
  displayName: string
  primaryAddress: string
  status: 'active' | 'disabled'
  policy: UserAliasPolicySummary
  aliases: PersonalAddressSummary[]
}

export interface AdministratorAliasPolicyOverviewResponse {
  data: { users: AdministratorAliasPolicyUser[] }
}

export interface UpdateUserAliasPolicyRequest {
  aliasLimit: number
  selfCreationEnabled: boolean
}

export interface UpdateUserAliasPolicyResponse {
  data: { user: AdministratorAliasPolicyUser }
}

export interface CreatePersonalAliasRequest {
  localPart: string
  domainId: string
}

export interface CreatePersonalAliasResponse {
  data: { address: PersonalAddressSummary; policy: UserAliasPolicySummary }
}

export interface UpdatePersonalAddressPreferenceRequest {
  customLabel: string | null
  isPinned: boolean
}

export interface UpdatePersonalAddressPreferenceResponse {
  data: { address: PersonalAddressSummary }
}

export interface MovePersonalAddressRequest {
  direction: 'up' | 'down'
}

export interface MovePersonalAddressResponse {
  data: { addresses: PersonalAddressSummary[]; changed: boolean }
}

export interface SetDefaultSenderResponse {
  data: { addresses: PersonalAddressSummary[] }
}

export interface DeletePersonalAliasRequest {
  confirmed: boolean
}

export interface DeletePersonalAliasResponse {
  data: {
    deletedAddressId: string
    canonicalAddress: string
    releasedImmediately: boolean
    retentionDays: number
    releaseAt: string | null
    deletionOperationId: string
    defaultSenderAddressId: string
    policy: UserAliasPolicySummary
  }
}
