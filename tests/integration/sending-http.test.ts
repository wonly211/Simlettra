import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'

interface SendingTestEnvironment extends Env {
  INIT_KEY: string
}

const testEnvironment = env as SendingTestEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'

describe('正式发信 HTTP 边界', { timeout: 45_000 }, () => {
  it('一封内部邮件原子建立已发送和收件条目，并安全重放同一请求', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    await createNotificationSubscription(session)
    const draft = await createAndSaveDraft(session, [
      { role: 'to', displayName: '自己', address: 'owner@example.com' },
      { role: 'cc', displayName: null, address: 'OWNER@example.com' },
    ])
    const requestKey = crypto.randomUUID()
    const response = await send(draft.id, draft.revisionNumber, requestKey, session)
    expect(response.status).toBe(202)
    const result = await response.json<{
      data: {
        replayed: boolean
        send: {
          id: string
          workflowStatus: string
          payloadSizeBytes: number
          recipients: Array<{ address: string; channel: string; status: string }>
        }
      }
    }>()
    expect(result.data.replayed).toBe(false)
    expect(result.data.send.workflowStatus).toBe('finished')
    expect(result.data.send.recipients).toMatchObject([
      { address: 'owner@example.com', channel: 'internal', status: 'delivered' },
    ])
    expect(result.data.send.recipients).toHaveLength(1)
    await expect(logicalUsage(await currentAdministratorId())).resolves.toEqual({
      committed_bytes: result.data.send.payloadSizeBytes,
      reserved_bytes: 0,
    })

    const sentMailboxResponse = await request('/api/auth/mailbox/inbox?view=sent', {
      headers: { Cookie: session.cookie },
    })
    expect(sentMailboxResponse.status).toBe(200)
    await expect(sentMailboxResponse.json()).resolves.toMatchObject({
      data: {
        items: [
          {
            entryKind: 'sent',
            actualDeliveryAddresses: ['owner@example.com'],
          },
        ],
      },
    })

    const replay = await send(draft.id, draft.revisionNumber, requestKey, session)
    expect(replay.status).toBe(202)
    await expect(replay.json()).resolves.toMatchObject({
      data: { replayed: true, send: { id: result.data.send.id } },
    })

    const counts = await Promise.all([
      count('messages'),
      count('send_operations'),
      count('send_recipients'),
      count('message_deliveries'),
      count('mailbox_entries'),
      count('domain_monthly_usage_reservations'),
    ])
    expect(counts).toEqual([1, 1, 1, 1, 2, 1])
    expect(await count('notification_operations')).toBe(1)
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM background_tasks WHERE task_type = 'send_notification'`,
      ).first(),
    ).toEqual({ count: 1 })
    const draftStatus = await env.DB.prepare(`SELECT status FROM drafts WHERE id = ?1`)
      .bind(draft.id)
      .first<{ status: string }>()
    expect(draftStatus?.status).toBe('consumed')
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('站外收件人在缺少域名发信路线时整次拒绝，不产生半封邮件', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const draft = await createAndSaveDraft(session, [
      { role: 'to', displayName: null, address: 'reader+news@example.net' },
    ])
    const response = await send(draft.id, draft.revisionNumber, crypto.randomUUID(), session)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'external_route_missing' },
    })
    expect(await count('messages')).toBe(0)
    expect(await count('send_operations')).toBe(0)
    expect(
      (
        await env.DB.prepare(`SELECT status FROM drafts WHERE id = ?1`)
          .bind(draft.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe('active')
  })

  it('同一草稿被并发发送时只允许一项操作成功', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const draft = await createAndSaveDraft(session, [
      { role: 'to', displayName: null, address: 'owner@example.com' },
    ])
    const responses = await Promise.all([
      send(draft.id, draft.revisionNumber, crypto.randomUUID(), session),
      send(draft.id, draft.revisionNumber, crypto.randomUUID(), session),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409])
    expect(await count('messages')).toBe(1)
    expect(await count('send_operations')).toBe(1)
  })

  it('同一主体的多个地址只计一次，满额的其他内部主体单独失败', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const fullUserId = await insertFullRecipient()
    const quotaResponse = await request(`/api/auth/admin/storage-quotas/user/${fullUserId}`, {
      method: 'PUT',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ limitBytes: 1_000_000 }),
    })
    expect(quotaResponse.status).toBe(200)
    const draft = await createAndSaveDraft(session, [
      { role: 'to', displayName: null, address: 'owner@example.com' },
      { role: 'cc', displayName: null, address: 'full@example.com' },
    ])
    const response = await send(draft.id, draft.revisionNumber, crypto.randomUUID(), session)
    expect(response.status).toBe(202)
    const result = await response.json<{
      data: {
        send: {
          payloadSizeBytes: number
          recipients: Array<{ address: string; status: string; failureCode: string | null }>
        }
      }
    }>()
    expect(result.data.send.recipients).toMatchObject([
      { address: 'owner@example.com', status: 'delivered', failureCode: null },
      {
        address: 'full@example.com',
        status: 'failed',
        failureCode: 'storage_quota_exceeded',
      },
    ])
    await expect(logicalUsage(await currentAdministratorId())).resolves.toEqual({
      committed_bytes: result.data.send.payloadSizeBytes,
      reserved_bytes: 0,
    })
    await expect(logicalUsage(fullUserId)).resolves.toEqual({
      committed_bytes: 1_000_000,
      reserved_bytes: 0,
    })
    expect(await count('send_recipients')).toBe(1)
    expect(await count('internal_delivery_rejections')).toBe(1)
  })
})

async function createAndSaveDraft(
  session: ReturnType<typeof extractAuthenticationCookies>,
  recipients: Array<{ role: 'to' | 'cc' | 'bcc'; displayName: string | null; address: string }>,
) {
  const createResponse = await request('/api/auth/drafts', {
    method: 'POST',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: '{}',
  })
  const created = await createResponse.json<{
    data: { draft: { id: string; revisionNumber: number; senderAddressId: string } }
  }>()
  const saveResponse = await request(`/api/auth/drafts/${created.data.draft.id}`, {
    method: 'PUT',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mutationKey: crypto.randomUUID(),
      expectedRevisionNumber: created.data.draft.revisionNumber,
      senderAddressId: created.data.draft.senderAddressId,
      subject: '内部直投测试',
      bodyFormat: 'plain_text',
      body: '这封邮件不经过外部发信服务。',
      recipients,
      attachmentIds: [],
    }),
  })
  expect(saveResponse.status).toBe(200)
  const saved = await saveResponse.json<{
    data: { draft: { id: string; revisionNumber: number } }
  }>()
  return saved.data.draft
}

function send(
  draftId: string,
  revisionNumber: number,
  requestKey: string,
  session: ReturnType<typeof extractAuthenticationCookies>,
) {
  return request(`/api/auth/drafts/${draftId}/send`, {
    method: 'POST',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestKey, expectedRevisionNumber: revisionNumber }),
  })
}

async function createNotificationSubscription(
  session: ReturnType<typeof extractAuthenticationCookies>,
): Promise<void> {
  const response = await request('/api/auth/notifications', {
    method: 'POST',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: '内部直投通知',
      channelType: 'ntfy',
      baseUrl: 'https://ntfy.example.com',
      destination: 'simlettra_mail',
      credential: '',
      scopes: [{ kind: 'all_personal' }],
    }),
  })
  expect(response.status).toBe(201)
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number
  }>()
  return row?.count ?? 0
}

async function insertFullRecipient(): Promise<string> {
  const userId = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, status, display_name, timezone, invitation_policy,
         deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
       ) VALUES (?1, 'active', '满额用户', 'Asia/Shanghai', 'manual',
         NULL, NULL, NULL, 100, 100)`,
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO email_addresses (
         id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
       ) SELECT 'full-address', id, 'full@example.com', 'full@example.com', NULL, 100, NULL
         FROM mail_domains WHERE canonical_name = 'example.com'`,
    ),
    env.DB.prepare(
      `INSERT INTO address_claims (
         canonical_address, address_id, status, reserved_until, created_at, updated_at
       ) VALUES ('full@example.com', 'full-address', 'active', NULL, 100, 100)`,
    ),
    env.DB.prepare(
      `INSERT INTO address_bindings (
         id, address_id, owner_type, user_id, organization_id,
         address_role, started_at, ended_at, ended_reason
       ) VALUES ('full-binding', 'full-address', 'user', ?1, NULL,
         'primary', 100, NULL, NULL)`,
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO logical_storage_usage_entries (
         id, storage_usage_account_id, storage_reservation_id, entry_kind,
         owner_reference, bytes_delta, idempotency_key_digest, committed_at, created_at
       ) SELECT ?1, account.id, NULL, 'manual_adjustment',
                'test:full-user', 1000000, randomblob(32), 100, 100
         FROM logical_storage_usage_accounts AS account
         WHERE account.storage_mode = 'r2' AND account.owner_type = 'user'
           AND account.user_id = ?2`,
    ).bind(crypto.randomUUID(), userId),
  ])
  return userId
}

