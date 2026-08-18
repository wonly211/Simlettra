import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'
import {
  createMailObjectStore,
  type MailObjectStore,
} from '../../src/modules/mail-receiving/public'
import {
  processOutboundSendTask,
  sendDraft as executeSendDraft,
} from '../../src/modules/sending/public'
import { handleBackgroundTaskQueue } from '../../src/worker/handlers/queue'

interface OutboundTestEnvironment extends Env {
  CONFIG_KEY: string
  INIT_KEY: string
  MAIL_OBJECTS_R2: R2Bucket
}

const testEnvironment = env as OutboundTestEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'

describe('域外发信服务与安全切换', { timeout: 45_000 }, () => {
  it('管理员可查看自己的密钥，D1 只保存密文，并在明确未接受时切换备用服务', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const domainId = await currentDomainId()
    const resend = await saveProvider(session, '默认 Resend', 'resend', 'resend-secret-key')
    const smtp2go = await saveProvider(session, '备用 SMTP2GO', 'smtp2go', 'smtp2go-secret-key')
    const routeResponse = await request(`/api/auth/admin/outbound/domains/${domainId}/route`, {
      method: 'PUT',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({ providerConfigIds: [resend.id, smtp2go.id] }),
    })
    expect(routeResponse.status).toBe(200)

    const administratorId = await env.DB.prepare(
      `SELECT current_admin_user_id FROM system_instances WHERE singleton_id = 1`,
    ).first<{ current_admin_user_id: string }>()
    if (!administratorId) throw new Error('测试管理员不存在')
    for (const [path, body] of [
      ['/api/auth/admin/outbound/quotas/daily-default', { limit: 600 }],
      ['/api/auth/admin/outbound/quotas/domain-monthly-default', { limit: 1000 }],
      [
        `/api/auth/admin/outbound/quotas/users/${administratorId.current_admin_user_id}`,
        { limit: 12 },
      ],
      [`/api/auth/admin/outbound/quotas/domains/${domainId}`, { limit: 20 }],
    ] as const) {
      const quotaResponse = await request(path, {
        method: 'PUT',
        headers: jsonMutationHeaders(session),
        body: JSON.stringify(body),
      })
      expect(quotaResponse.status).toBe(200)
    }

    const overview = await request('/api/auth/admin/outbound', {
      headers: { Cookie: session.cookie },
    })
    expect(overview.status).toBe(200)
    await expect(overview.json()).resolves.toMatchObject({
      data: {
        encryptionConfigured: true,
        providers: [
          { displayName: '备用 SMTP2GO', credential: 'smtp2go-secret-key' },
          { displayName: '默认 Resend', credential: 'resend-secret-key' },
        ],
        dailyDefaultRecipientLimit: 600,
        domainMonthlyDefaultLimit: 1000,
        userDailyQuotas: [{ limit: 12, usesDefault: false, usedInPast24Hours: 0 }],
        domainMonthlyQuotas: [{ domainId, limit: 20, usesDefault: false }],
      },
    })
    const stored = await env.DB.prepare(
      `SELECT credential_ciphertext FROM outbound_provider_configs ORDER BY display_name`,
    ).all<{ credential_ciphertext: ArrayBuffer }>()
    expect(stored.results).toHaveLength(2)
    for (const row of stored.results) {
      const value = row.credential_ciphertext as unknown
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : Uint8Array.from(value as ArrayLike<number>)
      const text = new TextDecoder().decode(bytes)
      expect(text).not.toContain('secret-key')
    }

    const draft = await createExternalDraft(session, 'reader@example.net')
    const sendResponse = await sendDraft(draft, session)
    expect(sendResponse.status).toBe(202)
    const accepted = await sendResponse.json<{
      data: { send: { id: string; recipients: Array<{ status: string }> } }
    }>()
    expect(accepted.data.send.recipients[0]?.status).toBe('waiting')

    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { succeeded: 1, failed: 0, email_id: 'smtp2go-accepted' } }),
          { status: 200 },
        ),
      )
    const outcome = await processOutboundSendTask({
      database: env.DB,
      objectStore: createMailObjectStore(testEnvironment, 'r2'),
      encryptionKeyBase64: testEnvironment.CONFIG_KEY,
      sendOperationId: accepted.data.send.id,
      fetcher,
    })
    expect(outcome).toEqual({ status: 'succeeded' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails')
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://api.smtp2go.com/v3/email/send')
    const firstHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(firstHeaders.get('Idempotency-Key')).toMatch(/^simlettra-/u)

    const invalidCallback = await request(
      `/api/outbound/events/smtp2go/${smtp2go.configurationKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic invalid' },
        body: JSON.stringify({
          id: 'smtp-event-unauthorized',
          event: 'delivered',
          time: Math.floor(Date.now() / 1000),
          email_id: 'smtp2go-accepted',
          rcpt: 'reader@example.net',
        }),
      },
    )
    expect(invalidCallback.status).toBe(401)

    const smtpEvent = JSON.stringify({
      id: 'smtp-event-delivered',
      event: 'delivered',
      time: Math.floor(Date.now() / 1000),
      email_id: 'smtp2go-accepted',
      rcpt: 'reader@example.net',
    })
    const callbackHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa('simlettra-callback:smtp2go-callback-secret')}`,
    }
    const callback = await request(`/api/outbound/events/smtp2go/${smtp2go.configurationKey}`, {
      method: 'POST',
      headers: callbackHeaders,
      body: smtpEvent,
    })
    expect(callback.status).toBe(200)
    await expect(callback.json()).resolves.toMatchObject({
      data: { duplicate: false, matched: true, applied: true },
    })
    const replayedCallback = await request(
      `/api/outbound/events/smtp2go/${smtp2go.configurationKey}`,
      { method: 'POST', headers: callbackHeaders, body: smtpEvent },
    )
    await expect(replayedCallback.json()).resolves.toMatchObject({
      data: { duplicate: true, matched: true, applied: true },
    })

    const resendEvent = JSON.stringify({
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: { email_id: 'unmatched-resend-email', to: ['other@example.net'] },
    })
    const resendEventId = 'resend-event-valid-signature'
    const resendTimestamp = String(Math.floor(Date.now() / 1000))
    const resendSignature = await signResendEvent(resendEventId, resendTimestamp, resendEvent)
    const staleTimestamp = String(Number(resendTimestamp) - 600)
    const staleSignature = await signResendEvent(resendEventId, staleTimestamp, resendEvent)
    const staleCallback = await request(`/api/outbound/events/resend/${resend.configurationKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': resendEventId,
        'svix-timestamp': staleTimestamp,
        'svix-signature': `v1,${staleSignature}`,
      },
      body: resendEvent,
    })
    expect(staleCallback.status).toBe(401)
    const resendCallback = await request(`/api/outbound/events/resend/${resend.configurationKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': resendEventId,
        'svix-timestamp': resendTimestamp,
        'svix-signature': `v1,${resendSignature}`,
      },
      body: resendEvent,
    })
    await expect(resendCallback.json()).resolves.toMatchObject({
      data: { duplicate: false, matched: false, applied: false },
    })

    const replacementResponse = await request(`/api/auth/admin/outbound/providers/${resend.id}`, {
      method: 'PUT',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({
        displayName: '默认 Resend',
        providerType: 'resend',
        credential: 'resend-secret-key-v2',
        callbackUsername: null,
        callbackSecret: 'whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      }),
    })
    expect(replacementResponse.status).toBe(201)
    const replacement = await replacementResponse.json<{
      data: { provider: { id: string; configurationVersion: number } }
    }>()
    expect(replacement.data.provider.configurationVersion).toBe(2)
    const replacedOverview = await request('/api/auth/admin/outbound', {
      headers: { Cookie: session.cookie },
    })
    await expect(replacedOverview.json()).resolves.toMatchObject({
      data: {
        routes: [{ providerConfigIds: [replacement.data.provider.id, smtp2go.id] }],
      },
    })

    const resultResponse = await request(`/api/auth/sends/${accepted.data.send.id}`, {
      headers: { Cookie: session.cookie },
    })
    await expect(resultResponse.json()).resolves.toMatchObject({
      data: {
        send: {
          workflowStatus: 'finished',
          queue: { status: 'pending', attemptCount: 0, errorCode: null },
          recipients: [
            {
              status: 'delivered',
              providerType: 'smtp2go',
              providerResult: 'accepted',
              providerSubmissionId: 'smtp2go-accepted',
              providerErrorCode: null,
            },
          ],
        },
      },
    })
    const attempts = await env.DB.prepare(
      `SELECT attempt_status FROM outbound_submission_attempts ORDER BY attempt_number`,
    ).all<{ attempt_status: string }>()
    expect(attempts.results.map((row) => row.attempt_status)).toEqual(['not_accepted', 'accepted'])
  })

  it('凭据解密失败不会提前进入 submitting，修复 CONFIG_KEY 后仍能真正调用 SMTP2GO', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const domainId = await currentDomainId()
    const smtp2go = await saveProvider(session, 'SMTP2GO', 'smtp2go', 'smtp2go-secret-key')
    await request(`/api/auth/admin/outbound/domains/${domainId}/route`, {
      method: 'PUT',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({ providerConfigIds: [smtp2go.id] }),
    })
    const draft = await createExternalDraft(session, 'credential-retry@example.net')
    const accepted = await (
      await sendDraft(draft, session)
    ).json<{ data: { send: { id: string } } }>()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { succeeded: 1, failed: 0, email_id: 'smtp2go-after-retry' } }),
          { status: 200 },
        ),
      )
    const startedAt = Date.now()

    await expect(
      processOutboundSendTask({
        database: env.DB,
        objectStore: createMailObjectStore(testEnvironment, 'r2'),
        encryptionKeyBase64: btoa('11111111111111111111111111111111'),
        sendOperationId: accepted.data.send.id,
        fetcher,
        now: startedAt,
      }),
    ).resolves.toEqual({
      status: 'retry',
      nextAttemptAt: startedAt + 5 * 60_000,
      errorCode: 'outbound_credential_decryption_failed',
    })
    expect(fetcher).not.toHaveBeenCalled()
    await expect(readOutboundSubmissionState()).resolves.toEqual({
      delivery_status: 'waiting',
      progress_status: 'ready',
      attempt_count: 0,
    })

    await expect(
      processOutboundSendTask({
        database: env.DB,
        objectStore: createMailObjectStore(testEnvironment, 'r2'),
        encryptionKeyBase64: testEnvironment.CONFIG_KEY,
        sendOperationId: accepted.data.send.id,
        fetcher,
        now: startedAt + 5 * 60_000,
      }),
    ).resolves.toEqual({ status: 'succeeded' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(readOutboundSubmissionState()).resolves.toEqual({
      delivery_status: 'submitted',
      progress_status: 'accepted',
      attempt_count: 1,
    })
  })

  it('真实 Queue consumer 会调用 SMTP2GO、确认任务并保存 email_id', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const domainId = await currentDomainId()
    const smtp2go = await saveProvider(session, 'SMTP2GO', 'smtp2go', 'smtp2go-secret-key')
    await request(`/api/auth/admin/outbound/domains/${domainId}/route`, {
      method: 'PUT',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({ providerConfigIds: [smtp2go.id] }),
    })
    const draft = await createExternalDraft(session, 'queue-consumer@example.net')
    const accepted = await (
      await sendDraft(draft, session)
    ).json<{ data: { send: { id: string } } }>()
    const task = await env.DB.prepare(
      `SELECT id, input_version FROM background_tasks
       WHERE task_type = 'submit_outbound_send' AND target_reference = ?1`,
    )
      .bind(accepted.data.send.id)
      .first<{ id: string; input_version: number }>()
    if (!task) throw new Error('域外发信 Queue 任务不存在')

    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { succeeded: 1, failed: 0, email_id: 'smtp2go-from-queue' } }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    let acknowledged = false
    let retryDelay: number | null = null
    const message = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: { taskId: task.id, inputVersion: task.input_version },
      ack() {
        acknowledged = true
      },
      retry(options?: { delaySeconds?: number }) {
        retryDelay = options?.delaySeconds ?? 0
      },
    }
    const batch = {
      queue: 'simlettra-test-tasks',
      messages: [message],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<BackgroundTaskMessage>
    try {
      await handleBackgroundTaskQueue(batch, testEnvironment)
    } finally {
      vi.unstubAllGlobals()
    }

    expect(acknowledged).toBe(true)
    expect(retryDelay).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.smtp2go.com/v3/email/send')
    await expect(
      env.DB.prepare(`SELECT task_status, last_error_code FROM background_tasks WHERE id = ?1`)
        .bind(task.id)
        .first(),
    ).resolves.toMatchObject({ task_status: 'succeeded', last_error_code: null })
    await expect(
      env.DB.prepare(
        `SELECT attempt_status, provider_submission_id
         FROM outbound_submission_attempts WHERE send_operation_id = ?1`,
      )
        .bind(accepted.data.send.id)
        .first(),
    ).resolves.toMatchObject({
      attempt_status: 'accepted',
      provider_submission_id: 'smtp2go-from-queue',
    })
  })

  it('批量入队失败时会单独补投域外发信任务', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const domainId = await currentDomainId()
    const smtp2go = await saveProvider(session, 'SMTP2GO', 'smtp2go', 'smtp2go-secret-key')
    await request(`/api/auth/admin/outbound/domains/${domainId}/route`, {
      method: 'PUT',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({ providerConfigIds: [smtp2go.id] }),
    })
    const draft = await createExternalDraft(session, 'queue-recovery@example.net')
    const administrator = await env.DB.prepare(
      `SELECT current_admin_user_id FROM system_instances WHERE singleton_id = 1`,
    ).first<{ current_admin_user_id: string }>()
    if (!administrator) throw new Error('测试管理员不存在')

    const individuallyQueued: BackgroundTaskMessage[] = []
    const queue = {
      async send(message: BackgroundTaskMessage) {
        individuallyQueued.push(message)
      },
      async sendBatch() {
        throw new Error('模拟批量入队失败')
      },
    } as unknown as Queue<BackgroundTaskMessage>
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await executeSendDraft({
      database: env.DB,
      objectStore: createMailObjectStore(testEnvironment, 'r2'),
      storageMode: 'r2',
      queue,
      userId: administrator.current_admin_user_id,
      draftId: draft.id,
      input: {
        requestKey: crypto.randomUUID(),
        expectedRevisionNumber: draft.revisionNumber,
      },
      audit: {
        requestTraceId: crypto.randomUUID(),
        sourceIp: '203.0.113.92',
        browserFamily: 'Chrome',
      },
    }).finally(() => consoleError.mockRestore())

    expect(individuallyQueued).toEqual([{ taskId: result.send.queue.taskId, inputVersion: 1 }])
    expect(result.send.queue).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      errorCode: null,
    })
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM background_tasks
         WHERE id <> ?1 AND last_error_code = 'queue_enqueue_failed'`,
      )
        .bind(result.send.queue.taskId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 2 })
  })

  it('邮件对象暂不可见时保持 waiting，重新可见后才调用 SMTP2GO', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const domainId = await currentDomainId()
    const smtp2go = await saveProvider(session, 'SMTP2GO', 'smtp2go', 'smtp2go-secret-key')
    await request(`/api/auth/admin/outbound/domains/${domainId}/route`, {
      method: 'PUT',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({ providerConfigIds: [smtp2go.id] }),
    })
    const draft = await createExternalDraft(session, 'object-retry@example.net')
    const accepted = await (
      await sendDraft(draft, session)
    ).json<{ data: { send: { id: string } } }>()
    const realStore = createMailObjectStore(testEnvironment, 'r2')
    let firstRead = true
    const delayedStore: MailObjectStore = {
      mode: realStore.mode,
      put: (options) => realStore.put(options),
      async get(key) {
        if (firstRead) {
          firstRead = false
          return null
        }
        return realStore.get(key)
      },
      delete: (key) => realStore.delete(key),
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { succeeded: 1, failed: 0, email_id: 'smtp2go-after-object' } }),
          { status: 200 },
        ),
      )
    const startedAt = Date.now()

    await expect(
      processOutboundSendTask({
        database: env.DB,
        objectStore: delayedStore,
        encryptionKeyBase64: testEnvironment.CONFIG_KEY,
        sendOperationId: accepted.data.send.id,
        fetcher,
        now: startedAt,
      }),
    ).resolves.toEqual({
      status: 'retry',
      nextAttemptAt: startedAt + 60_000,
      errorCode: 'send_body_temporarily_unavailable',
    })
    expect(fetcher).not.toHaveBeenCalled()
    await expect(readOutboundSubmissionState()).resolves.toEqual({
      delivery_status: 'waiting',
      progress_status: 'ready',
      attempt_count: 0,
    })

    await expect(
      processOutboundSendTask({
        database: env.DB,
        objectStore: delayedStore,
        encryptionKeyBase64: testEnvironment.CONFIG_KEY,
        sendOperationId: accepted.data.send.id,
        fetcher,
        now: startedAt + 60_000,
      }),
    ).resolves.toEqual({ status: 'succeeded' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(readOutboundSubmissionState()).resolves.toEqual({
      delivery_status: 'submitted',
      progress_status: 'accepted',
      attempt_count: 1,
    })
  })

  it('网络结果未知时保留配额并停止自动重发', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const domainId = await currentDomainId()
    const provider = await saveProvider(session, 'Resend', 'resend', 'resend-secret-key')
    await request(`/api/auth/admin/outbound/domains/${domainId}/route`, {
      method: 'PUT',
      headers: jsonMutationHeaders(session),
      body: JSON.stringify({ providerConfigIds: [provider.id] }),
    })
    const draft = await createExternalDraft(session, 'unknown@example.net')
    const accepted = await (
      await sendDraft(draft, session)
    ).json<{
      data: { send: { id: string } }
    }>()
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('连接中断'))
    await processOutboundSendTask({
      database: env.DB,
      objectStore: createMailObjectStore(testEnvironment, 'r2'),
      encryptionKeyBase64: testEnvironment.CONFIG_KEY,
      sendOperationId: accepted.data.send.id,
      fetcher,
    })
    await processOutboundSendTask({
      database: env.DB,
      objectStore: createMailObjectStore(testEnvironment, 'r2'),
      encryptionKeyBase64: testEnvironment.CONFIG_KEY,
      sendOperationId: accepted.data.send.id,
      fetcher,
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const recipient = await env.DB.prepare(
      `SELECT delivery_status FROM send_recipients LIMIT 1`,
    ).first<{ delivery_status: string }>()
    const reservation = await env.DB.prepare(
      `SELECT usage_status FROM domain_monthly_usage_reservations LIMIT 1`,
    ).first<{ usage_status: string }>()
    expect(recipient?.delivery_status).toBe('unknown')
    expect(reservation?.usage_status).toBe('unknown_held')
  })
})

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
      callbackUsername: providerType === 'smtp2go' ? 'simlettra-callback' : null,
      callbackSecret:
        providerType === 'resend'
          ? 'whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='
          : 'smtp2go-callback-secret',
    }),
  })
  if (response.status !== 201) {
    throw new Error(`保存发信服务失败：${response.status} ${await response.text()}`)
  }
  const body = await response.json<{
    data: { provider: { id: string; configurationKey: string; credential: string } }
  }>()
  expect(body.data.provider.credential).toBe(credential)
  return body.data.provider
}

async function signResendEvent(id: string, timestamp: string, body: string): Promise<string> {
  const bytes = Uint8Array.from(atob('MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='), (character) =>
    character.charCodeAt(0),
  )
  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  )
  return btoa(String.fromCharCode(...signature))
}

async function createExternalDraft(
  session: ReturnType<typeof extractAuthenticationCookies>,
  recipient: string,
) {
  const create = await request('/api/auth/drafts', {
    method: 'POST',
    headers: jsonMutationHeaders(session),
    body: '{}',
  })
  const created = await create.json<{
    data: { draft: { id: string; revisionNumber: number; senderAddressId: string } }
  }>()
  const saved = await request(`/api/auth/drafts/${created.data.draft.id}`, {
    method: 'PUT',
    headers: jsonMutationHeaders(session),
    body: JSON.stringify({
      mutationKey: crypto.randomUUID(),
      expectedRevisionNumber: created.data.draft.revisionNumber,
      senderAddressId: created.data.draft.senderAddressId,
      subject: '域外发信测试',
      bodyFormat: 'plain_text',
      body: '这是一封域外邮件。',
      recipients: [{ role: 'to', displayName: null, address: recipient }],
      attachmentIds: [],
    }),
  })
  const result = await saved.json<{ data: { draft: { id: string; revisionNumber: number } } }>()
  return result.data.draft
}

function sendDraft(
  draft: { id: string; revisionNumber: number },
  session: ReturnType<typeof extractAuthenticationCookies>,
) {
  return request(`/api/auth/drafts/${draft.id}/send`, {
    method: 'POST',
    headers: jsonMutationHeaders(session),
    body: JSON.stringify({
      requestKey: crypto.randomUUID(),
      expectedRevisionNumber: draft.revisionNumber,
    }),
  })
}

async function currentDomainId() {
  const row = await env.DB.prepare(`SELECT id FROM mail_domains LIMIT 1`).first<{ id: string }>()
  if (!row) throw new Error('测试域名不存在')
  return row.id
}

async function readOutboundSubmissionState() {
  return env.DB.prepare(
    `SELECT recipient.delivery_status, progress.progress_status,
            (SELECT COUNT(*) FROM outbound_submission_attempts) AS attempt_count
     FROM send_recipients recipient
     JOIN send_recipient_route_progress progress ON progress.send_recipient_id = recipient.id
     WHERE recipient.route_channel = 'external' LIMIT 1`,
  ).first<{
    delivery_status: string
    progress_status: string
    attempt_count: number
  }>()
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
      'CF-Connecting-IP': '203.0.113.91',
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
