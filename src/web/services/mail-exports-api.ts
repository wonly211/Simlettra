import type {
  CreateMailExportRequest,
  CreateMailExportResponse,
  DeleteMailExportResponse,
  MailExportOverviewResponse,
} from '../../shared/contracts/mail-exports'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export function fetchMailExportOverview(): Promise<MailExportOverviewResponse> {
  return requestMailExportPayload(
    '/api/auth/mail-exports',
    { headers: { Accept: 'application/json' } },
    '邮件导出响应格式无效',
  )
}

export function createMailExport(
  input: CreateMailExportRequest,
): Promise<CreateMailExportResponse> {
  return requestMailExportPayload(
    '/api/auth/mail-exports',
    {
      method: 'POST',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify(input),
    },
    '邮件导出创建响应格式无效',
  )
}

export function deleteMailExport(runId: string): Promise<DeleteMailExportResponse> {
  return requestMailExportPayload(
    `/api/auth/mail-exports/${encodeURIComponent(runId)}`,
    { method: 'DELETE', headers: authenticatedMutationHeaders() },
    '邮件导出删除响应格式无效',
  )
}

async function requestMailExportPayload<T>(
  url: string,
  options: RequestInit,
  errorMessage: string,
): Promise<T> {
  const payload = await requestJson(url, options)
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(errorMessage)
  return payload as T
}
