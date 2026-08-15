import type {
  ClaimUnallocatedAddressResponse,
  UnallocatedMailDetailResponse,
  UnallocatedMailListResponse,
} from '../../shared/contracts/unallocated-mail'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export function fetchUnallocatedMail(options?: {
  cursor?: string
  query?: string
}): Promise<UnallocatedMailListResponse> {
  const query = new URLSearchParams()
  if (options?.cursor) query.set('cursor', options.cursor)
  if (options?.query) query.set('query', options.query)
  const suffix = query.size ? `?${query.toString()}` : ''
  return requestUnallocatedPayload(
    `/api/auth/mailbox/unallocated${suffix}`,
    { headers: { Accept: 'application/json' } },
    '未分配来信响应格式无效',
  )
}

export function fetchUnallocatedMailDetail(
  deliveryId: string,
): Promise<UnallocatedMailDetailResponse> {
  return requestUnallocatedPayload(
    `/api/auth/mailbox/unallocated/${encodeURIComponent(deliveryId)}`,
    { headers: { Accept: 'application/json' } },
    '未分配邮件详情响应格式无效',
  )
}

export function claimUnallocatedAddress(
  periodId: string,
): Promise<ClaimUnallocatedAddressResponse> {
  return requestUnallocatedPayload(
    `/api/auth/mailbox/unallocated/periods/${encodeURIComponent(periodId)}/claim`,
    {
      method: 'POST',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify({ confirmed: true }),
    },
    '认领未分配地址响应格式无效',
  )
}

export function unallocatedAttachmentUrl(
  deliveryId: string,
  objectId: string,
  preview = false,
): string {
  const base = `/api/auth/mailbox/unallocated/${encodeURIComponent(deliveryId)}/attachments/${encodeURIComponent(objectId)}`
  return preview ? `${base}?preview=1` : base
}

async function requestUnallocatedPayload<T>(
  url: string,
  options: RequestInit,
  errorMessage: string,
): Promise<T> {
  const payload = await requestJson(url, options)
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as T
}
