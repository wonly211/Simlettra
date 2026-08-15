export type MailDomainStatus = 'active' | 'paused'

export interface ManagedMailDomain {
  id: string
  displayName: string
  canonicalName: string
  status: MailDomainStatus
  catchAllMode: 'reject' | 'unallocated'
  addressCount: number
  createdAt: string
  pausedAt: string | null
}

export interface DomainManagementOverviewResponse {
  data: { domains: ManagedMailDomain[] }
}

export interface CreateMailDomainRequest {
  domainName: string
}

export interface CreateMailDomainResponse {
  data: { domain: ManagedMailDomain }
}

export interface ChangeMailDomainStatusResponse {
  data: { domain: ManagedMailDomain; changed: boolean }
}

export interface DeleteMailDomainRequest {
  confirmed: boolean
}

export interface DeleteMailDomainResponse {
  data: { deletedDomainId: string; canonicalName: string }
}
