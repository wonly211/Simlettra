import type {
  ChangeMailDomainStatusResponse,
  CreateMailDomainResponse,
  DeleteMailDomainResponse,
  DomainManagementOverviewResponse,
  MailDomainStatus,
  ManagedMailDomain,
} from '../../shared/contracts/domain-management'
import { authenticatedMutationHeaders, isRecord, requestJson } from './api-client'

export async function fetchDomainManagementOverview(): Promise<DomainManagementOverviewResponse> {
  const payload = await requestJson('/api/auth/administrator/domains', {
    headers: { Accept: 'application/json' },
  })
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.domains)) {
    throw new Error('域名管理响应格式无效')
  }
  return payload as unknown as DomainManagementOverviewResponse
}

export async function createMailDomain(domainName: string): Promise<CreateMailDomainResponse> {
  const payload = await requestJson('/api/auth/administrator/domains', {
    method: 'POST',
    headers: authenticatedMutationHeaders({ json: true }),
    body: JSON.stringify({ domainName }),
  })
  if (!isRecord(payload) || !isRecord(payload.data) || !isManagedMailDomain(payload.data.domain)) {
    throw new Error('创建域名响应格式无效')
  }
  return payload as unknown as CreateMailDomainResponse
}

export async function changeMailDomainStatus(
  domainId: string,
  status: MailDomainStatus,
): Promise<ChangeMailDomainStatusResponse> {
  const action = status === 'active' ? 'resume' : 'pause'
  const payload = await requestJson(
    `/api/auth/administrator/domains/${encodeURIComponent(domainId)}/${action}`,
    {
      method: 'POST',
      headers: authenticatedMutationHeaders(),
    },
  )
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    !isManagedMailDomain(payload.data.domain) ||
    typeof payload.data.changed !== 'boolean'
  ) {
    throw new Error('域名状态响应格式无效')
  }
  return payload as unknown as ChangeMailDomainStatusResponse
}

export async function deleteMailDomain(domainId: string): Promise<DeleteMailDomainResponse> {
  const payload = await requestJson(
    `/api/auth/administrator/domains/${encodeURIComponent(domainId)}`,
    {
      method: 'DELETE',
      headers: authenticatedMutationHeaders({ json: true }),
      body: JSON.stringify({ confirmed: true }),
    },
  )
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    typeof payload.data.deletedDomainId !== 'string' ||
    typeof payload.data.canonicalName !== 'string'
  ) {
    throw new Error('删除域名响应格式无效')
  }
  return payload as unknown as DeleteMailDomainResponse
}

function isManagedMailDomain(value: unknown): value is ManagedMailDomain {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.canonicalName === 'string' &&
    (value.status === 'active' || value.status === 'paused') &&
    (value.catchAllMode === 'reject' || value.catchAllMode === 'unallocated') &&
    typeof value.addressCount === 'number' &&
    typeof value.createdAt === 'string' &&
    (value.pausedAt === null || typeof value.pausedAt === 'string')
  )
}
