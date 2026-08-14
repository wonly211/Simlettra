import type {
  ChangeDraftStatusResponse,
  CreateDraftRequest,
  DraftDetailResponse,
  DraftStatus,
  DraftWorkspaceResponse,
  SaveDraftRequest,
  SaveDraftResponse,
  UploadDraftAttachmentResponse,
} from '../../shared/contracts/drafts'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export async function fetchDraftWorkspace(status: DraftStatus = 'active') {
  return requestDraftPayload<DraftWorkspaceResponse>(
    `/api/auth/drafts?status=${status}`,
    { headers: { Accept: 'application/json' } },
    '草稿列表响应格式无效',
  )
}

export async function createServerDraft(input: CreateDraftRequest = {}) {
  return requestDraftPayload<DraftDetailResponse>(
    '/api/auth/drafts',
    jsonMutation('POST', input),
    '新建草稿响应格式无效',
  )
}

export async function fetchDraftDetail(draftId: string) {
  return requestDraftPayload<DraftDetailResponse>(
    `/api/auth/drafts/${encodeURIComponent(draftId)}`,
    { headers: { Accept: 'application/json' } },
    '草稿详情响应格式无效',
  )
}

export async function saveServerDraft(draftId: string, input: SaveDraftRequest) {
  return requestDraftPayload<SaveDraftResponse>(
    `/api/auth/drafts/${encodeURIComponent(draftId)}`,
    jsonMutation('PUT', input),
    '草稿保存响应格式无效',
  )
}

export async function uploadServerDraftAttachment(
  draftId: string,
  revisionNumber: number,
  mutationKey: string,
  file: File,
) {
  return requestDraftPayload<UploadDraftAttachmentResponse>(
    `/api/auth/drafts/${encodeURIComponent(draftId)}/attachments`,
    {
      method: 'POST',
      headers: {
        ...authenticatedMutationHeaders(),
        'Content-Type': file.type || 'application/octet-stream',
        'X-Simlettra-Expected-Revision': String(revisionNumber),
        'X-Simlettra-File-Name': encodeURIComponent(file.name),
        'X-Simlettra-Mutation-Key': mutationKey,
      },
      body: file,
    },
    '附件上传响应格式无效',
  )
}

export async function trashServerDraft(draftId: string) {
  return changeDraftStatus(draftId, 'trash')
}

export async function restoreServerDraft(draftId: string) {
  return changeDraftStatus(draftId, 'restore')
}

export function draftAttachmentUrl(draftId: string, attachmentId: string): string {
  return `/api/auth/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`
}

async function changeDraftStatus(draftId: string, action: 'trash' | 'restore') {
  return requestDraftPayload<ChangeDraftStatusResponse>(
    `/api/auth/drafts/${encodeURIComponent(draftId)}/${action}`,
    { method: 'POST', headers: authenticatedMutationHeaders() },
    '草稿状态响应格式无效',
  )
}

function jsonMutation(method: 'POST' | 'PUT', body: object): RequestInit {
  return {
    method,
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify(body),
  }
}

async function requestDraftPayload<T>(
  url: string,
  options: RequestInit,
  errorMessage: string,
): Promise<T> {
  const payload = await requestJson(url, options)
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as T
}
