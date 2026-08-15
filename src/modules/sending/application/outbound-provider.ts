export type OutboundProviderType = 'resend' | 'smtp2go'

export type OutboundProviderResult =
  | { kind: 'accepted'; submissionId: string | null }
  | { kind: 'not_accepted'; retryWithFallback: boolean; code: string }
  | { kind: 'unknown'; code: string }

export interface OutboundProviderAttachment {
  fileName: string
  mediaType: string
  content: string
}

export interface OutboundProviderMessage {
  senderAddress: string
  senderDisplayName?: string | null
  recipientAddress: string
  subject: string
  text?: string
  html?: string
  replyTo?: string | null
  headers?: Record<string, string>
  attachments?: OutboundProviderAttachment[]
}

export async function submitOutboundProviderMessage(options: {
  fetcher: typeof fetch
  providerType: OutboundProviderType
  credential: string
  idempotencyKey: string
  message: OutboundProviderMessage
}): Promise<OutboundProviderResult> {
  const headers = sanitizeHeaders(options.message.headers ?? {})
  if (options.message.replyTo) headers['Reply-To'] = sanitizeHeaderValue(options.message.replyTo)
  try {
    const response =
      options.providerType === 'resend'
        ? await options.fetcher('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${options.credential}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': options.idempotencyKey,
              'User-Agent': 'Simlettra/0.1',
            },
            body: JSON.stringify({
              from: formatSender(options.message.senderDisplayName, options.message.senderAddress),
              to: [options.message.recipientAddress],
              subject: options.message.subject,
              ...(options.message.html !== undefined ? { html: options.message.html } : {}),
              ...(options.message.text !== undefined ? { text: options.message.text } : {}),
              headers: Object.keys(headers).length > 0 ? headers : undefined,
              attachments: (options.message.attachments ?? []).map((attachment) => ({
                filename: attachment.fileName,
                content: attachment.content,
                content_type: attachment.mediaType,
              })),
            }),
          })
        : await options.fetcher('https://api.smtp2go.com/v3/email/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Smtp2go-Api-Key': options.credential,
              'User-Agent': 'Simlettra/0.1',
            },
            body: JSON.stringify({
              sender: formatSender(
                options.message.senderDisplayName,
                options.message.senderAddress,
              ),
              to: [options.message.recipientAddress],
              subject: options.message.subject,
              ...(options.message.html !== undefined ? { html_body: options.message.html } : {}),
              ...(options.message.text !== undefined ? { text_body: options.message.text } : {}),
              custom_headers:
                Object.keys(headers).length > 0
                  ? Object.entries(headers).map(([header, value]) => ({ header, value }))
                  : undefined,
              attachments: (options.message.attachments ?? []).map((attachment) => ({
                filename: attachment.fileName,
                mimetype: attachment.mediaType,
                fileblob: attachment.content,
              })),
            }),
          })
    const payload: unknown = await response.json().catch(() => null)
    if (response.ok) {
      if (
        options.providerType === 'smtp2go' &&
        isRecord(payload) &&
        isRecord(payload.data) &&
        ((typeof payload.data.failed === 'number' && payload.data.failed > 0) ||
          payload.data.succeeded === 0)
      ) {
        return { kind: 'not_accepted', retryWithFallback: true, code: 'message_rejected' }
      }
      const submissionId = providerSubmissionId(payload)
      return submissionId
        ? { kind: 'accepted', submissionId }
        : { kind: 'unknown', code: 'provider_response_invalid' }
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: 'not_accepted', retryWithFallback: true, code: 'configuration_rejected' }
    }
    if (response.status === 429) {
      return { kind: 'not_accepted', retryWithFallback: true, code: 'temporary_rejection' }
    }
    if (response.status === 408 || response.status >= 500) {
      return { kind: 'unknown', code: 'provider_result_unknown' }
    }
    return { kind: 'not_accepted', retryWithFallback: false, code: 'message_rejected' }
  } catch {
    return { kind: 'unknown', code: 'provider_result_unknown' }
  }
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => /^[A-Za-z0-9-]{1,80}$/.test(name))
      .map(([name, value]) => [name, sanitizeHeaderValue(value)]),
  )
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').slice(0, 1000)
}

function providerSubmissionId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.id === 'string') return value.id.slice(0, 500)
  if (isRecord(value.data) && typeof value.data.id === 'string') return value.data.id.slice(0, 500)
  if (isRecord(value.data) && typeof value.data.email_id === 'string') {
    return value.data.email_id.slice(0, 500)
  }
  if (
    isRecord(value.data) &&
    Array.isArray(value.data.email_id) &&
    typeof value.data.email_id[0] === 'string'
  ) {
    return value.data.email_id[0].slice(0, 500)
  }
  return null
}

function formatSender(displayName: string | null | undefined, address: string): string {
  if (!displayName) return address
  return `"${displayName.replace(/["\r\n]/g, '')}" <${address}>`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
