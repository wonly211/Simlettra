import { sha256Bytes } from '../../mail-receiving/domain/content-digest'
import { decryptOutboundSecrets, type OutboundSecrets } from './outbound-management'

const MAX_PROVIDER_EVENT_BYTES = 1_000_000
const RESEND_TIMESTAMP_TOLERANCE_SECONDS = 300

type ProviderType = 'resend' | 'smtp2go'
type NormalizedEventType =
  | 'submitted'
  | 'delayed'
  | 'delivered'
  | 'bounced'
  | 'failed'
  | 'complained'
  | 'opened'
  | 'clicked'
  | 'other'

interface ProviderConfigRow {
  configuration_key: string
  configuration_version: number
  provider_type: ProviderType
  credential_ciphertext: ArrayBuffer
  credential_nonce: ArrayBuffer
}

interface NormalizedProviderEvent {
  eventId: string
  type: NormalizedEventType
  occurredAt: number
  submissionId: string | null
  recipientAddress: string | null
}

interface MatchedRecipientRow {
  attempt_id: string
  recipient_id: string
  delivery_status: string
  status_version: number
  status_updated_at: number
}

export class ProviderEventInputError extends Error {
  constructor(
    readonly code: 'invalid_provider' | 'invalid_path' | 'body_too_large' | 'invalid_body',
    message: string,
  ) {
    super(message)
  }
}

export class ProviderEventAuthorizationError extends Error {}

