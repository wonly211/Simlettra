import type {
  MailboxListResponse,
  MailboxMessageDetailResponse,
  MailboxOrganizeAction,
  MailboxSearchFilters,
  MailboxScope,
  MailboxView,
  OrganizeMailboxEntriesResponse,
  PermanentlyDeleteMailboxEntryResponse,
  RemoteImagePermissionMode,
  UpdateMailboxReadStateResponse,
  UpdateRemoteImagePermissionResponse,
} from '../../shared/contracts/mailbox'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export async function fetchInbox(options?: {
  scope?: MailboxScope
  view?: MailboxView
  organizationId?: string
  cursor?: string
  search?: MailboxSearchFilters
}): Promise<MailboxListResponse> {
  const query = new URLSearchParams()
  query.set('scope', options?.scope ?? 'all')
  query.set('view', options?.view ?? 'inbox')
  if (options?.organizationId) query.set('organizationId', options.organizationId)
  if (options?.cursor) query.set('cursor', options.cursor)
  if (options?.search) {
    const search = options.search
    if (search.body) query.set('body', search.body)
    if (search.subject) query.set('subject', search.subject)
    if (search.sender) query.set('sender', search.sender)
    if (search.recipient) query.set('recipient', search.recipient)
    if (search.mailboxAddress) query.set('mailboxAddress', search.mailboxAddress)
    if (search.dateFrom !== null) query.set('dateFrom', String(search.dateFrom))
    if (search.dateTo !== null) query.set('dateTo', String(search.dateTo))
    query.set('attachment', search.attachment)
    query.set('read', search.read)
    query.set('starred', search.starred)
    query.set('archived', search.archived)
    query.set('sort', search.sort)
  }
  return requestMailboxPayload(
    `/api/auth/mailbox/inbox?${query.toString()}`,
    undefined,
    '收件箱响应格式无效',
  )
}

export async function organizeMessages(
  entryIds: string[],
  action: MailboxOrganizeAction,
): Promise<OrganizeMailboxEntriesResponse> {
  return requestMailboxPayload(
    '/api/auth/mailbox/actions',
    jsonMutation('POST', { entryIds, action }),
    '邮箱整理响应格式无效',
  )
}

export async function permanentlyDeleteMessage(
  entryId: string,
): Promise<PermanentlyDeleteMailboxEntryResponse> {
  return requestMailboxPayload(
    `/api/auth/mailbox/entries/${encodeURIComponent(entryId)}`,
    jsonMutation('DELETE', { confirmed: true }),
    '邮件永久删除响应格式无效',
  )
}

export async function fetchMessageDetail(entryId: string): Promise<MailboxMessageDetailResponse> {
  return requestMailboxPayload(
    `/api/auth/mailbox/entries/${encodeURIComponent(entryId)}`,
    undefined,
    '邮件详情响应格式无效',
  )
}

export async function setMessageRead(
  entryId: string,
  isRead: boolean,
): Promise<UpdateMailboxReadStateResponse> {
  return requestMailboxPayload(
    `/api/auth/mailbox/entries/${encodeURIComponent(entryId)}/read`,
    jsonMutation('POST', { isRead }),
    '已读状态响应格式无效',
  )
}

export async function setRemoteImagePermission(
  entryId: string,
  mode: RemoteImagePermissionMode,
): Promise<UpdateRemoteImagePermissionResponse> {
  return requestMailboxPayload(
    `/api/auth/mailbox/entries/${encodeURIComponent(entryId)}/remote-images`,
    jsonMutation('POST', { mode }),
    '远程图片设置响应格式无效',
  )
}

export async function untrustSender(address: string): Promise<void> {
  await requestMailboxPayload(
    `/api/auth/mailbox/trusted-senders/${encodeURIComponent(address)}`,
    { method: 'DELETE', headers: authenticatedMutationHeaders() },
    '可信发件人响应格式无效',
  )
}

export function attachmentUrl(entryId: string, objectId: string, preview = false): string {
  const base = `/api/auth/mailbox/entries/${encodeURIComponent(entryId)}/attachments/${encodeURIComponent(objectId)}`
  return preview ? `${base}?preview=1` : base
}

function jsonMutation(method: 'POST' | 'DELETE', body: object): RequestInit {
  return {
    method,
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(body),
  }
}

async function requestMailboxPayload<T>(
  url: string,
  options: RequestInit | undefined,
  errorMessage: string,
): Promise<T> {
  const payload = await requestJson(url, options ?? { headers: { Accept: 'application/json' } })
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as unknown as T
}
