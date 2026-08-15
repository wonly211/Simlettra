import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  createMailObjectStore,
  processReceiveParsingTask,
  receiveIncomingMail,
  type IncomingEmailMessage,
} from '../../src/modules/mail-receiving/public'
import { processNotificationTask } from '../../src/modules/notifications/public'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'

interface NotificationTestEnvironment extends Env {
  INIT_KEY: string
  CONFIG_KEY: string
  MAIL_OBJECTS_R2: R2Bucket
}

interface CapturedQueue {
  binding: Queue<BackgroundTaskMessage>
  messages: BackgroundTaskMessage[]
}

const testEnvironment = env as NotificationTestEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'
const receivedAt = Date.now() - 60_000

describe('外部通知 HTTP 与邮件纵向闭环', { timeout: 45_000 }, () => {
  it('用户建立、暂停、恢复和删除自己的加密通知订阅', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())

    const overviewResponse = await request('/api/auth/notifications', {
      headers: { Cookie: session.cookie },
    })
    expect(overviewResponse.status).toBe(200)
    await expect(overviewResponse.json()).resolves.toMatchObject({
      data: {
        encryptionConfigured: true,
        subscriptions: [],
        availableScopes: [{ kind: 'personal_address', address: 'owner@example.com' }],
      },
    })

    const missingCsrf = await request('/api/auth/notifications', {
      method: 'POST',
      headers: { Cookie: session.cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(notificationInput()),
    })
    expect(missingCsrf.status).toBe(403)

    const createResponse = await createSubscription(session)
    expect(createResponse.status).toBe(201)
    const created = await createResponse.json<{
      data: { subscription: { id: string; status: string; credentialConfigured: boolean } }
    }>()
    expect(created.data.subscription).toMatchObject({
      status: 'active',
      credentialConfigured: true,
    })
    expect(JSON.stringify(created)).not.toContain('ntfy-test-token')

    const stored = await env.DB.prepare(
      `SELECT subscription.public_options_json,
              hex(secret.credential_ciphertext) AS credential_ciphertext_hex
       FROM notification_subscriptions subscription
       JOIN notification_subscription_secrets secret
         ON secret.notification_subscription_id = subscription.id
       WHERE subscription.id = ?1`,
    )
      .bind(created.data.subscription.id)
      .first<{ public_options_json: string; credential_ciphertext_hex: string }>()
    expect(stored?.public_options_json).not.toContain('ntfy-test-token')
    expect(stored?.credential_ciphertext_hex).not.toBe(
      bytesToHex(new TextEncoder().encode('ntfy-test-token')),
    )

    const pause = await request(`/api/auth/notifications/${created.data.subscription.id}/status`, {
      method: 'POST',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    })
    expect(pause.status).toBe(200)
    await expect(pause.json()).resolves.toMatchObject({
      data: { subscription: { status: 'paused' } },
    })

    const resume = await request(`/api/auth/notifications/${created.data.subscription.id}/status`, {
      method: 'POST',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    expect(resume.status).toBe(200)

    const deletion = await request(`/api/auth/notifications/${created.data.subscription.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(session),
    })
    expect(deletion.status).toBe(200)
    const finalOverview = await request('/api/auth/notifications', {
      headers: { Cookie: session.cookie },
    })
    await expect(finalOverview.json()).resolves.toMatchObject({ data: { subscriptions: [] } })
    const auditCount = await scalar<number>(
      `SELECT COUNT(*) FROM audit_events WHERE target_type = 'notification_subscription'`,
    )
    expect(auditCount).toBe(4)
  })

  it('完整 HTML 来信建立独立任务，只把安全可见正文推送到 ntfy', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    expect((await createSubscription(session)).status).toBe(201)
    const queue = createCapturedQueue()
    const result = await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: incomingMessage(htmlMessageWithAttachment()),
      now: receivedAt,
    })
    expect(result.status).toBe('accepted')
    await processReceiveTask(queue.messages[0]!, queue, receivedAt + 1)

    expect(await scalar<number>(`SELECT COUNT(*) FROM notification_operations`)).toBe(1)
    const task = await notificationTask()
    let outboundRequest: Request | null = null
    const fetcher = vi.fn<typeof fetch>(async (request) => {
      outboundRequest = new Request(request)
      return new Response(JSON.stringify({ event: 'message', id: 'ntfy-message-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    await processNotificationBackgroundTask(task, fetcher, receivedAt + 2)

    expect(
      await env.DB.prepare(
        `SELECT operation_status, error_code, error_summary FROM notification_operations`,
      ).first(),
    ).toEqual({ operation_status: 'submitted', error_code: null, error_summary: null })
    expect(fetcher).toHaveBeenCalledOnce()
    const notificationBody = await outboundRequest!.json<{ message: string }>()
    expect(notificationBody.message).toContain('发件人：外部联系人 <sender@example.net>')
    expect(notificationBody.message).toContain('收件人：owner@example.com')
    expect(notificationBody.message).toContain('主题：安全通知测试')
    expect(notificationBody.message).toContain('这是安全可见正文')
    expect(notificationBody.message).not.toContain('alert(')
    expect(notificationBody.message).not.toContain('附件中的秘密')
    expect(await scalar<string>(`SELECT operation_status FROM notification_operations`)).toBe(
      'submitted',
    )
    expect(await scalar<number>(`SELECT COUNT(*) FROM mailbox_entries`)).toBe(1)
    expect(
      await scalar<number>(
        `SELECT COUNT(*) FROM object_registry
         WHERE object_role = 'attachment' AND object_status = 'active'`,
      ),
    ).toBe(1)

    const overview = await request('/api/auth/notifications', {
      headers: { Cookie: session.cookie },
    })
    await expect(overview.json()).resolves.toMatchObject({
      data: { recentOperations: [{ subject: '安全通知测试', status: 'submitted' }] },
    })
  })

  it('完整正文超过 ntfy 上限时不调用外部服务，原邮件仍可读取', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    expect((await createSubscription(session)).status).toBe(201)
    const queue = createCapturedQueue()
    await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: incomingMessage(plainMessage('长正文测试', '信'.repeat(5_000))),
      now: receivedAt,
    })
    await processReceiveTask(queue.messages[0]!, queue, receivedAt + 1)
    const fetcher = vi.fn<typeof fetch>()
    await processNotificationBackgroundTask(await notificationTask(), fetcher, receivedAt + 2)

    expect(fetcher).not.toHaveBeenCalled()
    expect(
      await env.DB.prepare(
        `SELECT operation_status, error_code FROM notification_operations`,
      ).first(),
    ).toEqual({ operation_status: 'failed', error_code: 'ntfy_message_too_large' })
    const inbox = await request('/api/auth/mailbox/inbox', { headers: { Cookie: session.cookie } })
    expect(inbox.status).toBe(200)
    await expect(inbox.json()).resolves.toMatchObject({
      data: { items: [{ subject: '长正文测试' }] },
    })
  })

  it('订阅暂停会取消尚未提交的通知，任务不会访问外部服务', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const created = await (
      await createSubscription(session)
    ).json<{
      data: { subscription: { id: string } }
    }>()
    const queue = createCapturedQueue()
    await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: incomingMessage(plainMessage('暂停测试', '正文')),
      now: receivedAt,
    })
    await processReceiveTask(queue.messages[0]!, queue, receivedAt + 1)
    const pause = await request(`/api/auth/notifications/${created.data.subscription.id}/status`, {
      method: 'POST',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    })
    expect({ status: pause.status, body: await pause.clone().text() }).toMatchObject({
      status: 200,
    })

    const fetcher = vi.fn<typeof fetch>()
    await processNotificationBackgroundTask(await notificationTask(), fetcher, receivedAt + 2)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await scalar<string>(`SELECT operation_status FROM notification_operations`)).toBe(
      'cancelled',
    )
  })
})

async function createSubscription(session: ReturnType<typeof extractAuthenticationCookies>) {
  return request('/api/auth/notifications', {
    method: 'POST',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify(notificationInput()),
  })
}

function notificationInput() {
  return {
    displayName: '我的 ntfy',
    channelType: 'ntfy',
    baseUrl: 'https://ntfy.example.com',
    destination: 'simlettra_mail',
    credential: 'ntfy-test-token',
    scopes: [{ kind: 'all_personal' }],
  }
}

async function processReceiveTask(
  message: BackgroundTaskMessage,
  queue: CapturedQueue,
  now: number,
) {
  return processBackgroundTaskMessage({
    database: env.DB,
    message,
    workerReference: `receive-test-${now}`,
    now,
    executeTask: (task) =>
      processReceiveParsingTask({
        database: env.DB,
        store: createMailObjectStore(testEnvironment, 'r2'),
        queue: queue.binding,
        operationId: task.targetReference,
        now: task.now,
      }),
  })
}

async function processNotificationBackgroundTask(
  message: BackgroundTaskMessage,
  fetcher: typeof fetch,
  now: number,
) {
  return processBackgroundTaskMessage({
    database: env.DB,
    message,
    workerReference: `notification-test-${now}`,
    now,
    executeTask: (task) =>
      processNotificationTask({
        database: env.DB,
        objectStore: createMailObjectStore(testEnvironment, 'r2'),
        encryptionKeyBase64: testEnvironment.CONFIG_KEY,
        taskId: task.taskId,
        operationId: task.targetReference,
        fetcher,
        now: task.now,
      }),
  })
}

async function notificationTask(): Promise<BackgroundTaskMessage> {
  const row = await env.DB.prepare(
    `SELECT id, input_version FROM background_tasks
     WHERE task_type = 'send_notification' ORDER BY created_at, id LIMIT 1`,
  ).first<{ id: string; input_version: number }>()
  if (!row) throw new Error('缺少通知后台任务')
  return { taskId: row.id, inputVersion: row.input_version }
}

function createCapturedQueue(): CapturedQueue {
  const messages: BackgroundTaskMessage[] = []
  return {
    messages,
    binding: {
      send(message: BackgroundTaskMessage) {
        messages.push(message)
        return Promise.resolve()
      },
      sendBatch(batch: Iterable<MessageSendRequest<BackgroundTaskMessage>>) {
        for (const item of batch) messages.push(item.body)
        return Promise.resolve()
      },
    } as unknown as Queue<BackgroundTaskMessage>,
  }
}

function incomingMessage(raw: string): IncomingEmailMessage {
  const bytes = new TextEncoder().encode(raw)
  return {
    from: 'sender@example.net',
    to: 'owner@example.com',
    rawSize: bytes.byteLength,
    raw: new Blob([bytes]).stream(),
    setReject: vi.fn(),
  }
}

function htmlMessageWithAttachment(): string {
  return [
    'From: 外部联系人 <sender@example.net>',
    'To: owner@example.com',
    'Subject: 安全通知测试',
    'Message-ID: <notification-html@example.net>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="simlettra-boundary"',
    '',
    '--simlettra-boundary',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '<p>这是安全可见正文</p><script>alert("不得外发")</script>',
    '--simlettra-boundary',
    'Content-Type: text/plain; name="secret.txt"',
    'Content-Disposition: attachment; filename="secret.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    '6ZmE5Lu25Lit55qE56eY5a+G',
    '--simlettra-boundary--',
    '',
  ].join('\r\n')
}

function plainMessage(subject: string, body: string): string {
  return [
    'From: sender@example.net',
    'To: owner@example.com',
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@example.net>`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n')
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
      'CF-Connecting-IP': '203.0.113.119',
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

async function scalar<T>(sql: string): Promise<T | undefined> {
  const row = await env.DB.prepare(sql).first<Record<string, T>>()
  return row ? Object.values(row)[0] : undefined
}

function bytesToHex(value: Uint8Array): string {
  return [...value]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}
