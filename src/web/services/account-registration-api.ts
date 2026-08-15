import type {
  AccountRegistrationInvitationOverviewResponse,
  CreateAccountRegistrationInvitationRequest,
  CreateAccountRegistrationInvitationResponse,
  RegisterAccountWithInvitationRequest,
  RegisterAccountWithInvitationResponse,
  RevokeAccountRegistrationInvitationResponse,
  VerifyAccountRegistrationInvitationResponse,
} from '../../shared/contracts/account-registration'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export async function fetchAccountRegistrationInvitations(): Promise<AccountRegistrationInvitationOverviewResponse> {
  const payload = await requestJson('/api/auth/administrator/account-registration-invitations', {
    headers: { Accept: 'application/json' },
  })
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    !Array.isArray(payload.data.invitations) ||
    !Array.isArray(payload.data.domains)
  ) {
    throw new Error('账号邀请码列表响应格式无效')
  }
  return payload as unknown as AccountRegistrationInvitationOverviewResponse
}

export async function createAccountRegistrationInvitation(
  input: CreateAccountRegistrationInvitationRequest,
): Promise<CreateAccountRegistrationInvitationResponse> {
  const payload = await requestJson('/api/auth/administrator/account-registration-invitations', {
    method: 'POST',
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(input),
  })
  if (!hasInvitation(payload)) throw new Error('创建账号邀请码响应格式无效')
  return payload as unknown as CreateAccountRegistrationInvitationResponse
}

export async function revokeAccountRegistrationInvitation(
  invitationId: string,
): Promise<RevokeAccountRegistrationInvitationResponse> {
  const payload = await requestJson(
    `/api/auth/administrator/account-registration-invitations/${encodeURIComponent(invitationId)}/revoke`,
    { method: 'POST', headers: authenticatedMutationHeaders() },
  )
  if (!hasInvitation(payload)) throw new Error('撤销账号邀请码响应格式无效')
  return payload as unknown as RevokeAccountRegistrationInvitationResponse
}

export async function verifyAccountRegistrationInvitation(
  code: string,
): Promise<VerifyAccountRegistrationInvitationResponse> {
  const payload = await requestJson('/api/auth/account-registration/invitation/verify', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    payload.data.valid !== true ||
    typeof payload.data.domainName !== 'string'
  ) {
    throw new Error('验证账号邀请码响应格式无效')
  }
  return payload as unknown as VerifyAccountRegistrationInvitationResponse
}

export async function registerAccountWithInvitation(
  input: RegisterAccountWithInvitationRequest,
): Promise<RegisterAccountWithInvitationResponse> {
  const payload = await requestJson('/api/auth/account-registration/register', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    payload.data.authenticated !== true ||
    !isRecord(payload.data.user) ||
    typeof payload.data.user.primaryAddress !== 'string' ||
    !isRecord(payload.data.session) ||
    typeof payload.data.session.id !== 'string'
  ) {
    throw new Error('邀请码注册响应格式无效')
  }
  return payload as unknown as RegisterAccountWithInvitationResponse
}

function hasInvitation(value: unknown): value is { data: { invitation: unknown } } {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    isRecord(value.data.invitation) &&
    typeof value.data.invitation.id === 'string' &&
    typeof value.data.invitation.code === 'string' &&
    (value.data.invitation.status === 'available' ||
      value.data.invitation.status === 'used' ||
      value.data.invitation.status === 'revoked')
  )
}
