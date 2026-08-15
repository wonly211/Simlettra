export type MailExportScopeType = 'personal' | 'organization'
export type MailExportStatus =
  'planned' | 'running' | 'failed' | 'succeeded' | 'expired' | 'deleted'

export interface CreateMailExportRequest {
  scopeType: MailExportScopeType
  organizationId?: string
}

export interface MailExportArtifactSummary {
  id: string
  sequenceNumber: number
  fileName: string
  sizeBytes: number
  downloadUrl: string
}

export interface MailExportRunSummary {
  id: string
  scopeType: MailExportScopeType
  organization: { id: string; name: string } | null
  frozenMessageCount: number
  status: MailExportStatus
  artifactCount: number
  artifacts: MailExportArtifactSummary[]
  errorCode: string | null
  createdAt: number
  completedAt: number | null
  expiresAt: number
}

export interface MailExportOverviewResponse {
  data: {
    organizations: Array<{ id: string; name: string }>
    runs: MailExportRunSummary[]
  }
}

export interface CreateMailExportResponse {
  data: { run: MailExportRunSummary }
}

export interface DeleteMailExportResponse {
  data: { exportRunId: string; deleted: true }
}
