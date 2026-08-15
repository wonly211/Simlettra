import type { MailboxAttachment, MailboxHeaderAddress } from './mailbox'

export interface UnallocatedMailListItem {
  deliveryId: string
  periodId: string
  domainId: string
  messageId: string
  subject: string
  sender: { displayName: string | null; address: string } | null
  actualDeliveryAddress: string
  occurredAt: number
  hasAttachments: boolean
  attachmentCount: number
}

export interface UnallocatedMailListResponse {
  data: {
    items: UnallocatedMailListItem[]
    nextCursor: string | null
  }
}

export interface UnallocatedMailDetail extends UnallocatedMailListItem {
  headerDateText: string | null
  headerDateAt: number | null
  acceptedAt: number
  addresses: MailboxHeaderAddress[]
  plainTextBody: string | null
  untrustedHtmlBody: string | null
  attachments: MailboxAttachment[]
}

export interface UnallocatedMailDetailResponse {
  data: { message: UnallocatedMailDetail }
}

export interface ClaimUnallocatedAddressRequest {
  confirmed: boolean
}

export interface ClaimUnallocatedAddressResponse {
  data: {
    periodId: string
    addressId: string
    address: string
    claimedMessageCount: number
    newlyAddedMessageCount: number
    chargedBytes: number
  }
}
