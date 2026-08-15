import type { NotificationChannelType } from '../../../shared/contracts/notifications'

const PROVIDER_RESPONSE_LIMIT_BYTES = 64 * 1024

export type NotificationChannelResult =
  | { kind: 'accepted'; providerReference: string | null; httpStatus: number }
  | { kind: 'not_accepted'; retryable: boolean; code: string; httpStatus: number }
  | { kind: 'unknown'; code: string; httpStatus: number | null }

export interface NotificationChannelInput {
  channelType: NotificationChannelType
  publicOptions: Record<string, string>
  credential: Record<string, string | null>
  payload: string
}

export function notificationPayloadLimitError(
  channelType: NotificationChannelType,
  payload: string,
): string | null {
  if (channelType === 'ntfy' && new TextEncoder().encode(payload).byteLength > 4_096) {
    return 'ntfy_message_too_large'
  }
  const characters = Array.from(payload).length
  if (channelType === 'telegram' && characters > 4_096) return 'telegram_message_too_large'
  if (channelType === 'wxpusher' && characters > 40_000) return 'wxpusher_message_too_large'
  return null
}

export async function submitNotificationToChannel(
  input: NotificationChannelInput,
  fetcher: typeof fetch = fetch,
): Promise<NotificationChannelResult> {
  const request = buildNotificationRequest(input)
  let response: Response
  try {
    response = await fetcher(request)
  } catch {
    return { kind: 'unknown', code: 'network_result_unknown', httpStatus: null }
  }
  if ([408, 425, 429].includes(response.status)) {
    return {
      kind: 'not_accepted',
      retryable: true,
      code: response.status === 429 ? 'provider_rate_limited' : 'provider_temporarily_rejected',
      httpStatus: response.status,
    }
  }
  if (response.status >= 500) {
    return { kind: 'unknown', code: 'provider_result_unknown', httpStatus: response.status }
  }
  if (!response.ok) {
    return {
      kind: 'not_accepted',
      retryable: false,
      code: 'provider_rejected',
      httpStatus: response.status,
    }
  }
  const body = await readLimitedJson(response)
  if (body === null) {
    return { kind: 'unknown', code: 'provider_response_invalid', httpStatus: response.status }
  }
  return interpretSuccessResponse(input.channelType, body, response.status)
}

export function buildNotificationRequest(input: NotificationChannelInput): Request {
  if (input.channelType === 'ntfy') {
    const baseUrl = requiredOption(input.publicOptions, 'baseUrl')
    const topic = requiredOption(input.publicOptions, 'topic')
    const accessToken = input.credential.accessToken
    return jsonRequest(
      `${baseUrl}/`,
      { topic, title: '澄笺新邮件', message: input.payload },
      accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    )
  }
  if (input.channelType === 'gotify') {
    const baseUrl = requiredOption(input.publicOptions, 'baseUrl')
    const applicationToken = requiredCredential(input.credential, 'applicationToken')
    return jsonRequest(
      `${baseUrl}/message`,
      { title: '澄笺新邮件', message: input.payload, priority: 5 },
      { 'X-Gotify-Key': applicationToken },
    )
  }
  if (input.channelType === 'wxpusher') {
    return jsonRequest('https://wxpusher.zjiecode.com/api/send/message', {
      appToken: requiredCredential(input.credential, 'appToken'),
      content: input.payload,
      summary: '澄笺新邮件',
      contentType: 1,
      uids: [requiredOption(input.publicOptions, 'uid')],
    })
  }
  if (input.channelType === 'telegram') {
    const botToken = requiredCredential(input.credential, 'botToken')
    return jsonRequest(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: requiredOption(input.publicOptions, 'chatId'),
      text: input.payload,
      link_preview_options: { is_disabled: true },
    })
  }
  const baseUrl = requiredOption(input.publicOptions, 'baseUrl')
  return jsonRequest(`${baseUrl}/push`, {
    device_key: requiredCredential(input.credential, 'deviceKey'),
    title: '澄笺新邮件',
    body: input.payload,
    group: 'Simlettra',
  })
}

function interpretSuccessResponse(
  channelType: NotificationChannelType,
  body: unknown,
  httpStatus: number,
): NotificationChannelResult {
  if (!isRecord(body)) {
    return { kind: 'unknown', code: 'provider_response_invalid', httpStatus }
  }
  if (channelType === 'ntfy') {
    return body.event === 'message' && typeof body.id === 'string'
      ? { kind: 'accepted', providerReference: body.id, httpStatus }
      : { kind: 'unknown', code: 'provider_response_invalid', httpStatus }
  }
  if (channelType === 'gotify') {
    return typeof body.id === 'number' || typeof body.id === 'string'
      ? { kind: 'accepted', providerReference: String(body.id), httpStatus }
      : { kind: 'unknown', code: 'provider_response_invalid', httpStatus }
  }
  if (channelType === 'wxpusher') {
    const results = Array.isArray(body.data) ? body.data : []
    const first = results[0]
    if (body.code === 1000 && body.success === true && isRecord(first) && first.code === 1000) {
      const reference = first.sendRecordId
      return {
        kind: 'accepted',
        providerReference:
          typeof reference === 'number' || typeof reference === 'string' ? String(reference) : null,
        httpStatus,
      }
    }
    return {
      kind: 'not_accepted',
      retryable: false,
      code: 'provider_rejected',
      httpStatus,
    }
  }
  if (channelType === 'telegram') {
    if (body.ok === true && isRecord(body.result)) {
      const reference = body.result.message_id
      return {
        kind: 'accepted',
        providerReference:
          typeof reference === 'number' || typeof reference === 'string' ? String(reference) : null,
        httpStatus,
      }
    }
    return {
      kind: 'not_accepted',
      retryable: false,
      code: 'provider_rejected',
      httpStatus,
    }
  }
  if (body.code === 200) {
    return { kind: 'accepted', providerReference: null, httpStatus }
  }
  return {
    kind: 'not_accepted',
    retryable: false,
    code: 'provider_rejected',
    httpStatus,
  }
}

function jsonRequest(
  url: string,
  body: object,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
}

async function readLimitedJson(response: Response): Promise<unknown | null> {
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > PROVIDER_RESPONSE_LIMIT_BYTES) return null
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    length += next.value.byteLength
    if (length > PROVIDER_RESPONSE_LIMIT_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

function requiredOption(options: Record<string, string>, key: string): string {
  const value = options[key]
  if (!value) throw new Error(`通知公开选项缺少 ${key}`)
  return value
}

function requiredCredential(credentials: Record<string, string | null>, key: string): string {
  const value = credentials[key]
  if (!value) throw new Error(`通知凭据缺少 ${key}`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
