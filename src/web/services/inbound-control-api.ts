import type {
  ChangeDomainCatchAllModeResponse,
  ChangeInboundReceiveStatusResponse,
  ChangeInboundRejectionRuleStatusResponse,
  ChangeUnallocatedAccessGrantResponse,
  CreateInboundRejectionRuleResponse,
  DeleteInboundRejectionRuleResponse,
  InboundControlOverviewResponse,
  InboundControlScopeType,
  InboundReceiveStatus,
  InboundRejectionRuleStatus,
  InboundRejectionRuleType,
} from '../../shared/contracts/inbound-control'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export function fetchInboundControlOverview(): Promise<InboundControlOverviewResponse> {
  return requestInboundPayload(
    '/api/auth/administrator/inbound',
    { headers: { Accept: 'application/json' } },
    '收信控制响应格式无效',
  )
}

export function changeInboundReceiveStatus(
  scopeType: InboundControlScopeType,
  scopeId: string,
  status: InboundReceiveStatus,
): Promise<ChangeInboundReceiveStatusResponse> {
  return requestInboundPayload(
    `/api/auth/administrator/inbound/scopes/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeId)}`,
    jsonPut({ status }),
    '收信状态响应格式无效',
  )
}

export function changeDomainCatchAllMode(
  domainId: string,
  mode: 'reject' | 'unallocated',
): Promise<ChangeDomainCatchAllModeResponse> {
  return requestInboundPayload(
    `/api/auth/administrator/inbound/domains/${encodeURIComponent(domainId)}/catch-all`,
    jsonPut({ mode }),
    '全域收信响应格式无效',
  )
}

export function changeUnallocatedAccessGrant(
  domainId: string,
  userId: string,
  enabled: boolean,
): Promise<ChangeUnallocatedAccessGrantResponse> {
  return requestInboundPayload(
    `/api/auth/administrator/inbound/domains/${encodeURIComponent(domainId)}/access/${encodeURIComponent(userId)}`,
    jsonPut({ enabled }),
    '未分配来信授权响应格式无效',
  )
}

export function createInboundRejectionRule(
  ruleType: InboundRejectionRuleType,
  matchValue: string,
): Promise<CreateInboundRejectionRuleResponse> {
  return requestInboundPayload(
    '/api/auth/administrator/inbound/rules',
    {
      method: 'POST',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify({ ruleType, matchValue }),
    },
    '创建拒收规则响应格式无效',
  )
}

export function changeInboundRejectionRuleStatus(
  ruleId: string,
  status: InboundRejectionRuleStatus,
): Promise<ChangeInboundRejectionRuleStatusResponse> {
  return requestInboundPayload(
    `/api/auth/administrator/inbound/rules/${encodeURIComponent(ruleId)}/status`,
    jsonPut({ status }),
    '拒收规则状态响应格式无效',
  )
}

export function deleteInboundRejectionRule(
  ruleId: string,
): Promise<DeleteInboundRejectionRuleResponse> {
  return requestInboundPayload(
    `/api/auth/administrator/inbound/rules/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE', headers: authenticatedMutationHeaders() },
    '删除拒收规则响应格式无效',
  )
}

function jsonPut(body: object): RequestInit {
  return {
    method: 'PUT',
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(body),
  }
}

async function requestInboundPayload<T>(
  url: string,
  options: RequestInit,
  errorMessage: string,
): Promise<T> {
  const payload = await requestJson(url, options)
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as T
}
