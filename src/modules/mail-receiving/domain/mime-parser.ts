import PostalMime, { type Address, type Attachment, type Mailbox } from 'postal-mime'
import type { ParsedMessageRelation } from '../../mail-conversations/public'
import { sha256Bytes, toArrayBuffer } from './content-digest'

export const MIME_PARSER_VERSION = 'postal-mime-2.7.6'
const MAX_ATTACHMENT_COUNT = 100
const MAX_HEADER_ADDRESS_COUNT = 200
const MAX_DERIVED_BYTES = 20_000_000
const MAX_RELATION_REFERENCE_COUNT = 100
const MESSAGE_REFERENCE_PATTERN = /<[^<>\s]{1,996}>/gu

export type ParsedAddressRole = 'from' | 'sender' | 'reply_to' | 'to' | 'cc' | 'bcc'

export interface ParsedHeaderAddress {
  role: ParsedAddressRole
  sequenceNumber: number
  displayName: string | null
  addressText: string
  canonicalAddress: string | null
}

export interface ParsedMailObject {
  objectRole: 'plain_body' | 'html_body' | 'attachment' | 'inline_resource'
  logicalPartKey: string
  sequenceNumber: number
  bytes: ArrayBuffer
  sha256: Uint8Array
  mediaType: string
  untrustedFileName: string | null
  contentDisposition: 'inline' | 'attachment' | null
  contentId: string | null
}

export interface ParsedIncomingMail {
  subject: string
  internetMessageId: string | null
  headerDateText: string | null
  headerDateAt: number | null
  headerAddresses: ParsedHeaderAddress[]
  relations: ParsedMessageRelation[]
  objects: ParsedMailObject[]
  attachmentCount: number
  partCount: number
  sourceMarkedBySimlettra: boolean
  forwardingHopCount: number
}

export class MimeBoundaryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function parseIncomingMime(raw: ArrayBuffer): Promise<ParsedIncomingMail> {
  const forwardingHeaders = readForwardingHeaders(raw)
  const parsed = await PostalMime.parse(raw, {
    attachmentEncoding: 'arraybuffer',
    maxNestingDepth: 64,
    maxHeadersSize: 256 * 1024,
    maxRfc822NestingDepth: 5,
  })

  if (parsed.attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new MimeBoundaryError('attachment_count_exceeded', '附件数量超过安全上限')
  }

  const headerAddresses = collectHeaderAddresses([
    ['from', parsed.from ? [parsed.from] : []],
    ['sender', parsed.sender ? [parsed.sender] : []],
    ['reply_to', parsed.replyTo ?? []],
    ['to', parsed.to ?? []],
    ['cc', parsed.cc ?? []],
    ['bcc', parsed.bcc ?? []],
  ])
  if (headerAddresses.length > MAX_HEADER_ADDRESS_COUNT) {
    throw new MimeBoundaryError('header_address_count_exceeded', '邮件头地址数量超过安全上限')
  }

  const objects: ParsedMailObject[] = []
  if (parsed.text !== undefined) {
    objects.push(await createTextObject('plain_body', parsed.text, 'text/plain; charset=utf-8'))
  }
  if (parsed.html !== undefined) {
    objects.push(await createTextObject('html_body', parsed.html, 'text/html; charset=utf-8'))
  }
  if (parsed.text === undefined && parsed.html === undefined) {
    objects.push(await createTextObject('plain_body', '', 'text/plain; charset=utf-8'))
  }

  let attachmentCount = 0
  for (const [index, attachment] of parsed.attachments.entries()) {
    const isInline = attachment.disposition === 'inline' && Boolean(attachment.contentId)
    if (!isInline) attachmentCount += 1
    objects.push(await createAttachmentObject(attachment, index, isInline))
  }

  const derivedBytes = objects.reduce((total, object) => total + object.bytes.byteLength, 0)
  if (derivedBytes > MAX_DERIVED_BYTES) {
    throw new MimeBoundaryError('derived_size_exceeded', '解析后的正文和附件总大小超过安全上限')
  }

  const internetMessageId = extractMessageReferences(parsed.messageId, 1)[0] ?? null
  const inReplyTo = extractMessageReferences(parsed.inReplyTo, MAX_RELATION_REFERENCE_COUNT)
  const references = extractMessageReferences(parsed.references, MAX_RELATION_REFERENCE_COUNT)
  if (inReplyTo.length + references.length > MAX_RELATION_REFERENCE_COUNT) {
    throw new MimeBoundaryError('relation_count_exceeded', '邮件关系引用数量超过安全上限')
  }

