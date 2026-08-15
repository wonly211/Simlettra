import type {
  ChangeManagedUserStatusResponse,
  CreateManagedUserRequest,
  CreateManagedUserResponse,
  ManagedUserStatus,
  UserManagementOverviewResponse,
} from '../../shared/contracts/user-management'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export async function fetchUserManagementOverview(): Promise<UserManagementOverviewResponse> {
  const payload = await requestJson('/api/auth/administrator/users', {
    headers: { Accept: 'application/json' },
  })
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    !Array.isArray(payload.data.users) ||
    !Array.isArray(payload.data.domains)
  ) {
    throw new Error('用户管理响应格式无效')
  }
  return payload as unknown as UserManagementOverviewResponse
}

export async function createUser(
  input: CreateManagedUserRequest,
): Promise<CreateManagedUserResponse> {
  const payload = await requestJson('/api/auth/administrator/users', {
    method: 'POST',
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(input),
  })
  if (!isTemporaryPasswordResponse(payload) || !isManagedUser(payload.data.user)) {
    throw new Error('创建用户响应格式无效')
  }
  return payload as unknown as CreateManagedUserResponse
}

export async function changeUserStatus(
  userId: string,
  status: ManagedUserStatus,
): Promise<ChangeManagedUserStatusResponse> {
  const action = status === 'active' ? 'enable' : 'disable'
  const payload = await requestJson(
    `/api/auth/administrator/users/${encodeURIComponent(userId)}/${action}`,
    {
      method: 'POST',
      headers: authenticatedMutationHeaders(),
    },
  )
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    !isManagedUser(payload.data.user) ||
    typeof payload.data.changed !== 'boolean' ||
    typeof payload.data.revokedSessions !== 'number'
  ) {
    throw new Error('用户状态响应格式无效')
  }
  return payload as unknown as ChangeManagedUserStatusResponse
}

function isTemporaryPasswordResponse(value: unknown): value is {
  data: { user: unknown; temporaryPassword: string; expiresAt: string }
} {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    typeof value.data.temporaryPassword === 'string' &&
    typeof value.data.expiresAt === 'string'
  )
}

function isManagedUser(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.primaryAddress === 'string' &&
    (value.status === 'active' || value.status === 'disabled') &&
    (value.role === 'administrator' || value.role === 'user') &&
    typeof value.createdAt === 'string'
  )
}
