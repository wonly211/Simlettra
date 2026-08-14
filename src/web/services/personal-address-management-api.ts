import type {
  AdministratorAliasPolicyOverviewResponse,
  CreatePersonalAliasRequest,
  CreatePersonalAliasResponse,
  DeletePersonalAliasResponse,
  MovePersonalAddressResponse,
  PersonalAddressOverviewResponse,
  SetDefaultSenderResponse,
  UpdatePersonalAddressPreferenceRequest,
  UpdatePersonalAddressPreferenceResponse,
  UpdateUserAliasPolicyRequest,
  UpdateUserAliasPolicyResponse,
} from '../../shared/contracts/personal-address-management'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export async function fetchPersonalAddressOverview(): Promise<PersonalAddressOverviewResponse> {
  return requestAddressResponse('/api/auth/personal-addresses', '个人地址响应格式无效')
}

export async function createPersonalAlias(
  input: CreatePersonalAliasRequest,
): Promise<CreatePersonalAliasResponse> {
  return requestAddressResponse('/api/auth/personal-addresses/aliases', '创建别名响应格式无效', {
    method: 'POST',
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(input),
  })
}

export async function updatePersonalAddressPreference(
  addressId: string,
  input: UpdatePersonalAddressPreferenceRequest,
): Promise<UpdatePersonalAddressPreferenceResponse> {
  return requestAddressResponse(
    `/api/auth/personal-addresses/${encodeURIComponent(addressId)}/preferences`,
    '地址设置响应格式无效',
    {
      method: 'PATCH',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify(input),
    },
  )
}

export async function movePersonalAddress(
  addressId: string,
  direction: 'up' | 'down',
): Promise<MovePersonalAddressResponse> {
  return requestAddressResponse(
    `/api/auth/personal-addresses/${encodeURIComponent(addressId)}/move`,
    '地址排序响应格式无效',
    {
      method: 'POST',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify({ direction }),
    },
  )
}

export async function setDefaultSender(addressId: string): Promise<SetDefaultSenderResponse> {
  return requestAddressResponse(
    `/api/auth/personal-addresses/${encodeURIComponent(addressId)}/default-sender`,
    '默认发件地址响应格式无效',
    { method: 'POST', headers: authenticatedMutationHeaders() },
  )
}

export async function deletePersonalAlias(addressId: string): Promise<DeletePersonalAliasResponse> {
  return requestAddressResponse(
    `/api/auth/personal-addresses/aliases/${encodeURIComponent(addressId)}`,
    '删除别名响应格式无效',
    {
      method: 'DELETE',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify({ confirmed: true }),
    },
  )
}

export async function fetchAdministratorAliasPolicies(): Promise<AdministratorAliasPolicyOverviewResponse> {
  return requestAddressResponse('/api/auth/administrator/alias-policies', '别名策略响应格式无效')
}

export async function updateAdministratorAliasPolicy(
  userId: string,
  input: UpdateUserAliasPolicyRequest,
): Promise<UpdateUserAliasPolicyResponse> {
  return requestAddressResponse(
    `/api/auth/administrator/users/${encodeURIComponent(userId)}/alias-policy`,
    '别名策略更新响应格式无效',
    {
      method: 'PATCH',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify(input),
    },
  )
}

export async function assignPersonalAlias(
  userId: string,
  input: CreatePersonalAliasRequest,
): Promise<CreatePersonalAliasResponse> {
  return requestAddressResponse(
    `/api/auth/administrator/users/${encodeURIComponent(userId)}/aliases`,
    '分配别名响应格式无效',
    {
      method: 'POST',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify(input),
    },
  )
}

export async function deleteAssignedPersonalAlias(
  userId: string,
  addressId: string,
): Promise<DeletePersonalAliasResponse> {
  return requestAddressResponse(
    `/api/auth/administrator/users/${encodeURIComponent(userId)}/aliases/${encodeURIComponent(addressId)}`,
    '删除成员别名响应格式无效',
    {
      method: 'DELETE',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify({ confirmed: true }),
    },
  )
}

async function requestAddressResponse<T>(
  url: string,
  invalidMessage: string,
  init: RequestInit = { headers: { Accept: 'application/json' } },
): Promise<T> {
  const payload = await requestJson(url, init)
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(invalidMessage)
  return payload as T
}
