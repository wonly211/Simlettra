import type {
  AccountLifecycleOverviewResponse,
  AccountRecoveryLoginRequest,
  AccountRecoveryLoginResponse,
  AccountRecoverySessionResponse,
  CancelAccountDeletionResponse,
  RequestAccountDeletionRequest,
  RequestAccountDeletionResponse,
  TransferAdministratorResponse,
} from '../../shared/contracts/user-lifecycle'
import {
  RECOVERY_CSRF_COOKIE_NAME,
  RECOVERY_CSRF_HEADER_NAME,
} from '../../shared/contracts/user-lifecycle'
import { authenticatedMutationHeaders, isRecord, readCookie, requestJson } from './api-client'

export async function fetchAccountLifecycle(): Promise<AccountLifecycleOverviewResponse> {
  const payload = await requestJson('/api/auth/account-lifecycle', {
    headers: { Accept: 'application/json' },
  })
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    typeof payload.data.canRequestDeletion !== 'boolean' ||
    !Array.isArray(payload.data.blockers)
  ) {
    throw new Error('账号生命周期响应格式无效')
  }
  return payload as unknown as AccountLifecycleOverviewResponse
}

export async function transferAdministrator(
  successorUserId: string,
): Promise<TransferAdministratorResponse> {
  const payload = await requestJson('/api/auth/administrator/transfer', {
    method: 'POST',
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify({ successorUserId }),
  })
  if (!isRecord(payload) || !isRecord(payload.data) || payload.data.transferred !== true) {
    throw new Error('管理员转让响应格式无效')
  }
  return payload as unknown as TransferAdministratorResponse
}

export async function requestAccountDeletion(
  input: RequestAccountDeletionRequest,
): Promise<RequestAccountDeletionResponse> {
  const payload = await requestJson('/api/auth/account-deletion', {
    method: 'POST',
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(input),
  })
  if (!isRecord(payload) || !isRecord(payload.data) || payload.data.deletionRequested !== true) {
    throw new Error('账号注销响应格式无效')
  }
  return payload as unknown as RequestAccountDeletionResponse
}

export async function loginAccountRecovery(
  input: AccountRecoveryLoginRequest,
): Promise<AccountRecoveryLoginResponse> {
  const payload = await requestJson('/api/auth/account-recovery/login', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!isRecoveryResponse(payload)) throw new Error('账号恢复登录响应格式无效')
  return payload as AccountRecoveryLoginResponse
}

export async function fetchAccountRecoverySession(): Promise<AccountRecoverySessionResponse> {
  const payload = await requestJson('/api/auth/account-recovery/session', {
    headers: { Accept: 'application/json' },
  })
  if (!isRecoveryResponse(payload)) throw new Error('账号恢复会话响应格式无效')
  return payload as AccountRecoverySessionResponse
}

export async function cancelAccountDeletion(): Promise<CancelAccountDeletionResponse> {
  const csrfToken = readCookie(RECOVERY_CSRF_COOKIE_NAME)
  if (!csrfToken) throw new Error('当前页面缺少账号恢复保护令牌，请重新验证密码')
  const payload = await requestJson('/api/auth/account-recovery/cancel', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      [RECOVERY_CSRF_HEADER_NAME]: csrfToken,
    },
  })
  if (!isRecord(payload) || !isRecord(payload.data) || payload.data.deletionCancelled !== true) {
    throw new Error('取消账号注销响应格式无效')
  }
  return payload as unknown as CancelAccountDeletionResponse
}

function isRecoveryResponse(
  payload: unknown,
): payload is AccountRecoveryLoginResponse | AccountRecoverySessionResponse {
  return (
    isRecord(payload) &&
    isRecord(payload.data) &&
    payload.data.recoveryRequired === true &&
    isRecord(payload.data.session) &&
    typeof payload.data.session.primaryAddress === 'string' &&
    typeof payload.data.session.deletionDueAt === 'string'
  )
}