  return {
    subject: parsed.subject ?? '',
    internetMessageId,
    headerDateText: parsed.date ?? null,
    headerDateAt: parseHeaderDate(parsed.date),
    headerAddresses,
    relations: [
      ...inReplyTo.map((targetReference, sequenceNumber) => ({
        relationType: 'in_reply_to' as const,
        sequenceNumber,
        targetReference,
      })),
      ...references.map((targetReference, sequenceNumber) => ({
        relationType: 'reference' as const,
        sequenceNumber,
        targetReference,
      })),
    ],
    objects,
    attachmentCount,
    partCount: objects.length,
    ...forwardingHeaders,
  }
}

function readForwardingHeaders(raw: ArrayBuffer): {
  sourceMarkedBySimlettra: boolean
  forwardingHopCount: number
} {
  const headerBytes = new Uint8Array(raw, 0, Math.min(raw.byteLength, 256 * 1024))
  const headerText = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(
    headerBytes,
  )
  const boundary = headerText.search(/\r?\n\r?\n/u)
  const unfolded = (boundary >= 0 ? headerText.slice(0, boundary) : headerText).replace(
    /\r?\n[ \t]+/gu,
    ' ',
  )
  let sourceMarkedBySimlettra = false
  let forwardingHopCount = 0
  for (const line of unfolded.split(/\r?\n/u)) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (name === 'x-simlettra-forwarded' && value === '1') {
      sourceMarkedBySimlettra = true
    }
    if (name === 'x-simlettra-forward-hop' && /^\d{1,3}$/u.test(value)) {
      forwardingHopCount = Math.max(forwardingHopCount, Math.min(999, Number(value)))
    }
  }
  return { sourceMarkedBySimlettra, forwardingHopCount }
}

function extractMessageReferences(value: string | undefined, limit: number): string[] {
  if (!value) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const match of value.matchAll(MESSAGE_REFERENCE_PATTERN)) {
    const reference = match[0]
    if (seen.has(reference)) continue
    seen.add(reference)
    result.push(reference)
    if (result.length > limit) {
      throw new MimeBoundaryError('relation_count_exceeded', '邮件关系引用数量超过安全上限')
    }
  }
  return result
}

async function createTextObject(
  objectRole: 'plain_body' | 'html_body',
  content: string,
  mediaType: string,
): Promise<ParsedMailObject> {
  const bytes = new TextEncoder().encode(content)
  return {
    objectRole,
    logicalPartKey: 'body',
    sequenceNumber: 0,
    bytes: toArrayBuffer(bytes),
    sha256: await sha256Bytes(bytes),
    mediaType,
    untrustedFileName: null,
    contentDisposition: null,
    contentId: null,
  }
}

async function createAttachmentObject(
  attachment: Attachment,
  index: number,
  isInline: boolean,
): Promise<ParsedMailObject> {
  const bytes =
    typeof attachment.content === 'string'
      ? new TextEncoder().encode(attachment.content)
      : new Uint8Array(attachment.content)
  const fallbackName = `attachment-${index + 1}`
  return {
    objectRole: isInline ? 'inline_resource' : 'attachment',
    logicalPartKey: `part-${index + 1}`,
    sequenceNumber: index,
    bytes: toArrayBuffer(bytes),
    sha256: await sha256Bytes(bytes),
    mediaType: attachment.mimeType || 'application/octet-stream',
    untrustedFileName: attachment.filename || fallbackName,
    contentDisposition: isInline ? 'inline' : 'attachment',
    contentId: isInline ? (attachment.contentId ?? `inline-${index + 1}`) : null,
  }
}

function collectHeaderAddresses(
  groups: Array<[ParsedAddressRole, Address[]]>,
): ParsedHeaderAddress[] {
  const result: ParsedHeaderAddress[] = []
  for (const [role, addresses] of groups) {
    const mailboxes = addresses.flatMap(flattenAddress)
    for (const [sequenceNumber, mailbox] of mailboxes.entries()) {
      const addressText = mailbox.address.trim()
      if (!addressText) continue
      result.push({
        role,
        sequenceNumber,
        displayName: mailbox.name.trim() || null,
        addressText,
        canonicalAddress: normalizeHeaderAddress(addressText),
      })
    }
  }
  return result
}

function flattenAddress(address: Address): Mailbox[] {
  return address.group ? address.group : [address]
}

function normalizeHeaderAddress(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return normalized.includes('@') && normalized.length <= 320 ? normalized : null
}

function parseHeaderDate(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
