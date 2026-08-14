import type { AuthenticationResponse } from './authentication'
import type { AvailableMailDomain } from './user-management'

export type AccountRegistrationInvitationStatus = 'available' | 'used' | 'revoked'

export interface AccountRegistrationInvitationSummary {
  id: string
  code: string
  status: AccountRegistrationInvitationStatus
  domainId: string | null
  domainName: string
  createdAt: string
  revokedAt: string | null
  usedAt: string | null
  usedBy: {
    displayName: string
    primaryAddress: string
  } | null
}

export interface AccountRegistrationInvitationOverviewResponse {
  data: {
    invitations: AccountRegistrationInvitationSummary[]
    domains: AvailableMailDomain[]
  }
}

export interface CreateAccountRegistrationInvitationRequest {
  domainId?: string
}

export interface CreateAccountRegistrationInvitationResponse {
  data: {
    invitation: AccountRegistrationInvitationSummary
  }
}

export interface RevokeAccountRegistrationInvitationResponse {
  data: {
    invitation: AccountRegistrationInvitationSummary
  }
}

export interface VerifyAccountRegistrationInvitationRequest {
  code: string
}

export interface VerifyAccountRegistrationInvitationResponse {
  data: {
    valid: true
    domainName: string
  }
}

export interface RegisterAccountWithInvitationRequest {
  code: string
  displayName: string
  localPart: string
  password: string
  timezone: string
}

export type RegisterAccountWithInvitationResponse = AuthenticationResponse
