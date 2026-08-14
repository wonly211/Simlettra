import type {
  SaveStorageQuotaDefaultRequest,
  SaveStorageQuotaDefaultResponse,
  SaveStorageQuotaOverrideRequest,
  SaveStorageQuotaOverrideResponse,
  StorageQuotaOverviewResponse,
} from '../../shared/contracts/storage-quotas'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export function fetchStorageQuotaOverview() {
  return requestStorageQuotaPayload<StorageQuotaOverviewResponse>(
    '/api/auth/admin/storage-quotas',
    { headers: { Accept: 'application/json' } },
    '逻辑存储配额响应格式无效',
  )
}

export function saveStorageQuotaDefault(
  ownerType: 'user' | 'organization',
  input: SaveStorageQuotaDefaultRequest,
) {
  return requestStorageQuotaPayload<SaveStorageQuotaDefaultResponse>(
    `/api/auth/admin/storage-quotas/defaults/${ownerType}`,
    jsonMutation('PUT', input),
    '默认存储配额保存响应格式无效',
  )
}

export function saveStorageQuotaOverride(
  ownerType: 'user' | 'organization',
  ownerId: string,
  input: SaveStorageQuotaOverrideRequest,
) {
  return requestStorageQuotaPayload<SaveStorageQuotaOverrideResponse>(
    `/api/auth/admin/storage-quotas/${ownerType}/${ownerId}`,
    jsonMutation('PUT', input),
    '单独存储配额保存响应格式无效',
  )
}

function jsonMutation(method: 'PUT', body: object): RequestInit {
  return {
    method,
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(body),
  }
}

async function requestStorageQuotaPayload<T>(
  url: string,
  options: RequestInit,
  errorMessage: string,
) {
  const payload = await requestJson(url, options)
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as T
}
