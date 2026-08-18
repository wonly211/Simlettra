import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import type { InboundControlOverviewResponse } from '../../src/shared/contracts/inbound-control'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type {
  ClaimUnallocatedAddressResponse,
  UnallocatedMailDetailResponse,
  UnallocatedMailListResponse,
} from '../../src/shared/contracts/unallocated-mail'
import {
  createMailObjectStore,
  processReceiveParsingTask,
  receiveIncomingMail,
  type IncomingEmailMessage,
} from '../../src/modules/mail-receiving/public'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'

interface UnallocatedHttpEnvironment extends Env {
  INIT_KEY: string
  MAIL_OBJECTS_R2: R2Bucket
}

const testEnvironment = env as UnallocatedHttpEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'

describe('全域收信与未分配来信 HTTP 边界', { timeout: 45_000 }, () => {
  it('管理员授权后可查看和认领，撤销授权立即失效且认领受 CSRF 保护', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const overview = await getInboundOverview(session)
    const domainId = overview.data.domains[0]!.id
    const administratorId = overview.data.users[0]!.id

    const enabled = await jsonRequest(
      `/api/auth/administrator/inbound/domains/${domainId}/catch-all`,
      {
        method: 'PUT',
        headers: mutationHeaders(session),
        body: { mode: 'unallocated' },
      },
    )
    expect(enabled.status).toBe(200)
    const granted = await jsonRequest(
      `/api/auth/administrator/inbound/domains/${domainId}/access/${administratorId}`,
      {
        method: 'PUT',
        headers: mutationHeaders(session),
        body: { enabled: true },
      },
    )
    expect(granted.status).toBe(200)

    await deliverUnknownMail()
    const listResponse = await request('/api/auth/mailbox/unallocated', {
      headers: session.headers,
    })
    expect(listResponse.status).toBe(200)
    const list = await listResponse.json<UnallocatedMailListResponse>()
    expect(list.data.items).toHaveLength(1)
    expect(list.data.items[0]).toMatchObject({
      subject: '未分配来信测试',
      actualDeliveryAddress: 'unknown@example.com',
      attachmentCount: 1,
    })
    const item = list.data.items[0]!

    const detailResponse = await request(`/api/auth/mailbox/unallocated/${item.deliveryId}`, {
      headers: session.headers,
    })
    expect(detailResponse.status).toBe(200)
    const detail = await detailResponse.json<UnallocatedMailDetailResponse>()
    expect(detail.data.message.plainTextBody).toContain('未分配正文')
    const attachmentId = detail.data.message.attachments[0]!.id
    const attachmentResponse = await request(
      `/api/auth/mailbox/unallocated/${item.deliveryId}/attachments/${attachmentId}`,
      { headers: session.headers },
    )
    expect(attachmentResponse.status).toBe(200)
    expect(new TextDecoder().decode(await attachmentResponse.arrayBuffer())).toBe('attachment')

    const revoked = await jsonRequest(
      `/api/auth/administrator/inbound/domains/${domainId}/access/${administratorId}`,
      {
        method: 'PUT',
        headers: mutationHeaders(session),
        body: { enabled: false },
      },
    )
    expect(revoked.status).toBe(200)
    await expect(
      (await request('/api/auth/mailbox/unallocated', { headers: session.headers })).json(),
    ).resolves.toEqual({ data: { items: [], nextCursor: null } })
    expect(
      (
        await request(`/api/auth/mailbox/unallocated/${item.deliveryId}`, {
          headers: session.headers,
        })
      ).status,
    ).toBe(404)

    await jsonRequest(
      `/api/auth/administrator/inbound/domains/${domainId}/access/${administratorId}`,
      {
        method: 'PUT',
        headers: mutationHeaders(session),
        body: { enabled: true },
      },
    )
    const missingCsrf = await jsonRequest(
      `/api/auth/mailbox/unallocated/periods/${item.periodId}/claim`,
      {
        method: 'POST',
        headers: session.headers,
        body: { confirmed: true },
      },
    )
    expect(missingCsrf.status).toBe(403)

    const claimResponse = await jsonRequest(
      `/api/auth/mailbox/unallocated/periods/${item.periodId}/claim`,
      {
        method: 'POST',
        headers: mutationHeaders(session),
        body: { confirmed: true },
      },
    )
    const claimPayload = await claimResponse.json<
      ClaimUnallocatedAddressResponse | { error: { code: string; message: string } }
    >()
    expect(claimResponse.status, JSON.stringify(claimPayload)).toBe(200)
    const claim = claimPayload as ClaimUnallocatedAddressResponse
    expect(claim.data).toMatchObject({
      periodId: item.periodId,
      address: 'unknown@example.com',
      claimedAlias: {
        address: 'unknown@example.com',
        role: 'alias',
        isDefaultSender: false,
      },
      claimedMessageCount: 1,
      newlyAddedMessageCount: 1,
    })
    expect(claim.data.chargedBytes).toBeGreaterThan(0)

    const afterClaim = await request('/api/auth/mailbox/unallocated', { headers: session.headers })
    await expect(afterClaim.json()).resolves.toEqual({ data: { items: [], nextCursor: null } })
    const mailbox = await request('/api/auth/mailbox/inbox?scope=personal', {
      headers: session.headers,
    })
    await expect(mailbox.json()).resolves.toMatchObject({
      data: {
        items: [
          expect.objectContaining({
            subject: '未分配来信测试',
            actualDeliveryAddresses: ['unknown@example.com'],
          }),
        ],
      },
    })
    const personalAddresses = await request('/api/auth/personal-addresses', {
      headers: session.headers,
    })
    await expect(personalAddresses.json()).resolves.toMatchObject({
      data: {
        policy: { aliasUsed: 1 },
        addresses: expect.arrayContaining([
          expect.objectContaining({
            address: 'unknown@example.com',
            role: 'alias',
          }),
        ]),
      },
    })
    await expect(
      env.DB.prepare(
        `SELECT address_role FROM address_bindings
         WHERE address_id = ?1 AND user_id = ?2 AND ended_at IS NULL`,
      )
        .bind(claim.data.addressId, administratorId)
        .first<{ address_role: string }>(),
    ).resolves.toEqual({ address_role: 'alias' })
    const usage = await env.DB.prepare(
      `SELECT committed_bytes, reserved_bytes FROM logical_storage_usage_accounts
       WHERE owner_type = 'user' AND user_id = ?1 AND storage_mode = 'r2'`,
    )
      .bind(administratorId)
      .first<{ committed_bytes: number; reserved_bytes: number }>()
    expect(usage).toEqual({ committed_bytes: claim.data.chargedBytes, reserved_bytes: 0 })
    const pendingTasks = await env.DB.prepare(
      `SELECT task_type, input_version FROM background_tasks
       WHERE target_reference = ?1 AND input_version = 2 ORDER BY task_type`,
    )
      .bind(item.messageId)
      .all<{ task_type: string; input_version: number }>()
    expect(pendingTasks.results).toEqual([
      { task_type: 'index_message', input_version: 2 },
      { task_type: 'rebuild_conversation', input_version: 2 },
    ])
    expect(await countAuditEvents('inbound_catch_all.changed')).toBe(1)
    expect(await countAuditEvents('unallocated_access.granted')).toBe(2)
    expect(await countAuditEvents('unallocated_access.revoked')).toBe(1)
    expect(await countAuditEvents('unallocated_address.claimed')).toBe(1)
  })
})

