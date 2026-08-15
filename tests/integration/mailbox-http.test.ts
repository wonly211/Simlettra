import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import {
  createMailObjectStore,
  processReceiveParsingTask,
  receiveIncomingMail,
  type IncomingEmailMessage,
} from '../../src/modules/mail-receiving/public'
import { processMessageIndexTask } from '../../src/modules/mail-search/public'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'

interface MailboxHttpEnvironment extends Env {
  INIT_KEY: string
  MAIL_OBJECTS_R2: R2Bucket
}

const testEnvironment = env as MailboxHttpEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'

describe('收件箱 HTTP 边界', () => {
  it('通过认证读取列表、详情和附件，并用 CSRF 保护已读写入', async () => {
    await initializeSystem()
    await deliverMail()
    const session = extractAuthenticationCookies(await login())

    const listResponse = await request('/api/auth/mailbox/inbox', { headers: session.headers })
    expect(listResponse.status).toBe(200)
    expect(listResponse.headers.get('content-security-policy')).toContain('img-src')
    const list = await listResponse.json<{
      data: {
        items: Array<{
          id: string
          subject: string
          isRead: boolean
          conversationMessageCount: number
        }>
      }
    }>()
    expect(list.data.items).toHaveLength(1)
    expect(list.data.items[0]).toMatchObject({
      subject: 'HTTP 读信测试',
      isRead: false,
      conversationMessageCount: 1,
    })
    const entryId = list.data.items[0]!.id

    const searchResponse = await request(
      '/api/auth/mailbox/inbox?body=%E6%AD%A3%E6%96%87&sender=outside.test&attachment=with',
      { headers: session.headers },
    )
    expect(searchResponse.status).toBe(200)
    await expect(searchResponse.json()).resolves.toMatchObject({
      data: {
        items: [{ id: entryId, subject: 'HTTP 读信测试' }],
        searchIndex: { status: 'ready', pendingMessageCount: 0 },
      },
    })

    const invalidSearch = await request('/api/auth/mailbox/inbox?body=%E6%AD%A3', {
      headers: session.headers,
    })
    expect(invalidSearch.status).toBe(422)

    const detailResponse = await request(`/api/auth/mailbox/entries/${entryId}`, {
      headers: session.headers,
    })
    expect(detailResponse.status).toBe(200)
    const detail = await detailResponse.json<{
      data: {
        message: {
          plainTextBody: string
          attachments: Array<{ id: string; fileName: string }>
        }
        conversation: { entries: Array<{ id: string }> }
      }
    }>()
    expect(detail.data.message.plainTextBody).toContain('正文内容')
    expect(detail.data.conversation.entries).toEqual([expect.objectContaining({ id: entryId })])
    const safeFileName = detail.data.message.attachments[0]!.fileName
    expect(
      [...safeFileName].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint <= 31 || codePoint === 127 || '\\/:*?"<>|'.includes(character)
      }),
    ).toBe(false)

    const missingCsrf = await request(`/api/auth/mailbox/entries/${entryId}/read`, {
      method: 'POST',
      headers: {
        Cookie: session.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isRead: true }),
    })
    expect(missingCsrf.status).toBe(403)

    const readResponse = await request(`/api/auth/mailbox/entries/${entryId}/read`, {
      method: 'POST',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    })
    expect(readResponse.status).toBe(200)

    const missingActionCsrf = await request('/api/auth/mailbox/actions', {
      method: 'POST',
      headers: {
        Cookie: session.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ entryIds: [entryId], action: 'star' }),
    })
    expect(missingActionCsrf.status).toBe(403)

    const starResponse = await request('/api/auth/mailbox/actions', {
      method: 'POST',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryIds: [entryId], action: 'star' }),
    })
    expect(starResponse.status).toBe(200)
    const starredResponse = await request('/api/auth/mailbox/inbox?view=starred', {
      headers: session.headers,
    })
    expect(starredResponse.status).toBe(200)
    const starred = await starredResponse.json<{ data: { items: Array<{ id: string }> } }>()
    expect(starred.data.items.map((item) => item.id)).toEqual([entryId])

    const attachmentId = detail.data.message.attachments[0]!.id
    const attachmentResponse = await request(
      `/api/auth/mailbox/entries/${entryId}/attachments/${attachmentId}`,
      { headers: session.headers },
    )
    expect(attachmentResponse.status).toBe(200)
    expect(attachmentResponse.headers.get('content-type')).toBe('application/octet-stream')
    const contentDisposition = attachmentResponse.headers.get('content-disposition') ?? ''
    expect(contentDisposition).toContain('attachment')
    expect(contentDisposition).not.toMatch(/[\r\n]/u)
    expect(contentDisposition).not.toContain('../')
    expect(contentDisposition).not.toContain('<script>')
    expect(attachmentResponse.headers.get('x-evil')).toBeNull()
    expect(new TextDecoder().decode(await attachmentResponse.arrayBuffer())).toBe('attachment')

    const trashResponse = await request('/api/auth/mailbox/actions', {
      method: 'POST',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryIds: [entryId], action: 'move_to_trash' }),
    })
    expect(trashResponse.status).toBe(200)

    const missingDeleteCsrf = await request(`/api/auth/mailbox/entries/${entryId}`, {
      method: 'DELETE',
      headers: {
        Cookie: session.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ confirmed: true }),
    })
    expect(missingDeleteCsrf.status).toBe(403)

    const missingConfirmation = await request(`/api/auth/mailbox/entries/${entryId}`, {
      method: 'DELETE',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: false }),
    })
    expect(missingConfirmation.status).toBe(422)

    const deleteResponse = await request(`/api/auth/mailbox/entries/${entryId}`, {
      method: 'DELETE',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    })
    expect(deleteResponse.status).toBe(200)
    await expect(deleteResponse.json()).resolves.toMatchObject({
      data: { entryId, deletionScope: 'personal', physicalCleanupScheduled: true },
    })
    const afterDelete = await request(`/api/auth/mailbox/entries/${entryId}`, {
      headers: session.headers,
    })
    expect(afterDelete.status).toBe(404)
  })
})

