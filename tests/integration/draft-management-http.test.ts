import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'

interface DraftTestEnvironment extends Env {
  INIT_KEY: string
  MAIL_OBJECTS_R2: R2Bucket
}

const testEnvironment = env as DraftTestEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'

describe('草稿与写信编辑 HTTP 边界', () => {
  it('创建、自动保存、幂等重放、冲突副本和垃圾箱均保持服务端权威', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())

    const workspaceResponse = await request('/api/auth/drafts', { headers: session.headers })
    expect(workspaceResponse.status).toBe(200)
    await expect(workspaceResponse.json()).resolves.toMatchObject({
      data: {
        drafts: [],
        senderAddresses: [
          { address: 'owner@example.com', ownerType: 'user', isDefault: true, canSend: true },
        ],
      },
    })

    const missingCsrf = await request('/api/auth/drafts', {
      method: 'POST',
      headers: { Cookie: session.cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(missingCsrf.status).toBe(403)

    const createResponse = await request('/api/auth/drafts', {
      method: 'POST',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(createResponse.status).toBe(201)
    const created = await createResponse.json<{
      data: { draft: { id: string; revisionNumber: number; senderAddressId: string } }
    }>()
    const draftId = created.data.draft.id
    const senderAddressId = created.data.draft.senderAddressId
    expect(created.data.draft.revisionNumber).toBe(1)

    const mutationKey = crypto.randomUUID()
    const saveBody = {
      mutationKey,
      expectedRevisionNumber: 1,
      senderAddressId,
      subject: '跨设备草稿',
      bodyFormat: 'plain_text',
      body: '第一台设备保存的正文',
      recipients: [{ role: 'to', displayName: '收件人', address: 'reader@example.net' }],
      attachmentIds: [],
    }
    const saveResponse = await save(draftId, session, saveBody)
    expect(saveResponse.status).toBe(200)
    const saved = await saveResponse.json<{
      data: { outcome: string; draft: { revisionNumber: number; body: string } }
    }>()
    expect(saved.data).toMatchObject({
      outcome: 'updated',
      draft: { revisionNumber: 2, body: '第一台设备保存的正文' },
    })
    await expect(logicalUsage()).resolves.toEqual({
      committed_bytes: new TextEncoder().encode('第一台设备保存的正文').byteLength,
      reserved_bytes: 0,
    })

    const replayResponse = await save(draftId, session, saveBody)
    expect(replayResponse.status).toBe(200)
    await expect(replayResponse.json()).resolves.toMatchObject({
      data: { outcome: 'updated', draft: { id: draftId, revisionNumber: 2 } },
    })

    const conflictResponse = await save(draftId, session, {
      ...saveBody,
      mutationKey: crypto.randomUUID(),
      body: '第二台设备基于旧版本保存的正文',
    })
    expect(conflictResponse.status).toBe(200)
    const conflict = await conflictResponse.json<{
      data: { outcome: string; draft: { id: string; conflictCopy: boolean; body: string } }
    }>()
    expect(conflict.data.outcome).toBe('conflict_copy')
    expect(conflict.data.draft).toMatchObject({
      conflictCopy: true,
      body: '第二台设备基于旧版本保存的正文',
    })
    expect(conflict.data.draft.id).not.toBe(draftId)
    await expect(logicalUsage()).resolves.toEqual({
      committed_bytes:
        new TextEncoder().encode('第一台设备保存的正文').byteLength +
        new TextEncoder().encode('第二台设备基于旧版本保存的正文').byteLength,
      reserved_bytes: 0,
    })

    const listResponse = await request('/api/auth/drafts', { headers: session.headers })
    const list = await listResponse.json<{ data: { drafts: Array<{ id: string }> } }>()
    expect(list.data.drafts).toHaveLength(2)

    const trashResponse = await request(`/api/auth/drafts/${draftId}/trash`, {
      method: 'POST',
      headers: mutationHeaders(session),
    })
    expect(trashResponse.status).toBe(200)
    await expect(trashResponse.json()).resolves.toMatchObject({
      data: { draft: { status: 'trashed' } },
    })
    const restoreResponse = await request(`/api/auth/drafts/${draftId}/restore`, {
      method: 'POST',
      headers: mutationHeaders(session),
    })
    expect(restoreResponse.status).toBe(200)
    await expect(restoreResponse.json()).resolves.toMatchObject({
      data: { draft: { status: 'active' } },
    })
  })

  it('完整上传、下载和移除附件，且不能读取他人的草稿标识', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const createResponse = await request('/api/auth/drafts', {
      method: 'POST',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: '{}',
    })
    const created = await createResponse.json<{
      data: { draft: { id: string; revisionNumber: number; senderAddressId: string } }
    }>()
    const draft = created.data.draft
    const file = new Blob(['附件内容'], { type: 'text/plain' })
    const uploadMutationKey = crypto.randomUUID()
    const uploadHeaders = {
      ...mutationHeaders(session),
      'Content-Type': 'text/plain',
      'X-Simlettra-Mutation-Key': uploadMutationKey,
      'X-Simlettra-Expected-Revision': String(draft.revisionNumber),
      'X-Simlettra-File-Name': encodeURIComponent('说明.txt'),
    }
    const uploadResponse = await request(`/api/auth/drafts/${draft.id}/attachments`, {
      method: 'POST',
      headers: uploadHeaders,
      body: file,
    })
    expect(uploadResponse.status).toBe(201)
    const uploaded = await uploadResponse.json<{
      data: { attachment: { id: string; fileName: string }; draft: { revisionNumber: number } }
    }>()
    expect(uploaded.data.attachment.fileName).toBe('说明.txt')
    expect(uploaded.data.draft.revisionNumber).toBe(2)
    await expect(logicalUsage()).resolves.toEqual({
      committed_bytes: file.size,
      reserved_bytes: 0,
    })

    const replayResponse = await request(`/api/auth/drafts/${draft.id}/attachments`, {
      method: 'POST',
      headers: uploadHeaders,
      body: file,
    })
    expect(replayResponse.status).toBe(201)
    await expect(replayResponse.json()).resolves.toMatchObject({
      data: {
        attachment: { id: uploaded.data.attachment.id, fileName: '说明.txt' },
        draft: { attachmentCount: 1, revisionNumber: 2 },
      },
    })

    const download = await request(
      `/api/auth/drafts/${draft.id}/attachments/${uploaded.data.attachment.id}`,
      { headers: session.headers },
    )
    expect(download.status).toBe(200)
    expect(new TextDecoder().decode(await download.arrayBuffer())).toBe('附件内容')
    expect(download.headers.get('content-disposition')).toContain('attachment')

    const detailResponse = await request(`/api/auth/drafts/${draft.id}`, {
      headers: session.headers,
    })
    const detail = await detailResponse.json<{
      data: { draft: { senderAddressId: string; bodyFormat: string; body: string } }
    }>()
    const removeResponse = await save(draft.id, session, {
      mutationKey: crypto.randomUUID(),
      expectedRevisionNumber: 2,
      senderAddressId: detail.data.draft.senderAddressId,
      subject: '',
      bodyFormat: detail.data.draft.bodyFormat,
      body: detail.data.draft.body,
      recipients: [],
      attachmentIds: [],
    })
    expect(removeResponse.status).toBe(200)
    await expect(removeResponse.json()).resolves.toMatchObject({
      data: { draft: { attachmentCount: 0, revisionNumber: 3 } },
    })
    await expect(logicalUsage()).resolves.toEqual({
      committed_bytes: 0,
      reserved_bytes: 0,
    })

    const unavailable = await request(`/api/auth/drafts/${crypto.randomUUID()}`, {
      headers: session.headers,
    })
    expect(unavailable.status).toBe(404)

    const foreignKeys = await env.DB.prepare('PRAGMA foreign_key_check').all()
    expect(foreignKeys.results).toEqual([])
  })

  it('保存事务失败时释放已经取得的逻辑存储预留', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const createResponse = await request('/api/auth/drafts', {
      method: 'POST',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: '{}',
    })
    const created = await createResponse.json<{
      data: { draft: { id: string; revisionNumber: number; senderAddressId: string } }
    }>()
    await env.DB.prepare(
      `CREATE TRIGGER fail_draft_mutation
       BEFORE INSERT ON draft_mutation_keys
       BEGIN SELECT RAISE(ABORT, '模拟草稿事务失败'); END`,
    ).run()
    const response = await save(created.data.draft.id, session, {
      mutationKey: crypto.randomUUID(),
      expectedRevisionNumber: created.data.draft.revisionNumber,
      senderAddressId: created.data.draft.senderAddressId,
      subject: '失败测试',
      bodyFormat: 'plain_text',
      body: '这次增长不应占用额度',
      recipients: [],
      attachmentIds: [],
    })
    expect(response.status).toBe(500)
    await expect(logicalUsage()).resolves.toEqual({ committed_bytes: 0, reserved_bytes: 0 })
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

function login() {
  return request('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': '203.0.113.80',
      'Content-Type': 'application/json',
      Origin: origin,
      'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
    },
    body: JSON.stringify({ email: 'owner@example.com', password }),
  })
}

function save(
  draftId: string,
  session: ReturnType<typeof extractAuthenticationCookies>,
  body: object,
) {
  return request(`/api/auth/drafts/${draftId}`, {
    method: 'PUT',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

function logicalUsage() {
  return env.DB.prepare(
    `SELECT committed_bytes, reserved_bytes FROM logical_storage_usage_accounts
     WHERE storage_mode = 'r2' AND owner_type = 'user'
       AND user_id = (SELECT current_admin_user_id FROM system_instances WHERE singleton_id = 1)`,
  ).first<{ committed_bytes: number; reserved_bytes: number }>()
}
