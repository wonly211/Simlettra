import { env, exports as workerExports } from 'cloudflare:workers'
import { unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import {
  createMailExport,
  MailExportAccessError,
  processMailExportCleanupTask,
  processMailExportTask,
} from '../../src/modules/exports/public'
import {
  createMailObjectStore,
  processReceiveParsingTask,
  receiveIncomingMail,
  type IncomingEmailMessage,
} from '../../src/modules/mail-receiving/public'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type {
  CreateMailExportResponse,
  MailExportOverviewResponse,
} from '../../src/shared/contracts/mail-exports'

interface TestEnvironment extends Env {
  INIT_KEY: string
  TASK_QUEUE: Queue<BackgroundTaskMessage>
  MAIL_OBJECTS_R2: R2Bucket
}

const testEnvironment = env as TestEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'
const receivedAt = Date.UTC(2026, 7, 12, 0, 0, 0)
const organizationId = '00000000-0000-4000-8000-000000000171'

describe('用户与组织邮件导出', () => {
  it('个人导出冻结邮件范围，生成含原始 EML 与中文清单的 ZIP，并可安全下载和删除', async () => {
    await initializeSystem()
    await receiveMessage('owner@example.com', personalMessage(), receivedAt)
    const session = extractCookies(await login())

    const created = await jsonRequest('/api/auth/mail-exports', {
      method: 'POST',
      headers: mutationHeaders(session),
      body: { scopeType: 'personal' },
    })
    expect(created.status).toBe(202)
    const createdPayload = await created.json<CreateMailExportResponse>()
    expect(createdPayload.data.run).toMatchObject({
      scopeType: 'personal',
      frozenMessageCount: 1,
      status: 'planned',
    })

    await processGenerateTask(createdPayload.data.run.id, receivedAt + 2)
    const overviewResponse = await request('/api/auth/mail-exports', {
      headers: { Cookie: session.cookie },
    })
    expect(overviewResponse.status).toBe(200)
    const overview = await overviewResponse.json<MailExportOverviewResponse>()
    const run = overview.data.runs.find((item) => item.id === createdPayload.data.run.id)
    expect(run).toMatchObject({ status: 'succeeded', artifactCount: 1, frozenMessageCount: 1 })
    expect(run?.artifacts).toHaveLength(1)

    const download = await request(run!.artifacts[0]!.downloadUrl, {
      headers: { Cookie: session.cookie },
    })
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/zip')
    const files = unzipSync(new Uint8Array(await download.arrayBuffer()))
    expect(Object.keys(files)).toContain('导出清单.md')
    const emlName = Object.keys(files).find((name) => name.endsWith('.eml'))
    expect(emlName).toBeTruthy()
    expect(new TextDecoder().decode(files[emlName!])).toBe(personalMessage())
    const manifest = new TextDecoder().decode(files['导出清单.md'])
    expect(manifest).toContain('澄笺 | Simlettra 邮件导出清单')
    expect(manifest).toContain('原始 MIME')
    expect(manifest).toContain('000001-个人导出测试.eml')

    const objectKey = await scalar<string>(
      `SELECT object_key FROM export_artifacts WHERE export_run_id = ?1`,
      createdPayload.data.run.id,
    )
    expect(await testEnvironment.MAIL_OBJECTS_R2.get(objectKey!)).not.toBeNull()
    const deleted = await request(`/api/auth/mail-exports/${createdPayload.data.run.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(session),
    })
    expect(deleted.status).toBe(200)
    expect(await testEnvironment.MAIL_OBJECTS_R2.get(objectKey!)).toBeNull()
  })

  it('组织普通成员不能导出，创建者可导出组织邮件，个人导出不会混入组织邮件', async () => {
    await initializeSystem()
    const administratorId = await scalar<string>(
      `SELECT current_admin_user_id FROM system_instances WHERE singleton_id = 1`,
    )
    await insertOrganization(administratorId!, '家庭共享', 'family@example.com')
    await insertMember('member-user', 'member@example.com', organizationId)
    await receiveMessage('family@example.com', organizationMessage(), receivedAt)

    await expect(
      createMailExport({
        database: env.DB,
        queue: capturedQueue().binding,
        userId: 'member-user',
        scopeType: 'organization',
        organizationId,
        audit: testAudit(),
        now: receivedAt + 1,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' } satisfies Partial<MailExportAccessError>)

    const personal = await createMailExport({
      database: env.DB,
      queue: capturedQueue().binding,
      userId: administratorId!,
      scopeType: 'personal',
      audit: testAudit(),
      now: receivedAt + 1,
    })
    expect(personal.frozenMessageCount).toBe(0)

    const organization = await createMailExport({
      database: env.DB,
      queue: capturedQueue().binding,
      userId: administratorId!,
      scopeType: 'organization',
      organizationId,
      audit: testAudit(),
      now: receivedAt + 1,
    })
    expect(organization.frozenMessageCount).toBe(1)
    await processGenerateTask(organization.id, receivedAt + 2)
    await expect(
      scalar<string>(`SELECT export_status FROM export_runs WHERE id = ?1`, organization.id),
    ).resolves.toBe('succeeded')
  })

  it('隐藏密送地址时改用结构化重建，源对象损坏会重试，到期后删除制品', async () => {
    await initializeSystem()
    await receiveMessage('owner@example.com', messageWithBcc(), receivedAt)
    const administratorId = await scalar<string>(
      `SELECT current_admin_user_id FROM system_instances WHERE singleton_id = 1`,
    )
    const queue = capturedQueue()
    const run = await createMailExport({
      database: env.DB,
      queue: queue.binding,
      userId: administratorId!,
      scopeType: 'personal',
      audit: testAudit(),
      now: receivedAt + 1,
    })
    await expect(
      scalar<string>(`SELECT source_quality FROM export_items WHERE export_run_id = ?1`, run.id),
    ).resolves.toBe('reconstructed_structured')

    const bodyObject = await env.DB.prepare(
      `SELECT object_key, expected_sha256 FROM object_registry
       WHERE object_role = 'plain_body' AND message_id = (
         SELECT message_id FROM export_items WHERE export_run_id = ?1
       )`,
    )
      .bind(run.id)
      .first<{ object_key: string; expected_sha256: ArrayBuffer }>()
    const originalBody = await testEnvironment.MAIL_OBJECTS_R2.get(bodyObject!.object_key)
    await testEnvironment.MAIL_OBJECTS_R2.put(bodyObject!.object_key, 'damaged')

    await processGenerateTask(run.id, receivedAt + 2)
    const retry = await env.DB.prepare(
      `SELECT id, input_version, next_attempt_at FROM background_tasks
       WHERE task_type = 'generate_mail_export' AND target_reference = ?1`,
    )
      .bind(run.id)
      .first<{ id: string; input_version: number; next_attempt_at: number }>()
    expect(retry?.next_attempt_at).toBeGreaterThan(receivedAt + 2)
    await testEnvironment.MAIL_OBJECTS_R2.put(
      bodyObject!.object_key,
      await originalBody!.arrayBuffer(),
    )
    await processBackgroundTaskMessage({
      database: env.DB,
      message: { taskId: retry!.id, inputVersion: retry!.input_version },
      workerReference: 'mail-export-retry',
      now: retry!.next_attempt_at,
      executeTask: (task) =>
        processMailExportTask({
          database: env.DB,
          objectStore: createMailObjectStore(testEnvironment, 'r2'),
          storageMode: 'r2',
          taskId: task.taskId,
          exportRunId: task.targetReference,
          now: task.now,
        }),
    })

    const artifact = await env.DB.prepare(
      `SELECT object_key FROM export_artifacts WHERE export_run_id = ?1`,
    )
      .bind(run.id)
      .first<{ object_key: string }>()
    const storedZip = await testEnvironment.MAIL_OBJECTS_R2.get(artifact!.object_key)
    const files = unzipSync(new Uint8Array(await storedZip!.arrayBuffer()))
    const emlName = Object.keys(files).find((name) => name.endsWith('.eml'))!
    const eml = new TextDecoder().decode(files[emlName])
    expect(eml).toContain('X-Simlettra-Export-Source: reconstructed-structured')
    expect(eml).not.toContain('hidden@example.net')

    const expiresAt = await scalar<number>(
      `SELECT expires_at FROM export_runs WHERE id = ?1`,
      run.id,
    )
    await processMailExportCleanupTask({
      database: env.DB,
      objectStore: createMailObjectStore(testEnvironment, 'r2'),
      exportRunId: run.id,
      now: expiresAt!,
    })
    await expect(
      scalar<string>(`SELECT export_status FROM export_runs WHERE id = ?1`, run.id),
    ).resolves.toBe('expired')
    expect(await testEnvironment.MAIL_OBJECTS_R2.get(artifact!.object_key)).toBeNull()
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

async function login() {
  return jsonRequest('/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin },
    body: { email: 'owner@example.com', password },
  })
}

async function receiveMessage(to: string, raw: string, now: number) {
  const queue = capturedQueue()
  const accepted = await receiveIncomingMail({
    database: env.DB,
    queue: queue.binding,
    store: createMailObjectStore(testEnvironment, 'r2'),
    message: incomingMessage(to, raw),
    now,
  })
  expect(accepted.status).toBe('accepted')
  await processBackgroundTaskMessage({
    database: env.DB,
    message: queue.messages[0]!,
    workerReference: `receive-${now}`,
    now: now + 1,
    executeTask: (task) =>
      processReceiveParsingTask({
        database: env.DB,
        store: createMailObjectStore(testEnvironment, 'r2'),
        operationId: task.targetReference,
        now: task.now,
      }),
  })
}

async function processGenerateTask(runId: string, fallbackNow: number) {
  const task = await env.DB.prepare(
    `SELECT id, input_version, next_attempt_at FROM background_tasks
     WHERE task_type = 'generate_mail_export' AND target_reference = ?1`,
  )
    .bind(runId)
    .first<{ id: string; input_version: number; next_attempt_at: number }>()
  expect(task).not.toBeNull()
  const now = Math.max(fallbackNow, task!.next_attempt_at)
  return processBackgroundTaskMessage({
    database: env.DB,
    message: { taskId: task!.id, inputVersion: task!.input_version },
    workerReference: `export-${now}`,
    now,
    executeTask: (context) =>
      processMailExportTask({
        database: env.DB,
        objectStore: createMailObjectStore(testEnvironment, 'r2'),
        storageMode: 'r2',
        taskId: context.taskId,
        exportRunId: context.targetReference,
        now: context.now,
      }),
  })
}

async function insertOrganization(creatorUserId: string, name: string, address: string) {
  const now = receivedAt - 100
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organizations (
           id, name, creator_user_id, status, members_can_send,
           deletion_requested_at, deletion_due_at, created_at, updated_at
         ) VALUES (?4, ?1, ?2, 'active', 0, NULL, NULL, ?3, ?3)`,
    ).bind(name, creatorUserId, now, organizationId),
    env.DB.prepare(
      `INSERT INTO organization_memberships (
           id, organization_id, user_id, joined_at, left_at, left_reason
         ) VALUES ('family-creator-membership', ?3, ?1, ?2, NULL, NULL)`,
    ).bind(creatorUserId, now, organizationId),
    env.DB.prepare(
      `INSERT INTO email_addresses (
         id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
       ) SELECT 'family-address', id, ?1, ?1, NULL, ?2, NULL
         FROM mail_domains WHERE canonical_name = 'example.com'`,
    ).bind(address, now),
    env.DB.prepare(
      `INSERT INTO address_claims (
         canonical_address, address_id, status, reserved_until, created_at, updated_at
       ) VALUES (?1, 'family-address', 'active', NULL, ?2, ?2)`,
    ).bind(address, now),
    env.DB.prepare(
      `INSERT INTO address_bindings (
         id, address_id, owner_type, user_id, organization_id, address_role,
         started_at, ended_at, ended_reason
       ) VALUES ('family-binding', 'family-address', 'organization', NULL,
                 ?2, 'shared', ?1, NULL, NULL)`,
    ).bind(now, organizationId),
  ])
}

async function insertMember(userId: string, address: string, organizationId: string) {
  const now = receivedAt - 50
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, status, display_name, timezone, invitation_policy,
         deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
       ) VALUES (?1, 'active', '普通成员', 'Asia/Shanghai', 'manual',
                 NULL, NULL, NULL, ?2, ?2)`,
    ).bind(userId, now),
    env.DB.prepare(
      `INSERT INTO organization_memberships (
         id, organization_id, user_id, joined_at, left_at, left_reason
       ) VALUES ('family-member-membership', ?1, ?2, ?3, NULL, NULL)`,
    ).bind(organizationId, userId, now),
  ])
  expect(address).toBe('member@example.com')
}

function incomingMessage(to: string, raw: string): IncomingEmailMessage {
  const bytes = new TextEncoder().encode(raw)
  return {
    from: 'sender@outside.test',
    to,
    rawSize: bytes.byteLength,
    raw: new Blob([bytes]).stream(),
    setReject: vi.fn(),
  }
}

function personalMessage() {
  return [
    'From: Sender <sender@outside.test>',
    'To: Owner <owner@example.com>',
    'Subject: 个人导出测试',
    'Message-ID: <export-personal@outside.test>',
    'Date: Wed, 12 Aug 2026 08:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="export-boundary"',
    '',
    '--export-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '导出正文。',
    '--export-boundary',
    'Content-Type: text/plain; name="附件.txt"',
    'Content-Disposition: attachment; filename="附件.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    '5bCP5Z6L6ZmE5Lu2',
    '--export-boundary--',
    '',
  ].join('\r\n')
}

function organizationMessage() {
  return [
    'From: Sender <sender@outside.test>',
    'To: Family <family@example.com>',
    'Subject: 组织导出测试',
    'Message-ID: <export-organization@outside.test>',
    'Date: Wed, 12 Aug 2026 08:10:00 +0800',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '组织正文。',
    '',
  ].join('\r\n')
}

function messageWithBcc() {
  return [
    'From: Sender <sender@outside.test>',
    'To: Owner <owner@example.com>',
    'Bcc: Hidden <hidden@example.net>',
    'Subject: 密送保护测试',
    'Message-ID: <export-bcc@outside.test>',
    'Date: Wed, 12 Aug 2026 08:20:00 +0800',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '密送地址不应泄露。',
    '',
  ].join('\r\n')
}

function capturedQueue() {
  const messages: BackgroundTaskMessage[] = []
  return {
    messages,
    binding: {
      send: async (message: BackgroundTaskMessage) => {
        messages.push(message)
      },
    } as unknown as Queue<BackgroundTaskMessage>,
  }
}

function extractCookies(response: Response) {
  const header = response.headers.get('set-cookie') ?? ''
  const session = new RegExp(`${SESSION_COOKIE_NAME}=([^;,]+)`).exec(header)?.[1] ?? ''
  const csrf = new RegExp(`${CSRF_COOKIE_NAME}=([^;,]+)`).exec(header)?.[1] ?? ''
  return { cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`, csrf }
}

function mutationHeaders(cookies: ReturnType<typeof extractCookies>) {
  return {
    Cookie: cookies.cookie,
    Origin: origin,
    'Content-Type': 'application/json',
    [CSRF_HEADER_NAME]: cookies.csrf,
  }
}

function jsonRequest(
  path: string,
  options: { method: string; headers?: Record<string, string>; body: object },
) {
  return request(path, {
    method: options.method,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify(options.body),
  })
}

function request(path: string, init?: RequestInit) {
  return workerExports.default.fetch(new Request(`${origin}${path}`, init))
}

async function scalar<T>(query: string, ...bindings: unknown[]) {
  const row = await env.DB.prepare(query)
    .bind(...bindings)
    .first<Record<string, T>>()
  return row ? Object.values(row)[0] : null
}

function testAudit() {
  return { requestTraceId: 'mail-export-test', sourceIp: null, browserFamily: 'Vitest' }
}
