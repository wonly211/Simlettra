import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  createMailObjectStore,
  processReceiveParsingTask,
  receiveIncomingMail,
  type IncomingEmailMessage,
} from '../../src/modules/mail-receiving/public'
import { processMailForwardTask } from '../../src/modules/forwarding/public'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'

interface ForwardingTestEnvironment extends Env {
  INIT_KEY: string
  CONFIG_KEY: string
  MAIL_OBJECTS_R2: R2Bucket
}

interface CapturedQueue {
  binding: Queue<BackgroundTaskMessage>
  messages: BackgroundTaskMessage[]
}

const testEnvironment = env as ForwardingTestEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'

describe('外部邮箱验证与自动转发纵向闭环', { timeout: 45_000 }, () => {
  it('验证外部邮箱、建立个人规则，并在明确未接受时切换备用服务', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const domainId = await scalar<string>(`SELECT id FROM mail_domains LIMIT 1`)
    if (!domainId) throw new Error('测试域名不存在')
    const resendId = await saveProvider(session, 'Resend', 'resend', 'resend-secret')
    const smtp2goId = await saveProvider(session, 'SMTP2GO', 'smtp2go', 'smtp2go-secret')
    const route = await request(`/api/auth/admin/outbound/domains/${domainId}/route`, {
      method: 'PUT',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({ providerConfigIds: [resendId, smtp2goId] }),
    })
    expect(route.status).toBe(200)

    const noCsrf = await request('/api/auth/forwarding/targets', {
      method: 'POST',
      headers: { Cookie: session.cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailAddress: 'archive@example.net' }),
    })
    expect(noCsrf.status).toBe(403)

    let verificationCode = ''
    const verificationFetcher = vi.fn<typeof fetch>(async (_request, init) => {
      const payload = JSON.parse(String(init?.body)) as { text: string }
      verificationCode =
        payload.text.match(/[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}/u)?.[0] ?? ''
      return new Response(JSON.stringify({ id: 'verification-submission' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', verificationFetcher)
    const createTarget = await request('/api/auth/forwarding/targets', {
      method: 'POST',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({ emailAddress: 'Archive@Example.net' }),
    })
    vi.unstubAllGlobals()
    expect(createTarget.status).toBe(201)
    const target = await createTarget.json<{ data: { target: { id: string; status: string } } }>()
    expect(target.data.target.status).toBe('pending')
    expect(verificationCode).toMatch(/-/u)
    expect(verificationFetcher).toHaveBeenCalledOnce()
    const storedCode = await env.DB.prepare(
      `SELECT length(verification_code_hash) AS hash_length,
              length(verification_code_salt) AS salt_length
       FROM external_email_verifications LIMIT 1`,
    ).first<{ hash_length: number; salt_length: number }>()
    expect(storedCode).toEqual({ hash_length: 32, salt_length: 16 })
    expect(JSON.stringify(storedCode)).not.toContain(verificationCode)

    const wrongCode = await request(
      `/api/auth/forwarding/targets/${target.data.target.id}/verify`,
      {
        method: 'POST',
        headers: jsonMutationHeaders(session),
        body: JSON.stringify({ code: '2222-2222-2222-2222' }),
      },
    )
    expect(wrongCode.status).toBe(422)
    const verified = await request(`/api/auth/forwarding/targets/${target.data.target.id}/verify`, {
      method: 'POST',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({ code: verificationCode }),
    })
    expect(verified.status).toBe(200)
    await expect(verified.json()).resolves.toMatchObject({
      data: { target: { status: 'verified' } },
    })

    const createRule = await request('/api/auth/forwarding/rules', {
      method: 'POST',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({
        targetId: target.data.target.id,
        scope: 'all_personal',
        addressIds: [],
        enabled: true,
      }),
    })
    expect(createRule.status).toBe(201)
    const rule = await createRule.json<{ data: { rule: { id: string; status: string } } }>()
    expect(rule.data.rule.status).toBe('active')

    const queue = createCapturedQueue()
    const receivedAt = Date.now() - 10_000
    await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: incomingMessage(forwardSourceMessage()),
      now: receivedAt,
    })
    await processReceiveTask(queue.messages[0]!, queue, receivedAt + 1)
    expect(await scalar<number>(`SELECT COUNT(*) FROM mail_forward_operations`)).toBe(1)
    expect(await scalar<number>(`SELECT COUNT(*) FROM mailbox_entries`)).toBe(1)

    const forwardTask = await readForwardTask()
    const forwardingFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'limited' }), { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { succeeded: 1, failed: 0, email_id: 'forward-accepted' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    await processForwardTask(forwardTask, forwardingFetcher, receivedAt + 2)
    expect(forwardingFetcher).toHaveBeenCalledTimes(2)
    const smtpPayload = JSON.parse(String(forwardingFetcher.mock.calls[1]?.[1]?.body)) as {
      sender: string
      to: string[]
      text_body: string
      custom_headers: Array<{ header: string; value: string }>
      attachments: Array<{ filename: string }>
    }
    expect(smtpPayload).toMatchObject({
      sender: expect.stringContaining('owner@example.com'),
      to: ['archive@example.net'],
      attachments: [{ filename: 'note.txt' }],
    })
    expect(smtpPayload.text_body.trim()).toBe('需要转发的正文')
    expect(smtpPayload.custom_headers).toEqual(
      expect.arrayContaining([
        { header: 'Reply-To', value: 'sender@example.org' },
        { header: 'X-Simlettra-Forwarded', value: '1' },
        { header: 'X-Simlettra-Forward-Hop', value: '1' },
      ]),
    )
    expect(await scalar<string>(`SELECT operation_status FROM mail_forward_operations`)).toBe(
      'submitted',
    )
    const attempts = await env.DB.prepare(
      `SELECT attempt_status FROM mail_forward_attempts ORDER BY attempt_number`,
    ).all<{ attempt_status: string }>()
    expect(attempts.results.map((attempt) => attempt.attempt_status)).toEqual([
      'not_accepted',
      'accepted',
    ])

    const overview = await request('/api/auth/forwarding', {
      headers: { Cookie: session.cookie },
    })
    expect(overview.status).toBe(200)
    await expect(overview.json()).resolves.toMatchObject({
      data: {
        targets: [{ emailAddress: 'archive@example.net', status: 'verified' }],
        rules: [{ status: 'active', targetAddress: 'archive@example.net' }],
        recentResults: [{ subject: '自动转发测试', status: 'submitted' }],
      },
    })

    const unknownQueue = createCapturedQueue()
    const unknownAt = receivedAt + 20_000
    await receiveIncomingMail({
      database: env.DB,
      queue: unknownQueue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: incomingMessage(forwardSourceMessage()),
      now: unknownAt,
    })
    await processReceiveTask(unknownQueue.messages[0]!, unknownQueue, unknownAt + 1)
    const unknownFetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('连接中断'))
    await processForwardTask(await readForwardTask(), unknownFetcher, unknownAt + 2)
    expect(unknownFetcher).toHaveBeenCalledOnce()
    expect(
      await env.DB.prepare(
        `SELECT operation_status FROM mail_forward_operations
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).first(),
    ).toEqual({ operation_status: 'unknown' })
  })

  it('带 Simlettra 标记的来信只记录环路拒绝，原始来信仍正常保存', async () => {
    await initializeSystem()
    const ids = await seedVerifiedRuleAndRoute()
    const queue = createCapturedQueue()
    const now = Date.now() - 2_000
    await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: incomingMessage(
        forwardSourceMessage(['X-Simlettra-Forwarded: 1', 'X-Simlettra-Forward-Hop: 1']),
      ),
      now,
    })
    await processReceiveTask(queue.messages[0]!, queue, now + 1)
    expect(ids.ruleId).toBeTruthy()
    expect(
      await env.DB.prepare(
        `SELECT operation_status, error_code FROM mail_forward_operations`,
      ).first(),
    ).toEqual({ operation_status: 'rejected_loop', error_code: 'forwarding_loop_rejected' })
    expect(
      await scalar<number>(
        `SELECT COUNT(*) FROM background_tasks WHERE task_type = 'forward_mail'`,
      ),
    ).toBe(0)
    expect(await scalar<number>(`SELECT COUNT(*) FROM mailbox_entries`)).toBe(1)
  })
})

async function seedVerifiedRuleAndRoute() {
  const user = await env.DB.prepare(
    `SELECT current_admin_user_id AS user_id FROM system_instances WHERE singleton_id = 1`,
  ).first<{ user_id: string }>()
  const domain = await env.DB.prepare(`SELECT id FROM mail_domains LIMIT 1`).first<{ id: string }>()
  if (!user || !domain) throw new Error('测试身份不存在')
  const providerId = crypto.randomUUID()
  const routeId = crypto.randomUUID()
  const targetId = crypto.randomUUID()
  const ruleId = crypto.randomUUID()
  const encrypted = new Uint8Array(16)
  const nonce = new Uint8Array(12)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO outbound_provider_configs (
        id, configuration_key, configuration_version, display_name, provider_type,
        public_options_json, credential_ciphertext, credential_nonce,
        credential_algorithm, credential_key_version, credential_updated_at,
        configuration_status, created_at, updated_at
       ) VALUES (?1, ?2, 1, '测试 Resend', 'resend', '{}', ?3, ?4,
                 'AES-GCM-256', 1, ?5, 'active', ?5, ?5)`,
    ).bind(providerId, crypto.randomUUID(), encrypted, nonce, Date.now()),
    env.DB.prepare(
      `INSERT INTO domain_outbound_routes (
        id, mail_domain_id, route_version, route_status, created_at, activated_at, updated_at
       ) VALUES (?1, ?2, 1, 'draft', ?3, NULL, ?3)`,
    ).bind(routeId, domain.id, Date.now()),
    env.DB.prepare(
      `INSERT INTO domain_outbound_route_entries (
        id, route_id, priority_number, provider_config_id, created_at
       ) VALUES (?1, ?2, 0, ?3, ?4)`,
    ).bind(crypto.randomUUID(), routeId, providerId, Date.now()),
    env.DB.prepare(
      `UPDATE domain_outbound_routes
       SET route_status = 'active', activated_at = ?1, updated_at = ?1
       WHERE id = ?2 AND route_status = 'draft'`,
    ).bind(Date.now(), routeId),
    env.DB.prepare(
      `INSERT INTO external_email_targets (
        id, user_id, display_email_address, canonical_email_address,
        target_status, verified_at, created_at, updated_at
       ) VALUES (?1, ?2, 'archive@example.net', 'archive@example.net', 'verified', ?3, ?3, ?3)`,
    ).bind(targetId, user.user_id, Date.now()),
    env.DB.prepare(
      `INSERT INTO mail_forwarding_rules (
        id, rule_key, user_id, external_email_target_id, rule_version,
        scope_kind, rule_status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, 1, 'all_personal', 'active', ?5, ?5)`,
    ).bind(ruleId, crypto.randomUUID(), user.user_id, targetId, Date.now()),
  ])
  return { ruleId }
}

async function saveProvider(
  session: ReturnType<typeof extractAuthenticationCookies>,
  displayName: string,
  providerType: 'resend' | 'smtp2go',
  credential: string,
) {
  const response = await request('/api/auth/admin/outbound/providers', {
    method: 'POST',
    headers: jsonMutationHeaders(session),
    body: JSON.stringify({
      displayName,
      providerType,
      credential,
      callbackUsername: providerType === 'smtp2go' ? 'callback-user' : null,
      callbackSecret:
        providerType === 'resend'
          ? 'whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='
          : 'callback-secret',
    }),
  })
  if (response.status !== 201) throw new Error(`保存发信服务失败：${await response.text()}`)
  return (await response.json<{ data: { provider: { id: string } } }>()).data.provider.id
}

async function processReceiveTask(
  message: BackgroundTaskMessage,
  queue: CapturedQueue,
  now: number,
) {
  return processBackgroundTaskMessage({
    database: env.DB,
    message,
    workerReference: `receive-forward-${now}`,
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

async function processForwardTask(
  message: BackgroundTaskMessage,
  fetcher: typeof fetch,
  now: number,
) {
  return processBackgroundTaskMessage({
    database: env.DB,
    message,
    workerReference: `forward-${now}`,
    now,
    executeTask: (task) =>
      processMailForwardTask({
        database: env.DB,
        objectStore: createMailObjectStore(testEnvironment, 'r2'),
        encryptionKeyBase64: testEnvironment.CONFIG_KEY,
        operationId: task.targetReference,
        fetcher,
        now: task.now,
      }),
  })
}

async function readForwardTask(): Promise<BackgroundTaskMessage> {
  const row = await env.DB.prepare(
    `SELECT id, input_version FROM background_tasks
     WHERE task_type = 'forward_mail' AND task_status IN ('pending', 'retry_wait')
     ORDER BY created_at, id LIMIT 1`,
  ).first<{ id: string; input_version: number }>()
  if (!row) throw new Error('缺少转发后台任务')
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
    from: 'sender@example.org',
    to: 'owner@example.com',
    rawSize: bytes.byteLength,
    raw: new Blob([bytes]).stream(),
    setReject: vi.fn(),
  }
}

function forwardSourceMessage(extraHeaders: string[] = []): string {
  return [
    'From: sender@example.org',
    'Reply-To: sender@example.org',
    'To: owner@example.com',
    'Subject: 自动转发测试',
    `Message-ID: <${crypto.randomUUID()}@example.org>`,
    ...extraHeaders,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="forward-boundary"',
    '',
    '--forward-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '需要转发的正文',
    '--forward-boundary',
    'Content-Type: text/plain; name="note.txt"',
    'Content-Disposition: attachment; filename="note.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    '6ZmE5Lu25YaF5a65',
    '--forward-boundary--',
    '',
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
      'CF-Connecting-IP': '203.0.113.129',
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

function jsonMutationHeaders(session: ReturnType<typeof extractAuthenticationCookies>) {
  return {
    Cookie: session.cookie,
    Origin: origin,
    [CSRF_HEADER_NAME]: session.csrfToken,
    'Content-Type': 'application/json',
  }
}

async function scalar<T>(sql: string): Promise<T | undefined> {
  const row = await env.DB.prepare(sql).first<Record<string, T>>()
  return row ? Object.values(row)[0] : undefined
}
