import type {
  CreateNotificationSubscriptionRequest,
  NotificationAvailableScope,
  NotificationChannelType,
  NotificationOperationSummary,
  NotificationOverviewResponse,
  NotificationScopeInput,
  NotificationSubscriptionStatus,
  NotificationSubscriptionSummary,
} from '../../../shared/contracts/notifications'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'
import {
  encryptNotificationCredential,
  NotificationCredentialError,
  notificationEncryptionConfigured,
} from './notification-credential'

type NotificationField =
  | 'displayName'
  | 'channelType'
  | 'baseUrl'
  | 'destination'
  | 'credential'
  | 'scopes'
  | 'subscriptionId'

interface SubscriptionRow {
  id: string
  display_name: string
  channel_type: NotificationChannelType
  public_options_json: string
  subscription_status: NotificationSubscriptionStatus
  created_at: number
  updated_at: number
}

interface ScopeRow {
  notification_subscription_id: string
  scope_kind: NotificationScopeInput['kind']
  email_address_id: string | null
  label: string | null
  address: string | null
  organization_name: string | null
}

interface OperationRow {
  id: string
  notification_subscription_id: string
  subscription_name: string
  channel_type: NotificationChannelType
  subject: string
  operation_status: NotificationOperationSummary['status']
  error_code: string | null
  error_summary: string | null
  created_at: number
  completed_at: number | null
}

interface NormalizedSubscriptionInput {
  displayName: string
  channelType: NotificationChannelType
  publicOptions: Record<string, string>
  credential: Record<string, string | null>
  scopes: NotificationScopeInput[]
}

export class NotificationInputError extends Error {
  constructor(
    readonly field: NotificationField,
    message: string,
  ) {
    super(message)
  }
}

export class NotificationAccessError extends Error {
  constructor(
    readonly code: 'not_found' | 'state_conflict',
    message: string,
  ) {
    super(message)
  }
}

export async function getNotificationOverview(options: {
  database: D1Database
  userId: string
  encryptionKeyBase64?: string
}): Promise<NotificationOverviewResponse['data']> {
  const [subscriptions, scopeRows, availableScopes, recentOperations, encryptionConfigured] =
    await Promise.all([
      listSubscriptions(options.database, options.userId),
      listSubscriptionScopes(options.database, options.userId),
      listAvailableScopes(options.database, options.userId),
      listRecentOperations(options.database, options.userId),
      notificationEncryptionConfigured(options.encryptionKeyBase64),
    ])
  return {
    encryptionConfigured,
    subscriptions: subscriptions.map((subscription) =>
      subscriptionSummary(subscription, scopeRows),
    ),
    availableScopes,
    recentOperations: recentOperations.map(operationSummary),
  }
}

