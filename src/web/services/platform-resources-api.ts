import type {
  DeletePlatformResourceConfigurationResponse,
  PlatformResourceKind,
  PlatformResourceOverviewResponse,
  RefreshPlatformResourcesResponse,
  SavePlatformResourceConfigurationRequest,
  SavePlatformResourceConfigurationResponse,
  SavePlatformResourceThresholdRequest,
  SavePlatformResourceThresholdResponse,
} from '../../shared/contracts/platform-resources'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export function fetchPlatformResourceOverview() {
  return requestPlatformResourcePayload<PlatformResourceOverviewResponse>(
    '/api/auth/admin/platform-resources',
    { headers: { Accept: 'application/json' } },
    'Cloudflare 免费资源响应格式无效',
  )
}

export function savePlatformResourceConfiguration(input: SavePlatformResourceConfigurationRequest) {
  return requestPlatformResourcePayload<SavePlatformResourceConfigurationResponse>(
    '/api/auth/admin/platform-resources/configuration',
    jsonMutation('PUT', input),
    'Cloudflare 资源配置保存响应格式无效',
  )
}

export function deletePlatformResourceConfiguration() {
  return requestPlatformResourcePayload<DeletePlatformResourceConfigurationResponse>(
    '/api/auth/admin/platform-resources/configuration',
    { method: 'DELETE', headers: authenticatedMutationHeaders() },
    'Cloudflare 资源配置删除响应格式无效',
  )
}

export function refreshPlatformResources() {
  return requestPlatformResourcePayload<RefreshPlatformResourcesResponse>(
    '/api/auth/admin/platform-resources/refresh',
    { method: 'POST', headers: authenticatedMutationHeaders() },
    'Cloudflare 资源刷新响应格式无效',
  )
}

export function savePlatformResourceThreshold(
  resourceKind: PlatformResourceKind,
  input: SavePlatformResourceThresholdRequest,
) {
  return requestPlatformResourcePayload<SavePlatformResourceThresholdResponse>(
    `/api/auth/admin/platform-resources/${resourceKind}/threshold`,
    jsonMutation('PUT', input),
    'Cloudflare 资源阈值保存响应格式无效',
  )
}

function jsonMutation(method: 'PUT', body: object): RequestInit {
  return {
    method,
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(body),
  }
}

async function requestPlatformResourcePayload<T>(
  url: string,
  options: RequestInit,
  errorMessage: string,
): Promise<T> {
  const payload = await requestJson(url, options)
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as T
}
