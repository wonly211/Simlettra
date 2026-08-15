export type ManagedUserStatus = 'active' | 'disabled'

export interface ManagedUserSummary {
  id: string
  displayName: string
  primaryAddress: string
  timezone: string | null
  status: ManagedUserStatus
  role: 'administrator' | 'user'
  createdAt: string
}

export interface AvailableMailDomain {
  id: string
  displayName: string
  canonicalName: string
}

export interface UserManagementOverviewResponse {
  data: {
    users: ManagedUserSummary[]
    domains: AvailableMailDomain[]
  }
}

export interface CreateManagedUserRequest {
  displayName: string
  localPart: string
  domainId: string
  timezone: string
}

export interface CreateManagedUserResponse {
  data: {
    user: ManagedUserSummary
    temporaryPassword: string
    expiresAt: string
  }
}

export interface ChangeManagedUserStatusResponse {
  data: {
    user: ManagedUserSummary
    changed: boolean
    revokedSessions: number
  }
}
