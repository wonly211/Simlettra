import type {
  ChangeForwardingRuleStatusRequest,
  ChangeForwardingRuleStatusResponse,
  CreateExternalEmailTargetRequest,
  CreateExternalEmailTargetResponse,
  DeleteExternalEmailTargetResponse,
  DeleteForwardingRuleResponse,
  ForwardingOverviewResponse,
  SaveForwardingRuleRequest,
  SaveForwardingRuleResponse,
  VerifyExternalEmailTargetRequest,
  VerifyExternalEmailTargetResponse,
} from '../../shared/contracts/forwarding'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export function fetchForwardingOverview(): Promise<ForwardingOverviewResponse> {
  return requestForwardingPayload(
    '/api/auth/forwarding',
    { headers: { Accept: 'application/json' } },
    '自动转发设置响应格式无效',
  )
}

export function createExternalEmailTarget(
  input: CreateExternalEmailTargetRequest,
): Promise<CreateExternalEmailTargetResponse> {
  return requestForwardingPayload(
    '/api/auth/forwarding/targets',
    jsonMutation(input),
    '外部邮箱创建响应格式无效',
  )
}

export function verifyExternalEmailTarget(
  targetId: string,
  input: VerifyExternalEmailTargetRequest,
): Promise<VerifyExternalEmailTargetResponse> {
  return requestForwardingPayload(
    `/api/auth/forwarding/targets/${encodeURIComponent(targetId)}/verify`,
    jsonMutation(input),
    '外部邮箱验证响应格式无效',
  )
}

export function deleteExternalEmailTarget(
  targetId: string,
): Promise<DeleteExternalEmailTargetResponse> {
  return requestForwardingPayload(
    `/api/auth/forwarding/targets/${encodeURIComponent(targetId)}`,
    { method: 'DELETE', headers: authenticatedMutationHeaders() },
    '外部邮箱删除响应格式无效',
  )
}

export function saveForwardingRule(
  input: SaveForwardingRuleRequest,
): Promise<SaveForwardingRuleResponse> {
  return requestForwardingPayload(
    '/api/auth/forwarding/rules',
    jsonMutation(input),
    '转发规则保存响应格式无效',
  )
}

export function changeForwardingRuleStatus(
  ruleId: string,
  input: ChangeForwardingRuleStatusRequest,
): Promise<ChangeForwardingRuleStatusResponse> {
  return requestForwardingPayload(
    `/api/auth/forwarding/rules/${encodeURIComponent(ruleId)}/status`,
    jsonMutation(input),
    '转发规则状态响应格式无效',
  )
}

export function deleteForwardingRule(ruleId: string): Promise<DeleteForwardingRuleResponse> {
  return requestForwardingPayload(
    `/api/auth/forwarding/rules/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE', headers: authenticatedMutationHeaders() },
    '转发规则删除响应格式无效',
  )
}

function jsonMutation(body: object): RequestInit {
  return {
    method: 'POST',
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(body),
  }
}

async function requestForwardingPayload<T>(
  url: string,
  options: RequestInit,
  errorMessage: string,
): Promise<T> {
  const payload = await requestJson(url, options)
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as T
}
