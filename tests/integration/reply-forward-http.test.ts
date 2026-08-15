import { env, exports as workerExports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import type { DraftDetail } from '../../src/shared/contracts/drafts'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'
import {
  createMailObjectStore,
  processReceiveParsingTask,
  receiveIncomingMail,
  type IncomingEmailMessage,
} from '../../src/modules/mail-receiving/public'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'

interface ReplyForwardEnvironment extends Env {
  INIT_KEY: string
  MAIL_OBJECTS_R2: R2Bucket
}

const testEnvironment = env as ReplyForwardEnvironment
const origin = 'https://simlettra.test'
const password = '长河-Glass-47-Quiet'
const memberPassword = '晨光-Cobalt-82-Open'

interface CreatedMember {
  id: string
  primaryAddress: string
  temporaryPassword: string
}

interface OrganizationMailboxFixture {
  organizationId: string
  addressId: string
}

describe('回复、回复全部与转发 HTTP 边界', { timeout: 60_000 }, () => {
  it('从有权邮箱条目建立安全预填草稿，并保持回复与转发关系边界', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    await createMember(session)
    await deliverHtmlMailWithAttachment()
    const source = await findSourceEntry(session)

    const reply = await createRelatedDraft(session, 'reply', source.entryId)
    expect(reply).toMatchObject({
      composeKind: 'reply',
      sourceMessageId: source.messageId,
      subject: 'Re: 来源邮件',
      recipients: [{ role: 'to', displayName: '成员回复地址', address: 'member@example.com' }],
      attachments: [],
    })
    expect(reply.body).toContain('只有这段可见文字')
    expect(reply.body).not.toContain('恶意脚本')
    expect(reply.body).not.toContain('<script')

    const replyAll = await createRelatedDraft(session, 'reply_all', source.entryId)
    expect(replyAll.recipients).toEqual([
      { role: 'to', displayName: '成员回复地址', address: 'member@example.com' },
      { role: 'cc', displayName: '外部同事', address: 'team@outside.test' },
    ])
    expect(replyAll.recipients.map((recipient) => recipient.address)).not.toContain(
      'owner@example.com',
    )

    const forwarded = await createRelatedDraft(session, 'forward', source.entryId)
    expect(forwarded).toMatchObject({
      composeKind: 'forward',
      sourceMessageId: source.messageId,
      subject: 'Fwd: 来源邮件',
      recipients: [],
      attachments: [{ fileName: '说明.txt', mediaType: 'text/plain', sizeBytes: 18 }],
    })
    const copiedAttachment = await request(
      `/api/auth/drafts/${forwarded.id}/attachments/${forwarded.attachments[0]!.id}`,
      { headers: session.headers },
    )
    expect(copiedAttachment.status).toBe(200)
    expect(new TextDecoder().decode(await copiedAttachment.arrayBuffer())).toBe('转发附件内容')

    const physicalIdRejected = await request('/api/auth/drafts', {
      method: 'POST',
      headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ composeKind: 'reply', sourceMailboxEntryId: source.messageId }),
    })
    expect(physicalIdRejected.status).toBe(409)

    const replySend = await sendDraft(session, reply)
    expect(replySend.status).toBe(202)
    const replyMessageId = await messageIdForDraft(reply.id)
    const relationTypes = await env.DB.prepare(
      `SELECT relation_type FROM message_relations
       WHERE child_message_id = ?1 ORDER BY relation_type`,
    )
      .bind(replyMessageId)
      .all<{ relation_type: string }>()
    expect(relationTypes.results.map((row) => row.relation_type)).toEqual([
      'in_reply_to',
      'internal_reply',
      'reference',
      'reference',
    ])
    const replyMime = await readFinalMime(replyMessageId)
    expect(replyMime).toContain('In-Reply-To: <reply-source@outside.test>')
    expect(replyMime).toContain('References: <root@outside.test> <reply-source@outside.test>')

    const savedForward = await saveDraft(session, forwarded, [
      { role: 'to', displayName: '内部成员', address: 'member@example.com' },
    ])
    const forwardSend = await sendDraft(session, savedForward)
    expect(forwardSend.status).toBe(202)
    const forwardMessageId = await messageIdForDraft(forwarded.id)
    const forwardRelations = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM message_relations WHERE child_message_id = ?1',
    )
      .bind(forwardMessageId)
      .first<{ count: number }>()
    expect(forwardRelations?.count).toBe(0)
    const forwardMime = await readFinalMime(forwardMessageId)
    expect(forwardMime).not.toContain('In-Reply-To:')
    expect(forwardMime).not.toContain('References:')
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('普通组织成员使用个人地址回复全部时保留组织地址', async () => {
    await initializeSystem()
    const session = extractAuthenticationCookies(await login())
    const member = await createMember(session)
    await createOrganizationMailboxForMember(member.id)
    await deliverOrganizationMail()
    const source = await findSourceEntry(session)

    const replyAll = await createRelatedDraft(session, 'reply_all', source.entryId)
    expect(replyAll.senderAddressId).toBe(
      (await env.DB.prepare(
        "SELECT id FROM email_addresses WHERE canonical_address = 'owner@example.com'",
      ).first<{ id: string }>())!.id,
    )
    expect(replyAll.recipients).toEqual([
      { role: 'to', displayName: '外部客户', address: 'customer@outside.test' },
      { role: 'cc', displayName: '家庭组', address: 'family@example.com' },
    ])
  })

  it('组织创建者始终可以使用共享地址，普通成员只能在开关开启后使用', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const member = await createMember(administrator)
    const creator = await activateMember(member)
    const organization = await createOrganizationMailboxForMember(member.id)

    const denied = await request('/api/auth/drafts', {
      method: 'POST',
      headers: { ...mutationHeaders(administrator), 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderAddressId: organization.addressId }),
    })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: 'sender_unavailable' },
    })

    const creatorDraft = await createDraftWithSender(creator, organization.addressId)
    const savedCreatorDraft = await saveDraft(creator, creatorDraft, [
      { role: 'to', displayName: '系统管理员', address: 'owner@example.com' },
    ])
    expect((await sendDraft(creator, savedCreatorDraft)).status).toBe(202)

    const permission = await request(
      `/api/auth/organizations/${organization.organizationId}/sending-permission`,
      {
        method: 'PATCH',
        headers: { ...mutationHeaders(creator), 'Content-Type': 'application/json' },
        body: JSON.stringify({ membersCanSend: true }),
      },
    )
    expect(permission.status).toBe(200)

    const memberDraft = await createDraftWithSender(administrator, organization.addressId)
    const savedMemberDraft = await saveDraft(administrator, memberDraft, [
      { role: 'to', displayName: '组织创建者', address: member.primaryAddress },
    ])
    expect((await sendDraft(administrator, savedMemberDraft)).status).toBe(202)

    const sends = await env.DB.prepare(
      `SELECT sent_user_id, sent_organization_id
       FROM send_operations ORDER BY created_at, id`,
    ).all<{ sent_user_id: string | null; sent_organization_id: string | null }>()
    expect(sends.results).toEqual([
      { sent_user_id: null, sent_organization_id: organization.organizationId },
      { sent_user_id: null, sent_organization_id: organization.organizationId },
    ])
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('个人地址回复只有继续投递到组织地址时才对其他组织成员可见', async () => {
    await initializeSystem()
    const administrator = extractAuthenticationCookies(await login())
    const member = await createMember(administrator)
    const creator = await activateMember(member)
    const organization = await createOrganizationMailboxForMember(member.id)
    await deliverOrganizationMail()
    const source = await findSourceEntry(administrator)

    const privateReply = await createRelatedDraft(administrator, 'reply', source.entryId)
    const savedPrivateReply = await saveDraft(administrator, privateReply, [
      { role: 'to', displayName: '自己', address: 'owner@example.com' },
    ])
    expect((await sendDraft(administrator, savedPrivateReply)).status).toBe(202)
    const privateMessageId = await messageIdForDraft(privateReply.id)
    expect(await organizationEntryId(privateMessageId)).toBeNull()

    const privateEntry = await env.DB.prepare(
      `SELECT entry.id
       FROM mailbox_entries AS entry
       JOIN system_instances AS instance ON instance.current_admin_user_id = entry.user_id
       WHERE entry.message_id = ?1 AND entry.mailbox_type = 'user'
         AND entry.entry_kind = 'received'
       LIMIT 1`,
    )
      .bind(privateMessageId)
      .first<{ id: string }>()
    expect(privateEntry).not.toBeNull()
    expect(
      (
        await request(`/api/auth/mailbox/entries/${privateEntry!.id}`, {
          headers: creator.headers,
        })
      ).status,
    ).toBe(404)

    const sharedReply = await createRelatedDraft(administrator, 'reply_all', source.entryId)
    const savedSharedReply = await saveDraft(administrator, sharedReply, [
      { role: 'cc', displayName: '家庭组', address: 'family@example.com' },
    ])
    expect((await sendDraft(administrator, savedSharedReply)).status).toBe(202)
    const sharedMessageId = await messageIdForDraft(sharedReply.id)
    const sharedEntryId = await organizationEntryId(sharedMessageId)
    expect(sharedEntryId).not.toBeNull()

    const visible = await request(`/api/auth/mailbox/entries/${sharedEntryId!}`, {
      headers: creator.headers,
    })
    expect(visible.status).toBe(200)
    await expect(visible.json()).resolves.toMatchObject({
      data: {
        message: {
          mailboxType: 'organization',
          organization: { id: organization.organizationId },
        },
      },
    })
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })
})

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

