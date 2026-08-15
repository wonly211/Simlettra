export const SESSION_COOKIE_NAME = '__Host-simlettra_session'
export const CSRF_COOKIE_NAME = '__Host-simlettra_csrf'
export const CSRF_HEADER_NAME = 'X-Simlettra-CSRF'

export interface LoginRequest {
  email: string
  password: string
}

export interface AuthenticatedUser {
  id: string
  displayName: string
  primaryAddress: string
  timezone: string | null
  role: 'administrator' | 'user'
  passwordChangeRequired: boolean
  temporaryPasswordExpiresAt: string | null
}

export interface SessionSummary {
  id: string
  clientLabel: string
  createdAt: string
  lastActivityAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  current: boolean
}

export interface AuthenticationResponse {
  data: {
    authenticated: true
    user: AuthenticatedUser
    session: SessionSummary
  }
}

export interface SessionListResponse {
  data: {
    sessions: SessionSummary[]
  }
}

export interface LogoutResponse {
  data: {
    authenticated: false
  }
}

export interface RevokeSessionResponse {
  data: {
    revokedSessionId: string
    currentSessionRevoked: boolean
  }
}

export interface ChangePasswordRequest {
  currentPassword?: string
  newPassword: string
  revokeOtherSessions: boolean
}

export interface ChangePasswordResponse {
  data: {
    passwordChanged: true
    revokedOtherSessions: number
    user: AuthenticatedUser
  }
}

export interface AdministratorPasswordResetRequest {
  primaryAddress: string
}

export interface AdministratorPasswordResetResponse {
  data: {
    user: {
      displayName: string
      primaryAddress: string
    }
    temporaryPassword: string
    expiresAt: string
  }
}

export interface AdministratorRecoveryAuthorizationResponse {
  data: {
    authorized: true
    administrator: {
      displayName: string
      primaryAddress: string
    }
  }
}

export interface AdministratorRecoveryRequest {
  newPassword: string
}

export interface AdministratorRecoveryResponse {
  data: {
    recovered: true
    administrator: {
      displayName: string
      primaryAddress: string
    }
  }
}
