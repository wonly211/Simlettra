import type {
  OutboundManagementOverviewResponse,
  SaveDomainOutboundRouteRequest,
  SaveDomainOutboundRouteResponse,
  SaveOutboundProviderRequest,
  SaveOutboundProviderResponse,
  SaveOutboundQuotaRequest,
  SaveOutboundQuotaResponse,
  SendDraftRequest,
  SendDraftResponse,
  SendOperationResponse,
} from '../../shared/contracts/sending'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export function sendServerDraft(draftId: string, input: SendDraftRequest) {
  return requestSendingPayload<SendDraftResponse>(
    `/api/auth/drafts/${encodeURIComponent(draftId)}/send`,
    jsonMutation('POST', input),
    '发信响应格式无效',
  )
}

export function fetchSendOperation(sendOperationId: string) {
  return requestSendingPayload<SendOperationResponse>(
    `/api/auth/sends/${encodeURIComponent(sendOperationId)}`,
    { headers: { Accept: 'application/json' } },
    '发信状态响应格式无效',
  )
}

export function fetchOutboundManagement() {
  return requestSendingPayload<OutboundManagementOverviewResponse>(
    '/api/auth/admin/outbound',
    { headers: { Accept: 'application/json' } },
    '发信服务管理响应格式无效',
  )
}

export function saveOutboundProvider(input: SaveOutboundProviderRequest) {
  const path = input.id
    ? `/api/auth/admin/outbound/providers/${encodeURIComponent(input.id)}`
    : '/api/auth/admin/outbound/providers'
  return requestSendingPayload<SaveOutboundProviderResponse>(
    path,
    jsonMutation(input.id ? 'PUT' : 'POST', input),
    '发信服务保存响应格式无效',
  )
}

export function saveDomainOutboundRoute(domainId: string, input: SaveDomainOutboundRouteRequest) {
  return requestSendingPayload<SaveDomainOutboundRouteResponse>(
    `/api/auth/admin/outbound/domains/${encodeURIComponent(domainId)}/route`,
    jsonMutation('PUT', input),
    '域名发信路线保存响应格式无效',
  )
}

export function saveDailyDefaultQuota(input: SaveOutboundQuotaRequest) {
  return saveQuota('/api/auth/admin/outbound/quotas/daily-default', input)
}

export function saveDomainMonthlyDefaultQuota(input: SaveOutboundQuotaRequest) {
  return saveQuota('/api/auth/admin/outbound/quotas/domain-monthly-default', input)
}

export function saveUserDailyQuota(userId: string, input: SaveOutboundQuotaRequest) {
  return saveQuota(`/api/auth/admin/outbound/quotas/users/${encodeURIComponent(userId)}`, input)
}

export function saveDomainMonthlyQuota(domainId: string, input: SaveOutboundQuotaRequest) {
  return saveQuota(`/api/auth/admin/outbound/quotas/domains/${encodeURIComponent(domainId)}`, input)
}

function saveQuota(path: string, input: SaveOutboundQuotaRequest) {
  return requestSendingPayload<SaveOutboundQuotaResponse>(
    path,
    jsonMutation('PUT', input),
    '发件额度保存响应格式无效',
  )
}

function jsonMutation(method: 'POST' | 'PUT', body: object): RequestInit {
  return {
    method,
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(body),
  }
}

async function requestSendingPayload<T>(
  url: string,
  options: RequestInit,
  errorMessage: string,
): Promise<T> {
  const payload = await requestJson(url, options)
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as T
}
