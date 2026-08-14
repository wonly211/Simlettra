import type {
  AddressPolicyResponse,
  UpdateAddressPolicyRequest,
  UpdateAddressPolicyResponse,
} from '../../shared/contracts/address-policy-management'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export async function fetchAddressPolicy(): Promise<AddressPolicyResponse> {
  return requestAddressPolicyResponse(
    '/api/auth/administrator/address-policy',
    '地址策略响应格式无效',
  )
}

export async function updateAddressPolicy(
  input: UpdateAddressPolicyRequest,
): Promise<UpdateAddressPolicyResponse> {
  return requestAddressPolicyResponse(
    '/api/auth/administrator/address-policy',
    '地址策略更新响应格式无效',
    {
      method: 'PATCH',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify(input),
    },
  )
}

async function requestAddressPolicyResponse<T>(
  url: string,
  invalidMessage: string,
  init: RequestInit = { headers: { Accept: 'application/json' } },
): Promise<T> {
  const payload = await requestJson(url, init)
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.policy)) {
    throw new Error(invalidMessage)
  }
  return payload as T
}
