import type {
  ChangeNotificationSubscriptionStatusRequest,
  ChangeNotificationSubscriptionStatusResponse,
  CreateNotificationSubscriptionRequest,
  CreateNotificationSubscriptionResponse,
  DeleteNotificationSubscriptionResponse,
  NotificationOverviewResponse,
} from '../../shared/contracts/notifications'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export function fetchNotificationOverview() {
  return requestNotificationPayload<NotificationOverviewResponse>(
    '/api/auth/notifications',
    { headers: { Accept: 'application/json' } },
    '通知设置响应格式无效',
  )
}

export function createNotificationSubscription(input: CreateNotificationSubscriptionRequest) {
  return requestNotificationPayload<CreateNotificationSubscriptionResponse>(
    '/api/auth/notifications',
    jsonMutation('POST', input),
    '通知订阅创建响应格式无效',
  )
}

export function changeNotificationSubscriptionStatus(
  subscriptionId: string,
  input: ChangeNotificationSubscriptionStatusRequest,
) {
  return requestNotificationPayload<ChangeNotificationSubscriptionStatusResponse>(
    `/api/auth/notifications/${encodeURIComponent(subscriptionId)}/status`,
    jsonMutation('POST', input),
    '通知订阅状态响应格式无效',
  )
}

export function deleteNotificationSubscription(subscriptionId: string) {
  return requestNotificationPayload<DeleteNotificationSubscriptionResponse>(
    `/api/auth/notifications/${encodeURIComponent(subscriptionId)}`,
    { method: 'DELETE', headers: authenticatedMutationHeaders() },
    '通知订阅删除响应格式无效',
  )
}

function jsonMutation(method: 'POST', body: object): RequestInit {
  return {
    method,
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(body),
  }
}

async function requestNotificationPayload<T>(
  url: string,
  options: RequestInit,
  errorMessage: string,
): Promise<T> {
  const payload = await requestJson(url, options)
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as T
}