export async function createNotificationSubscription(options: {
  database: D1Database
  userId: string
  encryptionKeyBase64?: string
  input: CreateNotificationSubscriptionRequest
  audit: AuditContext
  now?: number
}): Promise<NotificationSubscriptionSummary> {
  const input = normalizeSubscriptionInput(options.input)
  const now = options.now ?? Date.now()
  const id = crypto.randomUUID()
  let encrypted
  try {
    encrypted = await encryptNotificationCredential({
      ...(options.encryptionKeyBase64 ? { encryptionKeyBase64: options.encryptionKeyBase64 } : {}),
      subscriptionId: id,
      credential: input.credential,
    })
  } catch (error) {
    if (error instanceof NotificationCredentialError) {
      throw new NotificationInputError('credential', error.message)
    }
    throw error
  }

  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO notification_subscriptions (
          id, user_id, display_name, channel_type, public_options_json,
          subscription_status, paused_at, deleted_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'active', NULL, NULL, ?6, ?6)`,
      )
      .bind(
        id,
        options.userId,
        input.displayName,
        input.channelType,
        JSON.stringify(input.publicOptions),
        now,
      ),
    options.database
      .prepare(
        `INSERT INTO notification_subscription_secrets (
          notification_subscription_id, credential_ciphertext, credential_nonce,
          credential_algorithm, credential_key_version, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(
        id,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.algorithm,
        encrypted.keyVersion,
        now,
      ),
    ...input.scopes.map((scope) =>
      options.database
        .prepare(
          `INSERT INTO notification_subscription_scopes (
            id, notification_subscription_id, scope_kind, email_address_id, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          scope.kind,
          scope.kind === 'all_personal' ? null : scope.addressId,
          now,
        ),
    ),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName: 'notification_subscription_created',
      targetType: 'notification_subscription',
      targetReference: id,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ]
  try {
    const results = await options.database.batch(statements)
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new NotificationInputError('scopes', '通知订阅没有完整保存')
    }
  } catch (error) {
    if (String(error).includes('通知范围不是用户当前可查看的邮箱地址')) {
      throw new NotificationInputError('scopes', '所选邮箱已经不可用，请刷新后重试')
    }
    throw error
  }
  return readSubscriptionSummary(options.database, options.userId, id)
}

export async function changeNotificationSubscriptionStatus(options: {
  database: D1Database
  userId: string
  subscriptionId: string
  status: 'active' | 'paused'
  audit: AuditContext
  now?: number
}): Promise<NotificationSubscriptionSummary> {
  assertUuid(options.subscriptionId)
  const current = await findSubscription(options.database, options.userId, options.subscriptionId)
  if (!current || current.subscription_status === 'deleted') {
    throw new NotificationAccessError('not_found', '通知订阅不存在')
  }
  const now = options.now ?? Date.now()
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE notification_subscriptions
         SET subscription_status = ?1, paused_at = ?2, updated_at = ?3
         WHERE id = ?4 AND user_id = ?5 AND subscription_status <> 'deleted'`,
      )
      .bind(
        options.status,
        options.status === 'paused' ? now : null,
        now,
        options.subscriptionId,
        options.userId,
      ),
    options.database
      .prepare(
        `UPDATE notification_operations
         SET operation_status = 'cancelled', error_code = 'subscription_inactive',
             error_summary = '通知订阅已暂停', completed_at = ?1, updated_at = ?1
         WHERE notification_subscription_id = ?2 AND operation_status = 'pending'
           AND ?3 = 'paused'`,
      )
      .bind(now, options.subscriptionId, options.status),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName:
        options.status === 'active'
          ? 'notification_subscription_resumed'
          : 'notification_subscription_paused',
      targetType: 'notification_subscription',
      targetReference: options.subscriptionId,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ])
  if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
    throw new NotificationAccessError('state_conflict', '通知订阅已经发生变化，请刷新后重试')
  }
  return readSubscriptionSummary(options.database, options.userId, options.subscriptionId)
}

export async function deleteNotificationSubscription(options: {
  database: D1Database
  userId: string
  subscriptionId: string
  audit: AuditContext
  now?: number
}): Promise<void> {
  assertUuid(options.subscriptionId)
  const current = await findSubscription(options.database, options.userId, options.subscriptionId)
  if (!current || current.subscription_status === 'deleted') {
    throw new NotificationAccessError('not_found', '通知订阅不存在')
  }
  const now = options.now ?? Date.now()
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE notification_subscriptions
         SET subscription_status = 'deleted', deleted_at = ?1, updated_at = ?1
         WHERE id = ?2 AND user_id = ?3 AND subscription_status <> 'deleted'`,
      )
      .bind(now, options.subscriptionId, options.userId),
    options.database
      .prepare(
        `UPDATE notification_operations
         SET operation_status = 'cancelled', error_code = 'subscription_deleted',
             error_summary = '通知订阅已删除', completed_at = ?1, updated_at = ?1
         WHERE notification_subscription_id = ?2 AND operation_status = 'pending'`,
      )
      .bind(now, options.subscriptionId),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.userId,
      actionName: 'notification_subscription_deleted',
      targetType: 'notification_subscription',
      targetReference: options.subscriptionId,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ])
  if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
    throw new NotificationAccessError('state_conflict', '通知订阅已经发生变化，请刷新后重试')
  }
}

async function readSubscriptionSummary(
  database: D1Database,
  userId: string,
  subscriptionId: string,
): Promise<NotificationSubscriptionSummary> {
  const [subscription, scopes] = await Promise.all([
    findSubscription(database, userId, subscriptionId),
    listSubscriptionScopes(database, userId, subscriptionId),
  ])
  if (!subscription) throw new NotificationAccessError('not_found', '通知订阅不存在')
  return subscriptionSummary(subscription, scopes)
}

async function listSubscriptions(database: D1Database, userId: string): Promise<SubscriptionRow[]> {
  const rows = await database
    .prepare(
      `SELECT id, display_name, channel_type, public_options_json,
              subscription_status, created_at, updated_at
       FROM notification_subscriptions
       WHERE user_id = ?1 AND subscription_status <> 'deleted'
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(userId)
    .all<SubscriptionRow>()
  return rows.results
}

function findSubscription(database: D1Database, userId: string, subscriptionId: string) {
  return database
    .prepare(
      `SELECT id, display_name, channel_type, public_options_json,
              subscription_status, created_at, updated_at
       FROM notification_subscriptions
       WHERE id = ?1 AND user_id = ?2 LIMIT 1`,
    )
    .bind(subscriptionId, userId)
    .first<SubscriptionRow>()
}

