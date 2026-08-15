import type { OperationsHealthOverviewResponse } from '../../shared/contracts/operations-health'
import { isRecord, requestJson } from './api-client'

export async function fetchOperationsHealthOverview(): Promise<OperationsHealthOverviewResponse> {
  const payload = await requestJson('/api/auth/admin/operations-health', {
    headers: { Accept: 'application/json' },
  })
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new Error('运行健康状态响应格式无效')
  }
  return payload as unknown as OperationsHealthOverviewResponse
}