export async function processOutboundProviderEvent(options: {
  database: D1Database
  encryptionKeyBase64?: string
  providerType: string
  configurationKey: string
  request: Request
  now?: number
}): Promise<{ duplicate: boolean; matched: boolean; applied: boolean }> {
  const providerType = normalizeProviderType(options.providerType)
  if (!isUuid(options.configurationKey)) {
    throw new ProviderEventInputError('invalid_path', '回调地址无效')
  }
  const bytes = new Uint8Array(await options.request.arrayBuffer())
  if (bytes.byteLength > MAX_PROVIDER_EVENT_BYTES) {
    throw new ProviderEventInputError('body_too_large', '回调内容过大')
  }
  let rawText: string
  try {
    rawText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw new ProviderEventInputError('invalid_body', '回调内容不是有效的 UTF-8')
  }
  const now = options.now ?? Date.now()
  const configs = await loadProviderConfigs(
    options.database,
    options.configurationKey,
    providerType,
  )
  if (configs.length === 0) throw new ProviderEventAuthorizationError('回调配置不存在')

  let verified: { config: ProviderConfigRow; secrets: OutboundSecrets } | null = null
  for (const config of configs) {
    const secrets = await decryptOutboundSecrets({
      ...(options.encryptionKeyBase64 ? { encryptionKeyBase64: options.encryptionKeyBase64 } : {}),
      configurationKey: config.configuration_key,
      configurationVersion: config.configuration_version,
      ciphertext: config.credential_ciphertext,
      nonce: config.credential_nonce,
    })
    if (
      await verifyProviderRequest({
        providerType,
        request: options.request,
        rawText,
        secrets,
        now,
      })
    ) {
      verified = { config, secrets }
      break
    }
  }
  if (!verified) throw new ProviderEventAuthorizationError('回调验证失败')

  const event = parseProviderEvent(providerType, options.request.headers, rawText)
  const duplicate = await options.database
    .prepare(
      `SELECT match_status, processing_result FROM outbound_provider_events
       WHERE provider_type = ?1 AND provider_event_id = ?2 LIMIT 1`,
    )
    .bind(providerType, event.eventId)
    .first<{ match_status: string; processing_result: string }>()
  if (duplicate) {
    return {
      duplicate: true,
      matched: duplicate.match_status === 'matched',
      applied: duplicate.processing_result === 'applied',
    }
  }

  const match = event.submissionId
    ? await findMatchedRecipient(
        options.database,
        options.configurationKey,
        verified.config.configuration_version,
        event.submissionId,
        event.recipientAddress,
      )
    : null
  const eventRecordId = crypto.randomUUID()
  const rawDigest = await sha256Bytes(bytes)
  const change = match ? resolveStatusChange(match, event) : { kind: 'none' as const }
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO outbound_provider_events (
          id, provider_type, provider_event_id, normalized_event_type,
          occurred_at, received_at, verified_at, raw_sha256,
          diagnostic_code, diagnostic_summary, outbound_submission_attempt_id,
          send_recipient_id, match_status, processing_result, processed_at, created_at
         ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7,
          NULL, NULL, ?8, ?9, ?10, ?11, ?6, ?6
         )`,
      )
      .bind(
        eventRecordId,
        providerType,
        event.eventId,
        event.type,
        event.occurredAt,
        now,
        rawDigest,
        match?.attempt_id ?? null,
        match?.recipient_id ?? null,
        match ? 'matched' : 'ignored',
        change.kind === 'apply' ? 'applied' : match ? 'no_change' : 'ignored',
      ),
  ]
  if (match && change.kind === 'apply') {
    statements.push(
      options.database
        .prepare(
          `UPDATE send_recipients
           SET delivery_status = ?1, status_version = ?2, status_updated_at = ?3,
               failure_code = ?4, failure_detail = ?5,
               updated_at = ?6
           WHERE id = ?7 AND delivery_status = ?8 AND status_version = ?9`,
        )
        .bind(
          change.status,
          match.status_version + 1,
          change.statusAt,
          change.failureCode,
          change.failureDetail,
          now,
          match.recipient_id,
          match.delivery_status,
          match.status_version,
        ),
      options.database
        .prepare(
          `INSERT INTO send_recipient_status_history (
            id, send_recipient_id, previous_status, new_status, status_version,
            source_type, source_reference, occurred_at, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, 'provider_event', ?6, ?7, ?8)`,
        )
        .bind(
          crypto.randomUUID(),
          match.recipient_id,
          match.delivery_status,
          change.status,
          match.status_version + 1,
          event.eventId,
          event.occurredAt,
          now,
        ),
    )
  } else if (match && event.type === 'complained' && event.occurredAt >= match.status_updated_at) {
    statements.push(
      options.database
        .prepare(
          `UPDATE send_recipients SET complained_at = ?1, updated_at = ?2
           WHERE id = ?3 AND (complained_at IS NULL OR complained_at < ?1)`,
        )
        .bind(event.occurredAt, now, match.recipient_id),
    )
  }
  try {
    await options.database.batch(statements)
  } catch (error) {
    const raced = await options.database
      .prepare(
        `SELECT match_status, processing_result FROM outbound_provider_events
         WHERE provider_type = ?1 AND provider_event_id = ?2 LIMIT 1`,
      )
      .bind(providerType, event.eventId)
      .first<{ match_status: string; processing_result: string }>()
    if (!raced) throw error
    return {
      duplicate: true,
      matched: raced.match_status === 'matched',
      applied: raced.processing_result === 'applied',
    }
  }
  return { duplicate: false, matched: match !== null, applied: change.kind === 'apply' }
}

async function loadProviderConfigs(
  database: D1Database,
  configurationKey: string,
  providerType: ProviderType,
): Promise<ProviderConfigRow[]> {
  const rows = await database
    .prepare(
      `SELECT configuration_key, configuration_version, provider_type,
              credential_ciphertext, credential_nonce
       FROM outbound_provider_configs
       WHERE configuration_key = ?1 AND provider_type = ?2
       ORDER BY configuration_version DESC`,
    )
    .bind(configurationKey, providerType)
    .all<ProviderConfigRow>()
  return rows.results
}

async function verifyProviderRequest(options: {
  providerType: ProviderType
  request: Request
  rawText: string
  secrets: OutboundSecrets
  now: number
}): Promise<boolean> {
  if (options.providerType === 'smtp2go') {
    if (!options.secrets.callbackUsername) return false
    const expected = `Basic ${btoa(`${options.secrets.callbackUsername}:${options.secrets.callbackSecret}`)}`
    return constantTimeTextEqual(options.request.headers.get('authorization') ?? '', expected)
  }
  const id = options.request.headers.get('svix-id')
  const timestampText = options.request.headers.get('svix-timestamp')
  const signatureHeader = options.request.headers.get('svix-signature')
  if (!id || !timestampText || !signatureHeader) return false
  const timestamp = Number(timestampText)
  if (!Number.isSafeInteger(timestamp)) return false
  if (Math.abs(Math.floor(options.now / 1000) - timestamp) > RESEND_TIMESTAMP_TOLERANCE_SECONDS) {
    return false
  }
  const encodedKey = options.secrets.callbackSecret.replace(/^whsec_/u, '')
  let keyBytes: Uint8Array
  try {
    keyBytes = Uint8Array.from(atob(encodedKey), (character) => character.charCodeAt(0))
  } catch {
    return false
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signed = new TextEncoder().encode(`${id}.${timestampText}.${options.rawText}`)
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed))
  return signatureHeader.split(' ').some((item) => {
    const [version, encoded] = item.split(',', 2)
    if (version !== 'v1' || !encoded) return false
    try {
      const actual = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
      return constantTimeBytesEqual(actual, expected)
    } catch {
      return false
    }
  })
}

function parseProviderEvent(
  providerType: ProviderType,
  headers: Headers,
  rawText: string,
): NormalizedProviderEvent {
  const value = parseEventBody(headers.get('content-type') ?? '', rawText)
  if (providerType === 'resend') {
    const data = isRecord(value.data) ? value.data : {}
    return {
      eventId: requiredText(headers.get('svix-id'), 500),
      type: normalizeResendEvent(requiredText(value.type, 100)),
      occurredAt: parseOccurredAt(value.created_at),
      submissionId: optionalText(data.email_id, 500),
      recipientAddress: Array.isArray(data.to)
        ? optionalText(data.to[0], 320)
        : optionalText(data.to, 320),
    }
  }
  return {
    eventId: requiredText(value.id, 500),
    type: normalizeSmtp2goEvent(requiredText(value.event, 100)),
    occurredAt: parseOccurredAt(value.time),
    submissionId: optionalText(value.email_id, 500),
    recipientAddress: optionalText(value.rcpt, 320),
  }
}

function parseEventBody(contentType: string, rawText: string): Record<string, unknown> {
  try {
    if (contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(rawText))
    }
    const value: unknown = JSON.parse(rawText)
    if (isRecord(value)) return value
  } catch {
    // 统一映射为不可信回调格式错误。
  }
  throw new ProviderEventInputError('invalid_body', '回调内容格式无效')
}

async function findMatchedRecipient(
  database: D1Database,
  configurationKey: string,
  configurationVersion: number,
  submissionId: string,
  recipientAddress: string | null,
): Promise<MatchedRecipientRow | null> {
  return database
    .prepare(
      `SELECT attempt.id AS attempt_id, recipient.id AS recipient_id,
              recipient.delivery_status, recipient.status_version, recipient.status_updated_at
       FROM outbound_submission_attempts attempt
       JOIN outbound_route_snapshot_entries entry ON entry.id = attempt.route_snapshot_entry_id
       JOIN outbound_submission_attempt_recipients link
         ON link.outbound_submission_attempt_id = attempt.id
       JOIN send_recipients recipient ON recipient.id = link.send_recipient_id
       WHERE entry.configuration_key = ?1 AND entry.configuration_version = ?2
         AND attempt.provider_submission_id = ?3
         AND (?4 IS NULL OR recipient.canonical_address = lower(?4))
       ORDER BY attempt.created_at DESC LIMIT 1`,
    )
    .bind(configurationKey, configurationVersion, submissionId, recipientAddress?.trim() ?? null)
    .first<MatchedRecipientRow>()
}

function resolveStatusChange(
  recipient: MatchedRecipientRow,
  event: NormalizedProviderEvent,
):
  | { kind: 'none' }
  | {
      kind: 'apply'
      status: string
      statusAt: number
      failureCode: string | null
      failureDetail: string | null
    } {
  if (event.occurredAt + 999 < recipient.status_updated_at) return { kind: 'none' }
  const target =
    event.type === 'complained' ||
    event.type === 'opened' ||
    event.type === 'clicked' ||
    event.type === 'other'
      ? null
      : event.type
  if (!target || target === recipient.delivery_status) return { kind: 'none' }
  const terminal = new Set(['delivered', 'bounced', 'failed'])
  if (terminal.has(recipient.delivery_status)) return { kind: 'none' }
  const allowed = new Set(['submitted', 'delayed', 'delivered', 'bounced', 'failed'])
  if (!allowed.has(target)) return { kind: 'none' }
  return {
    kind: 'apply',
    status: target,
    statusAt: Math.max(event.occurredAt, recipient.status_updated_at),
    failureCode:
      target === 'bounced' ? 'provider_bounced' : target === 'failed' ? 'provider_failed' : null,
    failureDetail: target === 'bounced' || target === 'failed' ? '域外发信服务报告投递失败' : null,
  }
}

function normalizeResendEvent(value: string): NormalizedEventType {
  const map: Record<string, NormalizedEventType> = {
    'email.sent': 'submitted',
    'email.delivery_delayed': 'delayed',
    'email.delivered': 'delivered',
    'email.bounced': 'bounced',
    'email.failed': 'failed',
    'email.suppressed': 'failed',
    'email.complained': 'complained',
    'email.opened': 'opened',
    'email.clicked': 'clicked',
  }
  return map[value] ?? 'other'
}

function normalizeSmtp2goEvent(value: string): NormalizedEventType {
  const map: Record<string, NormalizedEventType> = {
    processed: 'submitted',
    delivered: 'delivered',
    bounce: 'bounced',
    reject: 'failed',
    spam: 'complained',
    open: 'opened',
    click: 'clicked',
  }
  return map[value.toLowerCase()] ?? 'other'
}

function parseOccurredAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000)
  }
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && value.trim()) {
      return numeric > 10_000_000_000 ? Math.trunc(numeric) : Math.trunc(numeric * 1000)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new ProviderEventInputError('invalid_body', '回调事件时间无效')
}

function requiredText(value: unknown, maximumLength: number): string {
  const result = optionalText(value, maximumLength)
  if (!result) throw new ProviderEventInputError('invalid_body', '回调缺少必要字段')
  return result
}

function optionalText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null
  const result = value.trim()
  return result ? result.slice(0, maximumLength) : null
}

function normalizeProviderType(value: string): ProviderType {
  if (value === 'resend' || value === 'smtp2go') return value
  throw new ProviderEventInputError('invalid_provider', '回调服务类型无效')
}

function constantTimeTextEqual(left: string, right: string): boolean {
  return constantTimeBytesEqual(new TextEncoder().encode(left), new TextEncoder().encode(right))
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