function logicalUsage(userId: string) {
  return env.DB.prepare(
    `SELECT committed_bytes, reserved_bytes FROM logical_storage_usage_accounts
     WHERE storage_mode = 'r2' AND owner_type = 'user' AND user_id = ?1`,
  )
    .bind(userId)
    .first<{ committed_bytes: number; reserved_bytes: number }>()
}

async function currentAdministratorId(): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT current_admin_user_id FROM system_instances WHERE singleton_id = 1`,
  ).first<{ current_admin_user_id: string }>()
  if (!row) throw new Error('系统管理员不存在')
  return row.current_admin_user_id
}

async function initializeSystem() {
  const response = await request('/api/initialization/complete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Simlettra-Init-Key': encodeInitializationKeyHeader(testEnvironment.INIT_KEY),
    },
    body: JSON.stringify({
      adminDisplayName: '系统管理员',
      domainName: 'example.com',
      localPart: 'owner',
      password,
      timezone: 'Asia/Shanghai',
    }),
  })
  expect(response.status).toBe(201)
}

function login() {
  return request('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': '203.0.113.90',
      'Content-Type': 'application/json',
      Origin: origin,
      'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
    },
    body: JSON.stringify({ email: 'owner@example.com', password }),
  })
}

function request(path: string, init?: RequestInit) {
  return workerExports.default.fetch(new Request(`${origin}${path}`, init))
}

function extractAuthenticationCookies(response: Response) {
  const header = response.headers.get('set-cookie') ?? ''
  const sessionToken = header.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
  const csrfToken = header.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
  if (!sessionToken || !csrfToken) throw new Error('登录响应缺少认证 Cookie')
  return {
    cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
    csrfToken,
  }
}

function mutationHeaders(session: ReturnType<typeof extractAuthenticationCookies>) {
  return { Cookie: session.cookie, Origin: origin, [CSRF_HEADER_NAME]: session.csrfToken }
}
