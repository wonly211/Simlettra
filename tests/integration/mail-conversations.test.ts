import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  processMessageConversationTask,
  requestMailboxConversationRebuild,
} from '../../src/modules/mail-conversations/public'
import {
  createMailObjectStore,
  processReceiveParsingTask,
  receiveIncomingMail,
  type IncomingEmailMessage,
} from '../../src/modules/mail-receiving/public'
import { getMessageConversation, listInbox } from '../../src/modules/mailbox/public'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'

interface MailTestEnvironment extends Env {
  MAIL_OBJECTS_R2: R2Bucket
}

const testEnvironment = env as MailTestEnvironment
const STARTED_AT = 1_800_000_000_000

describe('邮件会话归并', () => {
  it('按标准引用归并多级回复，同主题无关系邮件保持分离，并可完整重建', async () => {
    await seedPersonalMailbox()
    await deliver({ messageId: '<root@outside.test>', subject: '家庭账单', now: STARTED_AT })
    await deliver({
      messageId: '<reply@outside.test>',
      subject: 'Re: 家庭账单',
      inReplyTo: '<root@outside.test>',
      references: '<root@outside.test>',
      now: STARTED_AT + 10,
    })
    await deliver({ messageId: '<other@outside.test>', subject: '家庭账单', now: STARTED_AT + 20 })
    await processConversationTasks()

    const list = await listInbox({ database: env.DB, userId: 'owner-user' })
    expect(list.items).toHaveLength(2)
    expect(list.items.map((item) => item.conversationMessageCount).sort()).toEqual([1, 2])
    const thread = list.items.find((item) => item.conversationMessageCount === 2)
    expect(thread?.conversationUnreadCount).toBe(2)

    const conversation = await getMessageConversation({
      database: env.DB,
      userId: 'owner-user',
      entryId: thread!.id,
      now: STARTED_AT + 100,
    })
    expect(conversation.entries.map((entry) => entry.subject)).toEqual(['家庭账单', 'Re: 家庭账单'])

    await expect(
      requestMailboxConversationRebuild({ database: env.DB, now: STARTED_AT + 200 }),
    ).resolves.toBe(3)
    await expect(tableCount('mailbox_conversation_entries')).resolves.toBe(0)
    await processConversationTasks(STARTED_AT + 201)
    const rebuilt = await listInbox({ database: env.DB, userId: 'owner-user' })
    expect(rebuilt.items.map((item) => item.conversationMessageCount).sort()).toEqual([1, 2])
  })

  it('父邮件晚到后解析保留的引用并重建原会话', async () => {
    await seedPersonalMailbox()
    await deliver({
      messageId: '<late-child@outside.test>',
      subject: 'Re: 晚到邮件',
      inReplyTo: '<late-parent@outside.test>',
      references: '<late-parent@outside.test>',
      now: STARTED_AT,
    })
    await processConversationTasks()
    await expect(
      scalar('SELECT target_message_id FROM message_relations LIMIT 1'),
    ).resolves.toBeNull()

    await deliver({
      messageId: '<late-parent@outside.test>',
      subject: '晚到邮件',
      now: STARTED_AT + 10,
    })
    await processConversationTasks(STARTED_AT + 20)

    await expect(
      scalar("SELECT target_message_id FROM message_relations WHERE relation_type = 'in_reply_to'"),
    ).resolves.toEqual(expect.any(String))
    const list = await listInbox({ database: env.DB, userId: 'owner-user' })
    expect(list.items).toHaveLength(1)
    expect(list.items[0]?.conversationMessageCount).toBe(2)
  })

  it('重复的外部 Message-ID 不会解析或误合并到任一邮件', async () => {
    await seedPersonalMailbox()
    await deliver({ messageId: '<duplicate@outside.test>', subject: '重复一', now: STARTED_AT })
    await deliver({
      messageId: '<duplicate@outside.test>',
      subject: '重复二',
      now: STARTED_AT + 10,
    })
    await deliver({
      messageId: '<duplicate-child@outside.test>',
      subject: '引用重复标识',
      inReplyTo: '<duplicate@outside.test>',
      now: STARTED_AT + 20,
    })
    await processConversationTasks()

    await expect(
      scalar('SELECT target_message_id FROM message_relations LIMIT 1'),
    ).resolves.toBeNull()
    const list = await listInbox({ database: env.DB, userId: 'owner-user' })
    expect(list.items).toHaveLength(3)
    expect(list.items.every((item) => item.conversationMessageCount === 1)).toBe(true)
  })

  it('自发自收的同一物理邮件在会话详情中只显示一次', async () => {
    await seedPersonalMailbox()
    await deliver({ messageId: '<self@outside.test>', subject: '自发自收', now: STARTED_AT })
    await processConversationTasks()

    const source = await env.DB.prepare(
      `SELECT entry.id AS entry_id, entry.message_id, conversation.conversation_id
       FROM mailbox_entries AS entry
       JOIN mailbox_conversation_entries AS conversation
         ON conversation.mailbox_entry_id = entry.id
       LIMIT 1`,
    ).first<{ entry_id: string; message_id: string; conversation_id: string }>()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mailbox_entries (
             id, message_id, mailbox_type, user_id, organization_id,
             entry_kind, base_location, occurred_at, created_at
           ) VALUES (
             'self-sent-copy', ?1, 'user', 'owner-user', NULL,
             'sent', 'sent', ?2, ?2
           )`,
      ).bind(source!.message_id, STARTED_AT),
      env.DB.prepare(
        `INSERT INTO mailbox_conversation_entries (
             mailbox_entry_id, conversation_id, sort_at, linked_at
           ) VALUES ('self-sent-copy', ?1, ?2, ?3)`,
      ).bind(source!.conversation_id, STARTED_AT, STARTED_AT + 1),
    ])

    const conversation = await getMessageConversation({
      database: env.DB,
      userId: 'owner-user',
      entryId: 'self-sent-copy',
      now: STARTED_AT + 10,
    })
    expect(conversation.entries).toHaveLength(1)
    expect(conversation.entries[0]).toMatchObject({ id: 'self-sent-copy', subject: '自发自收' })
  })

  it('同一物理邮件的个人与组织条目建立不同范围，退出组织后不再可见', async () => {
    await seedPersonalMailbox()
    await seedOrganization()
    await deliver({ messageId: '<shared@outside.test>', subject: '双范围', now: STARTED_AT })
    const message = await env.DB.prepare('SELECT id FROM messages LIMIT 1').first<{ id: string }>()
    await env.DB.prepare(
      `INSERT INTO mailbox_entries (
         id, message_id, mailbox_type, user_id, organization_id,
         entry_kind, base_location, occurred_at, created_at
       ) VALUES (
         'organization-copy', ?1, 'organization', NULL, 'shared-organization',
         'received', 'inbox', ?2, ?2
       )`,
    )
      .bind(message!.id, STARTED_AT)
      .run()
    await requestMailboxConversationRebuild({ database: env.DB, now: STARTED_AT + 10 })
    await processConversationTasks(STARTED_AT + 11)

    const visible = await listInbox({ database: env.DB, userId: 'owner-user', scope: 'all' })
    expect(visible.items).toHaveLength(2)
    const scopes = await env.DB.prepare(
      `SELECT mailbox_type, COUNT(*) AS count
       FROM mailbox_conversations GROUP BY mailbox_type ORDER BY mailbox_type`,
    ).all<{ mailbox_type: string; count: number }>()
    expect(scopes.results).toEqual([
      { mailbox_type: 'organization', count: 1 },
      { mailbox_type: 'user', count: 1 },
    ])

    await env.DB.prepare(
      `UPDATE organization_memberships
       SET left_at = ?1, left_reason = 'member_exited'
       WHERE id = 'shared-membership'`,
    )
      .bind(STARTED_AT + 20)
      .run()
    const afterLeaving = await listInbox({ database: env.DB, userId: 'owner-user', scope: 'all' })
    expect(afterLeaving.items).toHaveLength(1)
    await expect(
      getMessageConversation({
        database: env.DB,
        userId: 'owner-user',
        entryId: 'organization-copy',
        now: STARTED_AT + 21,
      }),
    ).rejects.toThrow('邮件不存在或无权访问')
  })
})

async function deliver(options: {
  messageId: string
  subject: string
  inReplyTo?: string
  references?: string
  now: number
}) {
  const queue = createCapturedQueue()
  const result = await receiveIncomingMail({
    database: env.DB,
    queue: queue.binding,
    store: createMailObjectStore(testEnvironment, 'r2'),
    message: createIncomingMessage(options),
    now: options.now,
  })
  expect(result.status).toBe('accepted')
  await processBackgroundTaskMessage({
    database: env.DB,
    message: queue.messages[0]!,
    now: options.now + 1,
    workerReference: `conversation-parse-${options.messageId}`,
    executeTask: (task) =>
      processReceiveParsingTask({
        database: env.DB,
        store: createMailObjectStore(testEnvironment, 'r2'),
        operationId: task.targetReference,
        now: task.now,
      }),
  })
}

async function processConversationTasks(now = STARTED_AT + 100) {
  const tasks = await env.DB.prepare(
    `SELECT id, input_version FROM background_tasks
     WHERE task_type = 'rebuild_conversation' AND task_status IN ('pending', 'retry_wait')
     ORDER BY created_at, id`,
  ).all<{ id: string; input_version: number }>()
  for (const task of tasks.results) {
    await processBackgroundTaskMessage({
      database: env.DB,
      message: { taskId: task.id, inputVersion: task.input_version },
      now,
      workerReference: `conversation-task-${task.id}`,
      executeTask: (context) =>
        processMessageConversationTask({
          database: env.DB,
          messageId: context.targetReference,
          now: context.now,
        }),
    })
  }
}

function createCapturedQueue() {
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

function createIncomingMessage(options: {
  messageId: string
  subject: string
  inReplyTo?: string
  references?: string
  now: number
}): IncomingEmailMessage {
  const headers = [
    'From: Sender <sender@outside.test>',
    'To: Owner <owner@example.test>',
    `Subject: ${options.subject}`,
    `Message-ID: ${options.messageId}`,
    options.inReplyTo ? `In-Reply-To: ${options.inReplyTo}` : null,
    options.references ? `References: ${options.references}` : null,
    'Date: Wed, 12 Aug 2026 08:00:00 +0800',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `正文：${options.subject}`,
    '',
  ].filter((line): line is string => line !== null)
  const raw = headers.join('\r\n')
  const bytes = new TextEncoder().encode(raw)
  return {
    from: 'sender@outside.test',
    to: 'owner@example.test',
    rawSize: bytes.byteLength,
    raw: new Blob([bytes]).stream(),
    setReject: vi.fn<(reason: string) => void>(),
  }
}

async function seedPersonalMailbox() {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, status, display_name, timezone, invitation_policy,
         deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
       ) VALUES (
         'owner-user', 'active', '管理员', 'Asia/Shanghai', 'manual',
         NULL, NULL, NULL, 100, 100
       )`,
    ),
    env.DB.prepare(
      `INSERT INTO mail_domains (
         id, canonical_name, display_name, status, catch_all_mode,
         paused_at, created_at, updated_at
       ) VALUES (
         'mail-domain', 'example.test', 'example.test', 'active', 'reject',
         NULL, 100, 100
       )`,
    ),
    env.DB.prepare(
      `INSERT INTO email_addresses (
         id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
       ) VALUES (
         'mail-address', 'mail-domain', 'owner@example.test', 'owner@example.test',
         NULL, 100, NULL
       )`,
    ),
    env.DB.prepare(
      `INSERT INTO address_claims (
         canonical_address, address_id, status, reserved_until, created_at, updated_at
       ) VALUES ('owner@example.test', 'mail-address', 'active', NULL, 100, 100)`,
    ),
    env.DB.prepare(
      `INSERT INTO address_bindings (
         id, address_id, owner_type, user_id, organization_id,
         address_role, started_at, ended_at, ended_reason
       ) VALUES (
         'mail-binding', 'mail-address', 'user', 'owner-user', NULL,
         'primary', 100, NULL, NULL
       )`,
    ),
    env.DB.prepare(
      `INSERT INTO system_instances (
         singleton_id, storage_mode, current_admin_user_id, initialized_at, created_at, updated_at
       ) VALUES (1, 'r2', 'owner-user', 100, 100, 100)`,
    ),
  ])
}

