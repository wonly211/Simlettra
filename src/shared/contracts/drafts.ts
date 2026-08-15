export type DraftStatus = 'active' | 'trashed'
export type DraftBodyFormat = 'rich_text' | 'plain_text'
export type DraftRecipientRole = 'to' | 'cc' | 'bcc'
export type DraftComposeKind = 'new' | 'reply' | 'reply_all' | 'forward'

export interface DraftSenderAddress {
  id: string
  address: string
  displayName: string | null
  ownerType: 'user' | 'organization'
  organizationName: string | null
  isDefault: boolean
  canSend: boolean
}

export interface DraftRecipient {
  role: DraftRecipientRole
  displayName: string | null
  address: string
}

export interface DraftAttachment {
  id: string
  fileName: string
  mediaType: string
  sizeBytes: number
}

export interface DraftSummary {
  id: string
  status: DraftStatus
  subject: string
  recipientPreview: string
  updatedAt: number
  revisionNumber: number
  attachmentCount: number
  conflictCopy: boolean
}

export interface DraftDetail extends DraftSummary {
  senderAddressId: string | null
  senderAvailable: boolean
  composeKind: DraftComposeKind
  sourceMessageId: string | null
  bodyFormat: DraftBodyFormat
  body: string
  recipients: DraftRecipient[]
  attachments: DraftAttachment[]
  trashDueAt: number | null
}

export interface DraftWorkspaceResponse {
  data: {
    drafts: DraftSummary[]
    senderAddresses: DraftSenderAddress[]
  }
}

export interface CreateDraftRequest {
  senderAddressId?: string | null
  composeKind?: DraftComposeKind
  sourceMailboxEntryId?: string | null
}

export interface DraftDetailResponse {
  data: { draft: DraftDetail }
}

export interface SaveDraftRequest {
  mutationKey: string
  expectedRevisionNumber: number
  senderAddressId: string | null
  subject: string
  bodyFormat: DraftBodyFormat
  body: string
  recipients: DraftRecipient[]
  attachmentIds: string[]
}

export interface SaveDraftResponse {
  data: {
    outcome: 'updated' | 'conflict_copy'
    draft: DraftDetail
  }
}

export interface UploadDraftAttachmentResponse {
  data: { attachment: DraftAttachment; draft: DraftDetail }
}

export interface ChangeDraftStatusResponse {
  data: { draft: DraftDetail }
}