async function initializeSystem(): Promise<void> {
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

async function deliverMail(): Promise<void> {
  const messages: BackgroundTaskMessage[] = []
  const raw = new TextEncoder().encode(
    [
      'From: Sender <sender@outside.test>',
      'To: Owner <owner@example.com>',
      'Subject: HTTP 读信测试',
      'Message-ID: <mailbox-http@outside.test>',
      'Date: Wed, 12 Aug 2026 08:00:00 +0800',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="http-boundary"',
      '',
      '--http-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '正文内容。',
      '--http-boundary',
      'Content-Type: text/plain; name="../../evil<script>.txt"',
      'Content-Disposition: attachment; filename="../../evil<script>.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      'YXR0YWNobWVudA==',
      '--http-boundary--',
      '',
    ].join('\r\n'),
  )
  const message = {
    from: 'sender@outside.test',
    to: 'owner@example.com',
    rawSize: raw.byteLength,
    raw: new Blob([raw]).stream(),
    setReject: vi.fn<(reason: string) => void>(),
  } satisfies IncomingEmailMessage
  await receiveIncomingMail({
    database: env.DB,
    queue: {
      send: async (item: BackgroundTaskMessage) => {
        messages.push(item)
      },
    } as unknown as Queue<BackgroundTaskMessage>,
    store: createMailObjectStore(testEnvironment, 'r2'),
    message,
    now: 1_800_000_000_000,
  })
  await processBackgroundTaskMessage({
    database: env.DB,
    message: messages[0]!,
    now: 1_800_000_000_001,
    workerReference: 'mailbox-http-test',
    executeTask: (task) =>
      processReceiveParsingTask({
        database: env.DB,
        store: createMailObjectStore(testEnvironment, 'r2'),
        queue: {
          send: async (item: BackgroundTaskMessage) => {
            messages.push(item)
          },
        } as unknown as Queue<BackgroundTaskMessage>,
        operationId: task.targetReference,
        now: task.now,
      }),
  })
  await processBackgroundTaskMessage({
    database: env.DB,
    message: messages[1]!,
    now: 1_800_000_000_002,
    workerReference: 'mailbox-http-search-test',
    executeTask: (task) =>
      processMessageIndexTask({
        database: env.DB,
        objectStore: createMailObjectStore(testEnvironment, 'r2'),
        messageId: task.targetReference,
        inputVersion: task.inputVersion,
        now: task.now,
      }),
  })
}

function login() {
  return request('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': '203.0.113.60',
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
  const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`
  return { cookie, csrfToken, headers: { Cookie: cookie } }
}

function mutationHeaders(session: ReturnType<typeof extractAuthenticationCookies>) {
  return {
    Cookie: session.cookie,
    Origin: origin,
    [CSRF_HEADER_NAME]: session.csrfToken,
  }
}