async function createMember(
  session: ReturnType<typeof extractAuthenticationCookies>,
): Promise<CreatedMember> {
  const domain = await env.DB.prepare(
    "SELECT id FROM mail_domains WHERE canonical_name = 'example.com'",
  ).first<{ id: string }>()
  const response = await request('/api/auth/administrator/users', {
    method: 'POST',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: '内部成员',
      localPart: 'member',
      domainId: domain!.id,
      timezone: 'Asia/Shanghai',
    }),
  })
  expect(response.status).toBe(201)
  const payload = await response.json<{
    data: {
      user: { id: string; primaryAddress: string }
      temporaryPassword: string
    }
  }>()
  return {
    id: payload.data.user.id,
    primaryAddress: payload.data.user.primaryAddress,
    temporaryPassword: payload.data.temporaryPassword,
  }
}

async function activateMember(
  member: CreatedMember,
): Promise<ReturnType<typeof extractAuthenticationCookies>> {
  const temporaryLogin = await login(
    member.primaryAddress,
    member.temporaryPassword,
    '203.0.113.101',
  )
  expect(temporaryLogin.status).toBe(200)
  const session = extractAuthenticationCookies(temporaryLogin)
  const completed = await request('/api/auth/password/complete-required-change', {
    method: 'POST',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword: memberPassword }),
  })
  expect(completed.status).toBe(200)
  return session
}

