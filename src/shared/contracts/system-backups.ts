import type { StorageMode } from './storage-mode'

export type SystemBackupStatus =
  'planned' | 'running' | 'paused' | 'failed' | 'succeeded' | 'cancelled'

export type SystemRestoreStatus =
  'planned' | 'validating' | 'running' | 'failed' | 'succeeded' | 'cancelled'

export type SystemRestoreStage =
  'manifest' | 'd1' | 'objects' | 'migrations' | 'search' | 'final_checks' | 'completed'

export interface SystemBackupRunSummary {
  id: string
  formatVersion: number
  migrationVersion: string
  storageMode: StorageMode
  status: SystemBackupStatus
  tableCount: number
  objectCount: number
  totalBytes: number
  manifestSha256: string | null
  requiredConfigurationKeyVersions: number[]
  errorCode: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface SystemRestoreRunSummary {
  id: string
  sourceBackupReference: string
  sourceManifestSha256: string
  targetMode: 'empty'
  status: SystemRestoreStatus
  currentStage: SystemRestoreStage
  errorCode: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface SystemBackupOverviewResponse {
  data: {
    backups: SystemBackupRunSummary[]
    restores: SystemRestoreRunSummary[]
  }
}

export interface CreateSystemBackupResponse {
  data: { backup: SystemBackupRunSummary }
}

export interface SystemBackupManifestEntry {
  kind: 'd1_table' | 'object'
  logicalKey: string
  rowCount: number | null
  sizeBytes: number
  sha256: string
}

export interface SystemBackupManifest {
  product: '澄笺 | Simlettra'
  formatVersion: number
  backupReference: string
  migrationVersion: string
  storageMode: StorageMode
  encryption: {
    mode: 'authenticated'
    format: string
    kdf: string
  }
  requiredConfigurationKeyVersions: number[]
  tableCount: number
  objectCount: number
  totalBytes: number
  createdAt: number
  completedAt: number
  entries: SystemBackupManifestEntry[]
}

export interface CreateEmptySystemRestoreRequest {
  sourceBackupReference: string
  sourceManifestSha256: string
}

export interface CreateSystemRestoreResponse {
  data: { restore: SystemRestoreRunSummary }
}