async function listSubscriptionScopes(
  database: D1Database,
  userId: string,
  subscriptionId?: string,
): Promise<ScopeRow[]> {
  const rows = await database
    .prepare(
      `SELECT scope.notification_subscription_id, scope.scope_kind,
              scope.email_address_id, preference.custom_label AS label,
              address.display_address AS address, organization.name AS organization_name
       FROM notification_subscription_scopes scope
       JOIN notification_subscriptions subscription
         ON subscription.id = scope.notification_subscription_id
        AND subscription.user_id = ?1
       LEFT JOIN email_addresses address ON address.id = scope.email_address_id
       LEFT JOIN user_address_preferences preference
         ON preference.user_id = subscription.user_id
        AND preference.address_id = scope.email_address_id
       LEFT JOIN address_bindings binding
         ON binding.address_id = scope.email_address_id AND binding.ended_at IS NULL
       LEFT JOIN organizations organization ON organization.id = binding.organization_id
       WHERE (?2 IS NULL OR subscription.id = ?2)
       ORDER BY subscription.created_at DESC, scope.scope_kind, address.canonical_address`,
    )
    .bind(userId, subscriptionId ?? null)
    .all<ScopeRow>()
  return rows.results
}

async function listAvailableScopes(
  database: D1Database,
  userId: string,
): Promise<NotificationAvailableScope[]> {
  const rows = await database
    .prepare(
      `SELECT 'personal_address' AS kind, address.id AS address_id,
              COALESCE(NULLIF(preference.custom_label, ''), address.display_address) AS label,
              address.display_address AS address
       FROM address_bindings binding
       JOIN email_addresses address
         ON address.id = binding.address_id AND address.retired_at IS NULL
       LEFT JOIN user_address_preferences preference
         ON preference.user_id = ?1 AND preference.address_id = address.id
       WHERE binding.owner_type = 'user' AND binding.user_id = ?1 AND binding.ended_at IS NULL
       UNION ALL
       SELECT 'organization_address' AS kind, address.id AS address_id,
              organization.name AS label, address.display_address AS address
       FROM organization_memberships membership
       JOIN organizations organization
         ON organization.id = membership.organization_id AND organization.status = 'active'
       JOIN address_bindings binding
         ON binding.organization_id = organization.id
        AND binding.owner_type = 'organization' AND binding.ended_at IS NULL
       JOIN email_addresses address
         ON address.id = binding.address_id AND address.retired_at IS NULL
       WHERE membership.user_id = ?1 AND membership.left_at IS NULL
       ORDER BY kind, address`,
    )
    .bind(userId)
    .all<{
      kind: NotificationAvailableScope['kind']
      address_id: string
      label: string
      address: string
    }>()
  return rows.results.map((row) => ({
    kind: row.kind,
    addressId: row.address_id,
    label: row.label,
    address: row.address,
  }))
}

async function listRecentOperations(database: D1Database, userId: string) {
  const rows = await database
    .prepare(
      `SELECT operation.id, operation.notification_subscription_id,
              subscription.display_name AS subscription_name,
              subscription.channel_type, message.subject,
              operation.operation_status, operation.error_code, operation.error_summary,
              operation.created_at, operation.completed_at
       FROM notification_operations operation
       JOIN notification_subscriptions subscription
         ON subscription.id = operation.notification_subscription_id
        AND subscription.user_id = ?1
       JOIN message_deliveries delivery ON delivery.id = operation.message_delivery_id
       JOIN messages message ON message.id = delivery.message_id
       ORDER BY operation.created_at DESC, operation.id DESC
       LIMIT 30`,
    )
    .bind(userId)
    .all<OperationRow>()
  return rows.results
}