async function initializeSystem() {
  const response = await jsonRequest('/api/initialization/complete', {
    method: 'POST',
    headers: {
      'X-Simlettra-Init-Key': encodeInitializationKeyHeader(testEnvironment.INIT_KEY),
    },
    body: {
      adminDisplayName: '系统管理员',
      domainName: 'example.com',
      localPart: 'owner',
      password,
      timezone: 'Asia/Shanghai',
    },
  })
  expect(response.status).toBe(201)
}

async function deliverUnknownMail() {
  const messages: BackgroundTaskMessage[] = []
  const raw = new TextEncoder().encode(
    [
      'From: Sender <sender@outside.test>',
      'To: Unknown <unknown@example.com>',
      'Subject: 未分配来信测试',
      'Message-ID: <unallocated-http@outside.test>',
      'Date: Thu, 13 Aug 2026 08:00:00 +0800',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="unallocated-boundary"',
      '',
      '--unallocated-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '未分配正文。',
      '--unallocated-boundary',
      'Content-Type: text/plain; name="note.txt"',
      'Content-Disposition: attachment; filename="note.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      'YXR0YWNobWVudA==',
      '--unallocated-boundary--',
      '',
    ].join('\r\n'),
  )
  const message = {
    from: 'sender@outside.test',
    to: 'unknown@example.com',
    rawSize: raw.byteLength,
    raw: new Blob([raw]).stream(),
    setReject: vi.fn<(reason: string) => void>(),
  } satisfies IncomingEmailMessage
  await receiveIncomingMail({
    database: env.DB,
    queue: {
      send: async (item: BackgroundTaskMessage) => messages.push(item),
    } as unknown as Queue<BackgroundTaskMessage>,
    store: createMailObjectStore(testEnvironment, 'r2'),
    message,
    now: 1_800_100_000_000,
  })
  await processBackgroundTaskMessage({
    database: env.DB,
    message: messages[0]!,
    now: 1_800_100_000_001,
    workerReference: 'unallocated-http-test',
    executeTask: (task) =>
      processReceiveParsingTask({
        database: env.DB,
        store: createMailObjectStore(testEnvironment, 'r2'),
        operationId: task.targetReference,
        now: task.now,
      }),
  })
}

async function getInboundOverview(session: ReturnType<typeof extractAuthenticationCookies>) {
  const response = await request('/api/auth/administrator/inbound', { headers: session.headers })
  expect(response.status).toBe(200)
  return response.json<InboundControlOverviewResponse>()
}

function login() {
  return jsonRequest('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': '203.0.113.180',
      'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
    },
    body: { email: 'owner@example.com', password },
  })
}

function request(path: string, init?: RequestInit) {
  return workerExports.default.fetch(new Request(`${origin}${path}`, init))
}

function jsonRequest(
  path: string,
  options: Omit<RequestInit, 'body'> & { body?: Record<string, unknown> },
) {
  const { body, ...requestOptions } = options
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  if (!headers.has('Origin')) headers.set('Origin', origin)
  return request(path, {
    ...requestOptions,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

function extractAuthenticationCookies(response: Response) {
  const header = response.headers.get('set-cookie') ?? ''
  const sessionToken = header.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
  const csrfToken = header.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
  if (!sessionToken || !csrfToken) throw new Error('登录响应缺少认证 Cookie')
  const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`
  return { cookie, csrfToken, headers: { Cookie: cookie } }
}

function mutationHeaders(session: ReturnType<typeof extractAuthenticationCookies>) {
  return {
    Cookie: session.cookie,
    Origin: origin,
    [CSRF_HEADER_NAME]: session.csrfToken,
    'CF-Connecting-IP': '203.0.113.180',
    'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
  }
}

async function countAuditEvents(actionName: string) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM audit_events WHERE action_name = ?1',
  )
    .bind(actionName)
    .first<{ count: number }>()
  return row?.count ?? 0
}
