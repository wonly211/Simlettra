export const RECOVERY_SESSION_COOKIE_NAME = '__Host-simlettra_recovery_session'
export const RECOVERY_CSRF_COOKIE_NAME = '__Host-simlettra_recovery_csrf'
export const RECOVERY_CSRF_HEADER_NAME = 'X-Simlettra-Recovery-CSRF'

export interface AccountDeletionBlocker {
  code: 'administrator_transfer_required' | 'owned_organization'
  reference: string
  label: string
  status: string
}

export interface AccountLifecycleOverviewResponse {
  data: {
    canRequestDeletion: boolean
    blockers: AccountDeletionBlocker[]
    recoveryDays: 7
  }
}

export interface TransferAdministratorRequest {
  successorUserId: string
}

export interface TransferAdministratorResponse {
  data: {
    transferred: true
    previousAdministratorUserId: string
    administratorUserId: string
  }
}

export interface RequestAccountDeletionRequest {
  currentPassword: string
  confirmation: 'DELETE_MY_ACCOUNT'
}

export interface RequestAccountDeletionResponse {
  data: {
    deletionRequested: true
    deletionDueAt: string
    revokedSessions: number
  }
}

export interface AccountRecoveryLoginRequest {
  email: string
  password: string
}

export interface AccountRecoverySessionSummary {
  userId: string
  displayName: string
  primaryAddress: string
  deletionDueAt: string
  sessionExpiresAt: string
}

export interface AccountRecoveryLoginResponse {
  data: {
    recoveryRequired: true
    session: AccountRecoverySessionSummary
  }
}

export interface AccountRecoverySessionResponse {
  data: {
    recoveryRequired: true
    session: AccountRecoverySessionSummary
  }
}

export interface CancelAccountDeletionResponse {
  data: {
    deletionCancelled: true
    restoredMemberships: number
  }
}