function subscriptionSummary(
  row: SubscriptionRow,
  scopes: ScopeRow[],
): NotificationSubscriptionSummary {
  const publicOptions = parsePublicOptions(row.public_options_json)
  return {
    id: row.id,
    displayName: row.display_name,
    channelType: row.channel_type,
    status: row.subscription_status,
    baseUrl: publicOptions.baseUrl ?? null,
    destination: publicOptions.topic ?? publicOptions.uid ?? publicOptions.chatId ?? null,
    credentialConfigured: true,
    scopes: scopes
      .filter((scope) => scope.notification_subscription_id === row.id)
      .map((scope) => ({
        kind: scope.scope_kind,
        addressId: scope.email_address_id,
        label:
          scope.scope_kind === 'all_personal'
            ? '全部个人邮箱'
            : scope.organization_name || scope.label || scope.address || '已失效地址',
      })),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function operationSummary(row: OperationRow): NotificationOperationSummary {
  return {
    id: row.id,
    subscriptionId: row.notification_subscription_id,
    subscriptionName: row.subscription_name,
    channelType: row.channel_type,
    subject: row.subject,
    status: row.operation_status,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  }
}

function normalizeSubscriptionInput(
  input: CreateNotificationSubscriptionRequest,
): NormalizedSubscriptionInput {
  const displayName = input.displayName.trim()
  if (!displayName || displayName.length > 120) {
    throw new NotificationInputError('displayName', '订阅名称必须为 1 至 120 个字符')
  }
  if (!['ntfy', 'gotify', 'wxpusher', 'telegram', 'bark'].includes(input.channelType)) {
    throw new NotificationInputError('channelType', '通知通道无效')
  }
  const scopes = normalizeScopes(input.scopes)
  const destination = input.destination.trim()
  const credential = input.credential.trim()
  if (input.channelType === 'ntfy') {
    if (!/^[-_A-Za-z0-9]{1,64}$/u.test(destination)) {
      throw new NotificationInputError(
        'destination',
        'ntfy 主题只能包含字母、数字、短横线和下划线，最多 64 个字符',
      )
    }
    return {
      displayName,
      channelType: input.channelType,
      publicOptions: {
        baseUrl: normalizeBaseUrl(input.baseUrl, 'https://ntfy.sh'),
        topic: destination,
      },
      credential: { accessToken: credential || null },
      scopes,
    }
  }
  if (input.channelType === 'gotify') {
    requireCredential(credential)
    return {
      displayName,
      channelType: input.channelType,
      publicOptions: { baseUrl: normalizeBaseUrl(input.baseUrl) },
      credential: { applicationToken: credential },
      scopes,
    }
  }
  if (input.channelType === 'wxpusher') {
    requireCredential(credential)
    if (!destination || destination.length > 256) {
      throw new NotificationInputError('destination', '请填写有效的 WxPusher UID')
    }
    return {
      displayName,
      channelType: input.channelType,
      publicOptions: { uid: destination },
      credential: { appToken: credential },
      scopes,
    }
  }
  if (input.channelType === 'telegram') {
    requireCredential(credential)
    if (!/^\d{5,20}:[A-Za-z0-9_-]{20,128}$/u.test(credential)) {
      throw new NotificationInputError('credential', 'Telegram Bot Token 格式无效')
    }
    if (!/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/u.test(destination)) {
      throw new NotificationInputError('destination', '请填写数字 Chat ID 或有效的频道用户名')
    }
    return {
      displayName,
      channelType: input.channelType,
      publicOptions: { chatId: destination },
      credential: { botToken: credential },
      scopes,
    }
  }
  requireCredential(credential)
  return {
    displayName,
    channelType: input.channelType,
    publicOptions: { baseUrl: normalizeBaseUrl(input.baseUrl, 'https://api.day.app') },
    credential: { deviceKey: credential },
    scopes,
  }
}

function normalizeScopes(scopes: NotificationScopeInput[]): NotificationScopeInput[] {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 100) {
    throw new NotificationInputError('scopes', '请至少选择一个邮件来源')
  }
  const hasAllPersonal = scopes.some((scope) => scope.kind === 'all_personal')
  const normalized: NotificationScopeInput[] = []
  const keys = new Set<string>()
  for (const scope of scopes) {
    if (scope.kind === 'all_personal') {
      if (!keys.has('all_personal')) {
        normalized.push(scope)
        keys.add('all_personal')
      }
      continue
    }
    if (scope.kind !== 'personal_address' && scope.kind !== 'organization_address') {
      throw new NotificationInputError('scopes', '邮件来源类型无效')
    }
    if (hasAllPersonal && scope.kind === 'personal_address') continue
    if (!isUuid(scope.addressId)) {
      throw new NotificationInputError('scopes', '邮件来源编号无效')
    }
    const key = `${scope.kind}:${scope.addressId}`
    if (keys.has(key)) continue
    keys.add(key)
    normalized.push(scope)
  }
  if (normalized.length === 0) throw new NotificationInputError('scopes', '请至少选择一个邮件来源')
  return normalized
}

function normalizeBaseUrl(value: string, fallback?: string): string {
  const source = value.trim() || fallback || ''
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new NotificationInputError('baseUrl', '服务地址无效')
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new NotificationInputError(
      'baseUrl',
      '服务地址必须使用 HTTPS，且不能包含账号、查询参数或片段',
    )
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
}

function requireCredential(value: string): void {
  if (!value || value.length > 4096 || /\s/u.test(value)) {
    throw new NotificationInputError('credential', '请填写不含空白字符的有效凭据')
  }
}

function parsePublicOptions(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

function assertUuid(value: string): void {
  if (!isUuid(value)) throw new NotificationAccessError('not_found', '通知订阅不存在')
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
