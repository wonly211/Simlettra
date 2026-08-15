import type { StorageMode } from './storage-mode'

export type StorageQuotaOwnerType = 'user' | 'organization'

export interface StorageQuotaDefaultSummary {
  ownerType: StorageQuotaOwnerType
  storageMode: StorageMode
  limitBytes: number
  policyVersion: number
}

export interface StorageQuotaSubjectSummary {
  ownerType: StorageQuotaOwnerType
  ownerId: string
  displayName: string
  committedBytes: number
  reservedBytes: number
  limitBytes: number
  remainingBytes: number
  usesDefault: boolean
  policyVersion: number
  overLimit: boolean
}

export interface StorageQuotaOverviewResponse {
  data: {
    storageMode: StorageMode
    defaults: StorageQuotaDefaultSummary[]
    users: StorageQuotaSubjectSummary[]
    organizations: StorageQuotaSubjectSummary[]
  }
}

export interface SaveStorageQuotaDefaultRequest {
  limitBytes: number
}

export interface SaveStorageQuotaDefaultResponse {
  data: { policy: StorageQuotaDefaultSummary }
}

export interface SaveStorageQuotaOverrideRequest {
  limitBytes: number | null
}

export interface SaveStorageQuotaOverrideResponse {
  data: { subject: StorageQuotaSubjectSummary }
}
