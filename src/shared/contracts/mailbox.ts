export type MailboxScope = 'all' | 'personal' | 'organization'
export type MailboxView = 'inbox' | 'sent' | 'starred' | 'archive' | 'spam' | 'trash' | 'all'
export type MailboxLocation = 'inbox' | 'sent' | 'spam' | 'trash'
export type MailboxSort = 'newest' | 'oldest' | 'unread' | 'starred' | 'attachments'

export interface MailboxSearchIndexState {
  status: 'ready' | 'building' | 'needs_attention'
  pendingMessageCount: number
}

export interface MailboxSearchFilters {
  body: string
  subject: string
  sender: string
  recipient: string
  mailboxAddress: string
  dateFrom: number | null
  dateTo: number | null
  attachment: 'all' | 'with' | 'without'
  read: 'all' | 'read' | 'unread'
  starred: 'all' | 'starred' | 'unstarred'
  archived: 'all' | 'archived' | 'unarchived'
  sort: MailboxSort
}

export interface MailboxOrganizationScope {
  id: string
  name: string
}

export interface MailboxAddress {
  displayName: string | null
  address: string
}

export interface MailboxListItem {
  id: string
  mailboxType: 'user' | 'organization'
  entryKind: 'received' | 'sent'
  organization: MailboxOrganizationScope | null
  subject: string
  sender: MailboxAddress | null
  occurredAt: number
  actualDeliveryAddresses: string[]
  isRead: boolean
  isStarred: boolean
  isArchived: boolean
  location: MailboxLocation
  trashDueAt: number | null
  hasAttachments: boolean
  attachmentCount: number
  conversationMessageCount: number
  conversationUnreadCount: number
}

export interface MailboxListResponse {
  data: {
    items: MailboxListItem[]
    organizations: MailboxOrganizationScope[]
    nextCursor: string | null
    searchIndex: MailboxSearchIndexState | null
  }
}

export type MailboxHeaderAddressRole = 'from' | 'sender' | 'reply_to' | 'to' | 'cc' | 'bcc'

export interface MailboxHeaderAddress extends MailboxAddress {
  role: MailboxHeaderAddressRole
}

export interface MailboxAttachment {
  id: string
  fileName: string
  mediaType: string
  sizeBytes: number
  inline: boolean
  previewable: boolean
}

export interface MailboxMessageDetail {
  id: string
  mailboxType: 'user' | 'organization'
  entryKind: 'received' | 'sent'
  organization: MailboxOrganizationScope | null
  subject: string
  headerDateText: string | null
  headerDateAt: number | null
  acceptedAt: number
  occurredAt: number
  addresses: MailboxHeaderAddress[]
  actualDeliveryAddresses: string[]
  plainTextBody: string | null
  untrustedHtmlBody: string | null
  attachments: MailboxAttachment[]
  isRead: boolean
  isStarred: boolean
  isArchived: boolean
  location: MailboxLocation
  trashDueAt: number | null
  remoteImagesAllowed: boolean
  remoteImagePermission: 'message' | 'sender' | 'blocked' | 'default'
  trustedSenderAddress: string | null
  canPermanentlyDelete: boolean
}

export interface MailboxMessageDetailResponse {
  data: {
    message: MailboxMessageDetail
    conversation: MailboxConversationSummary
  }
}

export interface MailboxConversationEntry {
  id: string
  subject: string
  sender: MailboxAddress | null
  occurredAt: number
  isRead: boolean
  hasAttachments: boolean
  attachmentCount: number
}

export interface MailboxConversationSummary {
  entries: MailboxConversationEntry[]
}

export interface UpdateMailboxReadStateRequest {
  isRead: boolean
}

export interface UpdateMailboxReadStateResponse {
  data: {
    entryId: string
    isRead: boolean
  }
}

export type MailboxOrganizeAction =
  | 'mark_read'
  | 'mark_unread'
  | 'star'
  | 'unstar'
  | 'archive'
  | 'unarchive'
  | 'move_to_trash'
  | 'restore_from_trash'
  | 'mark_spam'
  | 'restore_from_spam'

export interface OrganizeMailboxEntriesRequest {
  entryIds: string[]
  action: MailboxOrganizeAction
}

export interface OrganizeMailboxEntriesResponse {
  data: {
    entryIds: string[]
    action: MailboxOrganizeAction
  }
}

export interface PermanentlyDeleteMailboxEntryRequest {
  confirmed: boolean
}

export interface PermanentlyDeleteMailboxEntryResponse {
  data: {
    entryId: string
    deletionOperationId: string
    deletionScope: 'personal' | 'organization'
    affectedMemberCount: number
    physicalCleanupScheduled: boolean
  }
}

export type RemoteImagePermissionMode = 'message' | 'sender' | 'block'

export interface UpdateRemoteImagePermissionRequest {
  mode: RemoteImagePermissionMode
}

export interface UpdateRemoteImagePermissionResponse {
  data: {
    entryId: string
    remoteImagesAllowed: boolean
    remoteImagePermission: MailboxMessageDetail['remoteImagePermission']
    trustedSenderAddress: string | null
  }
}
