import {
  type AdministratorPasswordResetResponse,
  type AdministratorRecoveryAuthorizationResponse,
  type AdministratorRecoveryResponse,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type AuthenticationResponse,
  type LoginRequest,
  type LogoutResponse,
  type RevokeSessionResponse,
  type SessionListResponse,
} from '../../shared/contracts/authentication'
import { INITIALIZATION_KEY_HEADER } from '../../shared/contracts/initialization'
import { encodeInitializationKeyHeader } from '../../shared/contracts/initialization-key-header'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export async function login(input: LoginRequest): Promise<AuthenticationResponse> {
  const payload = await requestJson('/api/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  if (!isAuthenticationResponse(payload)) throw new Error('登录响应格式无效')
  return payload
}

export async function fetchCurrentSession(): Promise<AuthenticationResponse> {
  const payload = await requestJson('/api/auth/session', {
    headers: { Accept: 'application/json' },
  })

  if (!isAuthenticationResponse(payload)) throw new Error('当前会话响应格式无效')
  return payload
}

export async function fetchSessions(): Promise<SessionListResponse> {
  const payload = await requestJson('/api/auth/sessions', {
    headers: { Accept: 'application/json' },
  })

  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.sessions)) {
    throw new Error('会话列表响应格式无效')
  }
  return payload as unknown as SessionListResponse
}

export async function logout(): Promise<LogoutResponse> {
  const payload = await requestJson('/api/auth/logout', {
    method: 'POST',
    headers: authenticatedMutationHeaders(),
  })

  if (!isRecord(payload) || !isRecord(payload.data) || payload.data.authenticated !== false) {
    throw new Error('退出响应格式无效')
  }
  return payload as unknown as LogoutResponse
}

export async function revokeSession(sessionId: string): Promise<RevokeSessionResponse> {
  const payload = await requestJson(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: authenticatedMutationHeaders(),
  })

  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    typeof payload.data.revokedSessionId !== 'string' ||
    typeof payload.data.currentSessionRevoked !== 'boolean'
  ) {
    throw new Error('退出会话响应格式无效')
  }
  return payload as unknown as RevokeSessionResponse
}

export async function changePassword(
  input: ChangePasswordRequest & { currentPassword: string },
): Promise<ChangePasswordResponse> {
  return requestPasswordChange('/api/auth/password/change', input)
}

export async function completeRequiredPasswordChange(
  newPassword: string,
): Promise<ChangePasswordResponse> {
  return requestPasswordChange('/api/auth/password/complete-required-change', { newPassword })
}

export async function resetUserPassword(
  primaryAddress: string,
): Promise<AdministratorPasswordResetResponse> {
  const payload = await requestJson('/api/auth/administrator/users/password-reset', {
    method: 'POST',
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify({ primaryAddress }),
  })

  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    !isRecord(payload.data.user) ||
    typeof payload.data.user.displayName !== 'string' ||
    typeof payload.data.user.primaryAddress !== 'string' ||
    typeof payload.data.temporaryPassword !== 'string' ||
    typeof payload.data.expiresAt !== 'string'
  ) {
    throw new Error('临时密码响应格式无效')
  }
  return payload as unknown as AdministratorPasswordResetResponse
}

export async function authorizeAdministratorRecovery(
  initKey: string,
): Promise<AdministratorRecoveryAuthorizationResponse> {
  const payload = await requestJson('/api/auth/administrator-recovery/authorize', {
    method: 'POST',
    headers: recoveryHeaders(initKey),
  })

  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    payload.data.authorized !== true ||
    !isRecord(payload.data.administrator) ||
    typeof payload.data.administrator.primaryAddress !== 'string'
  ) {
    throw new Error('管理员恢复鉴权响应格式无效')
  }
  return payload as unknown as AdministratorRecoveryAuthorizationResponse
}

export async function completeAdministratorRecovery(
  initKey: string,
  newPassword: string,
): Promise<AdministratorRecoveryResponse> {
  const payload = await requestJson('/api/auth/administrator-recovery/complete', {
    method: 'POST',
    headers: {
      ...recoveryHeaders(initKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ newPassword }),
  })

  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    payload.data.recovered !== true ||
    !isRecord(payload.data.administrator) ||
    typeof payload.data.administrator.primaryAddress !== 'string'
  ) {
    throw new Error('管理员恢复响应格式无效')
  }
  return payload as unknown as AdministratorRecoveryResponse
}

async function requestPasswordChange(url: string, input: object): Promise<ChangePasswordResponse> {
  const payload = await requestJson(url, {
    method: 'POST',
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(input),
  })

  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    payload.data.passwordChanged !== true ||
    typeof payload.data.revokedOtherSessions !== 'number' ||
    !isAuthenticatedUser(payload.data.user)
  ) {
    throw new Error('修改密码响应格式无效')
  }
  return payload as unknown as ChangePasswordResponse
}

function recoveryHeaders(initKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    [INITIALIZATION_KEY_HEADER]: encodeInitializationKeyHeader(initKey),
  }
}

function isAuthenticationResponse(value: unknown): value is AuthenticationResponse {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    value.data.authenticated === true &&
    isAuthenticatedUser(value.data.user) &&
    isRecord(value.data.session) &&
    typeof value.data.session.id === 'string'
  )
}

function isAuthenticatedUser(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.primaryAddress === 'string' &&
    (value.role === 'administrator' || value.role === 'user') &&
    typeof value.passwordChangeRequired === 'boolean' &&
    (value.temporaryPasswordExpiresAt === null ||
      typeof value.temporaryPasswordExpiresAt === 'string')
  )
}