async function createOrganizationMailboxForMember(
  memberId: string,
): Promise<OrganizationMailboxFixture> {
  const administrator = await env.DB.prepare(
    'SELECT current_admin_user_id FROM system_instances WHERE singleton_id = 1',
  ).first<{ current_admin_user_id: string }>()
  const domain = await env.DB.prepare(
    "SELECT id FROM mail_domains WHERE canonical_name = 'example.com'",
  ).first<{ id: string }>()
  const organizationId = crypto.randomUUID()
  const addressId = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organizations (
          id, name, creator_user_id, status, members_can_send,
          deletion_requested_at, deletion_due_at, created_at, updated_at
         ) VALUES (?1, '家庭组', ?2, 'active', 0, NULL, NULL, 100, 100)`,
    ).bind(organizationId, memberId),
    env.DB.prepare(
      `INSERT INTO organization_memberships (
          id, organization_id, user_id, joined_at, left_at, left_reason
         ) VALUES (?1, ?2, ?3, 100, NULL, NULL)`,
    ).bind(crypto.randomUUID(), organizationId, memberId),
    env.DB.prepare(
      `INSERT INTO organization_memberships (
          id, organization_id, user_id, joined_at, left_at, left_reason
         ) VALUES (?1, ?2, ?3, 101, NULL, NULL)`,
    ).bind(crypto.randomUUID(), organizationId, administrator!.current_admin_user_id),
    env.DB.prepare(
      `INSERT INTO email_addresses (
          id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
         ) VALUES (?1, ?2, 'family@example.com', 'family@example.com', '家庭组', 100, NULL)`,
    ).bind(addressId, domain!.id),
    env.DB.prepare(
      `INSERT INTO address_claims (
          canonical_address, address_id, status, reserved_until, created_at, updated_at
         ) VALUES ('family@example.com', ?1, 'active', NULL, 100, 100)`,
    ).bind(addressId),
    env.DB.prepare(
      `INSERT INTO address_bindings (
          id, address_id, owner_type, user_id, organization_id,
          address_role, started_at, ended_at, ended_reason
         ) VALUES (?1, ?2, 'organization', NULL, ?3, 'shared', 100, NULL, NULL)`,
    ).bind(crypto.randomUUID(), addressId, organizationId),
  ])
  return { organizationId, addressId }
}

async function deliverHtmlMailWithAttachment() {
  const tasks: BackgroundTaskMessage[] = []
  const raw = new TextEncoder().encode(
    [
      'From: 内部成员 <member@example.com>',
      'Reply-To: 成员回复地址 <member@example.com>',
      'To: 系统管理员 <owner@example.com>',
      'Cc: 外部同事 <team@outside.test>',
      'Subject: 来源邮件',
      'Message-ID: <reply-source@outside.test>',
      'In-Reply-To: <root@outside.test>',
      'References: <root@outside.test>',
      'Date: Wed, 12 Aug 2026 08:00:00 +0800',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="reply-boundary"',
      '',
      '--reply-boundary',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<div>只有这段<strong>可见文字</strong></div><script>恶意脚本</script>',
      '--reply-boundary',
      'Content-Type: text/plain; name="说明.txt"',
      'Content-Disposition: attachment; filename="说明.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      '6L2s5Y+R6ZmE5Lu25YaF5a65',
      '--reply-boundary--',
      '',
    ].join('\r\n'),
  )
  const message = {
    from: 'member@example.com',
    to: 'owner@example.com',
    rawSize: raw.byteLength,
    raw: new Blob([raw]).stream(),
    setReject: vi.fn<(reason: string) => void>(),
  } satisfies IncomingEmailMessage
  await receiveIncomingMail({
    database: env.DB,
    queue: {
      send: async (task: BackgroundTaskMessage) => tasks.push(task),
    } as unknown as Queue<BackgroundTaskMessage>,
    store: createMailObjectStore(testEnvironment, 'r2'),
    message,
    now: 1_800_000_000_000,
  })
  await processBackgroundTaskMessage({
    database: env.DB,
    message: tasks[0]!,
    now: 1_800_000_000_001,
    workerReference: 'reply-forward-test',
    executeTask: (task) =>
      processReceiveParsingTask({
        database: env.DB,
        store: createMailObjectStore(testEnvironment, 'r2'),
        queue: {
          send: async (queued: BackgroundTaskMessage) => tasks.push(queued),
        } as unknown as Queue<BackgroundTaskMessage>,
        operationId: task.targetReference,
        now: task.now,
      }),
  })
}

async function deliverOrganizationMail() {
  const raw = [
    'From: 外部客户 <customer@outside.test>',
    'To: 家庭组 <family@example.com>',
    'Subject: 组织来源邮件',
    'Message-ID: <organization-reply@outside.test>',
    'Date: Wed, 12 Aug 2026 09:00:00 +0800',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '组织成员回复全部测试。',
    '',
  ].join('\r\n')
  await deliverRawMail('family@example.com', raw, 1_800_000_100_000)
}

async function deliverRawMail(to: string, rawText: string, now: number) {
  const tasks: BackgroundTaskMessage[] = []
  const raw = new TextEncoder().encode(rawText)
  await receiveIncomingMail({
    database: env.DB,
    queue: {
      send: async (task: BackgroundTaskMessage) => tasks.push(task),
    } as unknown as Queue<BackgroundTaskMessage>,
    store: createMailObjectStore(testEnvironment, 'r2'),
    message: {
      from: 'customer@outside.test',
      to,
      rawSize: raw.byteLength,
      raw: new Blob([raw]).stream(),
      setReject: vi.fn<(reason: string) => void>(),
    } satisfies IncomingEmailMessage,
    now,
  })
  await processBackgroundTaskMessage({
    database: env.DB,
    message: tasks[0]!,
    now: now + 1,
    workerReference: 'organization-reply-test',
    executeTask: (task) =>
      processReceiveParsingTask({
        database: env.DB,
        store: createMailObjectStore(testEnvironment, 'r2'),
        queue: {
          send: async (queued: BackgroundTaskMessage) => tasks.push(queued),
        } as unknown as Queue<BackgroundTaskMessage>,
        operationId: task.targetReference,
        now: task.now,
      }),
  })
}

async function findSourceEntry(session: ReturnType<typeof extractAuthenticationCookies>) {
  const response = await request('/api/auth/mailbox/inbox', { headers: session.headers })
  const payload = await response.json<{ data: { items: Array<{ id: string }> } }>()
  const entryId = payload.data.items[0]!.id
  const row = await env.DB.prepare('SELECT message_id FROM mailbox_entries WHERE id = ?1')
    .bind(entryId)
    .first<{ message_id: string }>()
  return { entryId, messageId: row!.message_id }
}

async function createRelatedDraft(
  session: ReturnType<typeof extractAuthenticationCookies>,
  composeKind: 'reply' | 'reply_all' | 'forward',
  sourceMailboxEntryId: string,
): Promise<DraftDetail> {
  const response = await request('/api/auth/drafts', {
    method: 'POST',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ composeKind, sourceMailboxEntryId }),
  })
  const payload = await response.json<{
    data?: { draft: DraftDetail }
    error?: { message: string }
  }>()
  expect(response.status, payload.error?.message).toBe(201)
  return payload.data!.draft
}

async function createDraftWithSender(
  session: ReturnType<typeof extractAuthenticationCookies>,
  senderAddressId: string,
): Promise<DraftDetail> {
  const response = await request('/api/auth/drafts', {
    method: 'POST',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ senderAddressId }),
  })
  const payload = await response.json<{
    data?: { draft: DraftDetail }
    error?: { message: string }
  }>()
  expect(response.status, payload.error?.message).toBe(201)
  return payload.data!.draft
}

async function saveDraft(
  session: ReturnType<typeof extractAuthenticationCookies>,
  draft: DraftDetail,
  recipients: DraftDetail['recipients'],
): Promise<DraftDetail> {
  const response = await request(`/api/auth/drafts/${draft.id}`, {
    method: 'PUT',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mutationKey: crypto.randomUUID(),
      expectedRevisionNumber: draft.revisionNumber,
      senderAddressId: draft.senderAddressId,
      subject: draft.subject,
      bodyFormat: draft.bodyFormat,
      body: draft.body,
      recipients,
      attachmentIds: draft.attachments.map((attachment) => attachment.id),
    }),
  })
  expect(response.status).toBe(200)
  return (await response.json<{ data: { draft: DraftDetail } }>()).data.draft
}

function sendDraft(session: ReturnType<typeof extractAuthenticationCookies>, draft: DraftDetail) {
  return request(`/api/auth/drafts/${draft.id}/send`, {
    method: 'POST',
    headers: { ...mutationHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestKey: crypto.randomUUID(),
      expectedRevisionNumber: draft.revisionNumber,
    }),
  })
}

async function messageIdForDraft(draftId: string): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT message_id FROM send_operations WHERE source_draft_id = ?1',
  )
    .bind(draftId)
    .first<{ message_id: string }>()
  return row!.message_id
}

async function organizationEntryId(messageId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM mailbox_entries
     WHERE message_id = ?1 AND mailbox_type = 'organization' LIMIT 1`,
  )
    .bind(messageId)
    .first<{ id: string }>()
  return row?.id ?? null
}

async function readFinalMime(messageId: string): Promise<string> {
  const object = await env.DB.prepare(
    `SELECT object_key FROM object_registry
     WHERE message_id = ?1 AND object_role = 'final_mime' AND is_current = 1`,
  )
    .bind(messageId)
    .first<{ object_key: string }>()
  const stored = await createMailObjectStore(testEnvironment, 'r2').get(object!.object_key)
  return new TextDecoder().decode(stored!.bytes)
}

function login(email = 'owner@example.com', loginPassword = password, source = '203.0.113.100') {
  return request('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': source,
      'Content-Type': 'application/json',
      Origin: origin,
      'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
    },
    body: JSON.stringify({ email, password: loginPassword }),
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
  return { Cookie: session.cookie, Origin: origin, [CSRF_HEADER_NAME]: session.csrfToken }
}
