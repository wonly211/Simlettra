import type {
  AdministratorOrganizationPolicyOverviewResponse,
  CreateOrganizationInvitationRequest,
  CreateOrganizationInvitationResponse,
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  DeleteOrganizationResponse,
  LeaveOrganizationRequest,
  LeaveOrganizationResponse,
  OrganizationInvitationPolicy,
  OrganizationOverviewResponse,
  ResolveOrganizationInvitationResponse,
  RestoreOrganizationResponse,
  UpdateOrganizationInvitationPolicyResponse,
  UpdateOrganizationSendingPermissionResponse,
  UpdateUserOrganizationPolicyResponse,
} from '../../shared/contracts/organization-management'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export async function fetchOrganizationOverview(): Promise<OrganizationOverviewResponse> {
  return requestOrganizationPayload('/api/auth/organizations', undefined, '组织列表响应格式无效')
}

export async function createOrganization(
  input: CreateOrganizationRequest,
): Promise<CreateOrganizationResponse> {
  return requestOrganizationPayload(
    '/api/auth/organizations',
    jsonMutation('POST', input),
    '创建组织响应格式无效',
  )
}

export async function updateOrganizationInvitationPolicy(
  invitationPolicy: OrganizationInvitationPolicy,
): Promise<UpdateOrganizationInvitationPolicyResponse> {
  return requestOrganizationPayload(
    '/api/auth/organization-invitation-policy',
    jsonMutation('PATCH', { invitationPolicy }),
    '邀请策略响应格式无效',
  )
}

export async function inviteOrganizationMember(
  organizationId: string,
  input: CreateOrganizationInvitationRequest,
): Promise<CreateOrganizationInvitationResponse> {
  return requestOrganizationPayload(
    `/api/auth/organizations/${encodeURIComponent(organizationId)}/invitations`,
    jsonMutation('POST', input),
    '组织邀请响应格式无效',
  )
}

export async function resolveOrganizationInvitation(
  invitationId: string,
  decision: 'accept' | 'reject',
): Promise<ResolveOrganizationInvitationResponse> {
  return requestOrganizationPayload(
    `/api/auth/organization-invitations/${encodeURIComponent(invitationId)}/${decision}`,
    { method: 'POST', headers: authenticatedMutationHeaders() },
    '处理组织邀请响应格式无效',
  )
}

export async function revokeOrganizationInvitation(
  organizationId: string,
  invitationId: string,
): Promise<ResolveOrganizationInvitationResponse> {
  return requestOrganizationPayload(
    `/api/auth/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`,
    { method: 'DELETE', headers: authenticatedMutationHeaders() },
    '撤回组织邀请响应格式无效',
  )
}

export async function updateOrganizationSendingPermission(
  organizationId: string,
  membersCanSend: boolean,
): Promise<UpdateOrganizationSendingPermissionResponse> {
  return requestOrganizationPayload(
    `/api/auth/organizations/${encodeURIComponent(organizationId)}/sending-permission`,
    jsonMutation('PATCH', { membersCanSend }),
    '组织发件权限响应格式无效',
  )
}

export async function leaveOrganization(
  organizationId: string,
  input: LeaveOrganizationRequest,
): Promise<LeaveOrganizationResponse> {
  return requestOrganizationPayload(
    `/api/auth/organizations/${encodeURIComponent(organizationId)}/leave`,
    jsonMutation('POST', input),
    '退出组织响应格式无效',
  )
}

export async function deleteOrganization(
  organizationId: string,
): Promise<DeleteOrganizationResponse> {
  return requestOrganizationPayload(
    `/api/auth/organizations/${encodeURIComponent(organizationId)}`,
    jsonMutation('DELETE', { confirmed: true }),
    '删除组织响应格式无效',
  )
}

export async function restoreOrganization(
  organizationId: string,
): Promise<RestoreOrganizationResponse> {
  return requestOrganizationPayload(
    `/api/auth/organizations/${encodeURIComponent(organizationId)}/restore`,
    { method: 'POST', headers: authenticatedMutationHeaders() },
    '恢复组织响应格式无效',
  )
}

export async function fetchAdministratorOrganizationPolicies(): Promise<AdministratorOrganizationPolicyOverviewResponse> {
  return requestOrganizationPayload(
    '/api/auth/administrator/organization-policies',
    undefined,
    '组织额度列表响应格式无效',
  )
}

export async function updateAdministratorOrganizationPolicy(
  userId: string,
  organizationLimit: number,
): Promise<UpdateUserOrganizationPolicyResponse> {
  return requestOrganizationPayload(
    `/api/auth/administrator/users/${encodeURIComponent(userId)}/organization-policy`,
    jsonMutation('PATCH', { organizationLimit }),
    '组织额度响应格式无效',
  )
}

function jsonMutation(method: 'POST' | 'PATCH' | 'DELETE', body: object): RequestInit {
  return {
    method,
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(body),
  }
}

async function requestOrganizationPayload<T>(
  url: string,
  options: RequestInit | undefined,
  errorMessage: string,
): Promise<T> {
  const payload = await requestJson(url, options ?? { headers: { Accept: 'application/json' } })
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as unknown as T
}