async function seedOrganization() {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, status, display_name, timezone, invitation_policy,
         deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
       ) VALUES (
         'creator-user', 'active', '组织创建者', 'Asia/Shanghai', 'manual',
         NULL, NULL, NULL, 90, 90
       )`,
    ),
    env.DB.prepare(
      `INSERT INTO user_organization_policies (
         user_id, organization_limit, updated_by_user_id, created_at, updated_at
       ) VALUES
         ('owner-user', 5, NULL, 100, 100),
         ('creator-user', 5, NULL, 90, 90)`,
    ),
    env.DB.prepare(
      `INSERT INTO organizations (
         id, name, creator_user_id, status, members_can_send,
         deletion_requested_at, deletion_due_at, created_at, updated_at
       ) VALUES (
         'shared-organization', '共享邮箱', 'creator-user', 'active', 0,
         NULL, NULL, 100, 100
       )`,
    ),
    env.DB.prepare(
      `INSERT INTO organization_memberships (
         id, organization_id, user_id, joined_at, left_at, left_reason
       ) VALUES (
         'creator-membership', 'shared-organization', 'creator-user', 90, NULL, NULL
       ), (
         'shared-membership', 'shared-organization', 'owner-user', 100, NULL, NULL
       )`,
    ),
  ])
}

async function tableCount(table: string): Promise<number> {
  return (await scalar<number>(`SELECT COUNT(*) FROM ${table}`)) ?? 0
}

async function scalar<T = string>(query: string): Promise<T | null> {
  const row = await env.DB.prepare(query).first<Record<string, T>>()
  return row ? (Object.values(row)[0] ?? null) : null
}
