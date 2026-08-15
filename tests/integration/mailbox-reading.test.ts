import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMailObjectStore,
  processReceiveParsingTask,
  receiveIncomingMail,
  type IncomingEmailMessage,
} from '../../src/modules/mail-receiving/public'
import {
  ensurePendingMessageIndexTasks,
  processMessageIndexTask,
  requestMessageSearchRebuild,
} from '../../src/modules/mail-search/public'
import {
  getAttachmentDownload,
  getMessageDetail,
  listInbox,
  MailboxAccessError,
  MailboxInputError,
  organizeMailboxEntries,
  permanentlyDeleteMailboxEntry,
  processExpiredMailboxTrash,
  processMailboxDeletionTask,
  removeTrustedSender,
  updateReadState,
  updateRemoteImagePermission,
} from '../../src/modules/mailbox/public'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'

interface MailboxTestEnvironment extends Env {
  MAIL_OBJECTS_R2: R2Bucket
}

const testEnvironment = env as MailboxTestEnvironment
const NOW = 1_800_000_000_000

describe('收件箱与安全读信', () => {
  beforeEach(async () => {
    await seedMailboxActors()
    await deliver('owner@example.test', 'owner-message', NOW + 100)
    await deliver('member@example.test', 'member-message', NOW + 200)
    await deliver('shared@example.test', 'organization-message', NOW + 300)
  })

  it('集中列出个人与当前组织邮件，并使用稳定游标筛选', async () => {
    const firstPage = await listInbox({
      database: env.DB,
      userId: 'owner-user',
      limit: 1,
    })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.items[0]).toMatchObject({
      mailboxType: 'organization',
      subject: 'organization-message',
      isRead: false,
      hasAttachments: true,
    })
    expect(firstPage.nextCursor).not.toBeNull()
    expect(firstPage.organizations).toEqual([{ id: 'mail-organization', name: '共享邮箱' }])

    const secondPage = await listInbox({
      database: env.DB,
      userId: 'owner-user',
      limit: 1,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.items[0]).toMatchObject({
      mailboxType: 'user',
      subject: 'owner-message',
    })
    expect(secondPage.nextCursor).toBeNull()

    const personal = await listInbox({
      database: env.DB,
      userId: 'owner-user',
      scope: 'personal',
    })
    expect(personal.items.map((item) => item.subject)).toEqual(['owner-message'])

    await expect(
      listInbox({ database: env.DB, userId: 'owner-user', cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(MailboxInputError)
  })

  it('读取正文、邮件头、实际投递地址和经过授权的附件对象', async () => {
    const entryId = await entryIdForSubject('owner-message')
    const detail = await getMessageDetail({
      database: env.DB,
      objectStore: createMailObjectStore(testEnvironment, 'r2'),
      userId: 'owner-user',
      entryId,
    })

    expect(detail).toMatchObject({
      id: entryId,
      mailboxType: 'user',
      subject: 'owner-message',
      isRead: false,
      remoteImagesAllowed: false,
    })
    expect(detail.plainTextBody).toContain('安全读信测试')
    expect(detail.untrustedHtmlBody).toContain('onerror="alert(1)"')
    expect(detail.addresses.some((address) => address.role === 'bcc')).toBe(false)
    expect(detail.actualDeliveryAddresses).toEqual(['owner@example.test'])
    expect(detail.attachments[0]).toMatchObject({
      fileName: 'report.txt',
      previewable: false,
    })

    const attachment = await getAttachmentDownload({
      database: env.DB,
      objectStore: createMailObjectStore(testEnvironment, 'r2'),
      userId: 'owner-user',
      entryId,
      objectId: detail.attachments[0]!.id,
    })
    expect(new TextDecoder().decode(attachment.bytes)).toBe('attachment')
    expect(attachment.fileName).toBe('report.txt')
  })

  it('索引完成前说明正在建立，完成后支持中文正文与组合搜索', async () => {
    const building = await listInbox({
      database: env.DB,
      userId: 'owner-user',
      body: '安全读信',
    })
    expect(building.items).toEqual([])
    expect(building.searchIndex).toMatchObject({ status: 'building', pendingMessageCount: 2 })

    await processAllSearchTasks()
    const body = await listInbox({
      database: env.DB,
      userId: 'owner-user',
      body: '安全读信',
      sender: 'outside.test',
      recipient: 'recipient',
      attachment: 'with',
      sort: 'attachments',
    })
    expect(body.searchIndex).toEqual({ status: 'ready', pendingMessageCount: 0 })
    expect(body.items.map((item) => item.subject)).toEqual([
      'organization-message',
      'owner-message',
    ])

    const headerAndDelivery = await listInbox({
      database: env.DB,
      userId: 'owner-user',
      subject: 'owner-message',
      mailboxAddress: 'owner@example.test',
      dateFrom: NOW,
      dateTo: NOW + 150,
      read: 'unread',
      starred: 'unstarred',
      archived: 'unarchived',
    })
    expect(headerAndDelivery.items.map((item) => item.subject)).toEqual(['owner-message'])

    const hiddenBcc = await listInbox({
      database: env.DB,
      userId: 'owner-user',
      recipient: 'hidden@outside.test',
    })
    expect(hiddenBcc.items).toEqual([])
    await expect(
      listInbox({ database: env.DB, userId: 'owner-user', body: '安' }),
    ).rejects.toMatchObject({ field: 'body' })
  })

  it('正文候选仍经过当前组织成员授权，退出后不能发现组织邮件', async () => {
    await processAllSearchTasks()
    const beforeLeaving = await listInbox({
      database: env.DB,
      userId: 'member-user',
      scope: 'organization',
      organizationId: 'mail-organization',
      body: '安全读信',
    })
    expect(beforeLeaving.items.map((item) => item.subject)).toEqual(['organization-message'])

    await env.DB.prepare(
      `UPDATE organization_memberships
       SET left_at = ?1, left_reason = 'member_exited'
       WHERE organization_id = 'mail-organization' AND user_id = 'member-user'`,
    )
      .bind(NOW + 2_000)
      .run()
    const afterLeaving = await listInbox({
      database: env.DB,
      userId: 'member-user',
      scope: 'organization',
      organizationId: 'mail-organization',
      body: '安全读信',
    })
    expect(afterLeaving.items).toEqual([])
  })

  it('可以丢弃派生结果并从当前正文对象完整重建索引', async () => {
    await processAllSearchTasks()
    expect(
      (await listInbox({ database: env.DB, userId: 'owner-user', body: '安全读信' })).items,
    ).toHaveLength(2)

    await expect(requestMessageSearchRebuild({ database: env.DB, now: NOW + 2_100 })).resolves.toBe(
      3,
    )
    const rebuilding = await listInbox({
      database: env.DB,
      userId: 'owner-user',
      body: '安全读信',
    })
    expect(rebuilding.items).toEqual([])
    expect(rebuilding.searchIndex?.status).toBe('building')

    await expect(
      ensurePendingMessageIndexTasks({ database: env.DB, now: NOW + 2_101 }),
    ).resolves.toBe(3)
    await processAllSearchTasks(NOW + 2_102)
    const rebuilt = await listInbox({
      database: env.DB,
      userId: 'owner-user',
      body: '安全读信',
    })
    expect(rebuilt.searchIndex?.status).toBe('ready')
    expect(rebuilt.items).toHaveLength(2)
  })

  it('每名组织成员独立维护已读状态，退出后立即失去访问', async () => {
    const entryId = await entryIdForSubject('organization-message')
    await updateReadState({
      database: env.DB,
      userId: 'owner-user',
      entryId,
      isRead: true,
      now: NOW + 400,
    })

    const ownerDetail = await detailFor('owner-user', entryId)
    const memberDetail = await detailFor('member-user', entryId)
    expect(ownerDetail.isRead).toBe(true)
    expect(memberDetail.isRead).toBe(false)

    await updateReadState({
      database: env.DB,
      userId: 'owner-user',
      entryId,
      isRead: false,
      now: NOW + 450,
    })
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM mailbox_user_states
         WHERE mailbox_entry_id = ?1 AND user_id = 'owner-user'`,
      )
        .bind(entryId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 })

    await env.DB.prepare(
      `UPDATE organization_memberships
       SET left_at = ?1, left_reason = 'member_exited'
       WHERE organization_id = 'mail-organization' AND user_id = 'member-user'`,
    )
      .bind(NOW + 500)
      .run()

    await expect(detailFor('member-user', entryId)).rejects.toMatchObject({ code: 'not_found' })
    expect((await detailFor('owner-user', entryId)).isRead).toBe(false)
  })

  it('管理员身份不会授予另一名用户个人邮件访问权', async () => {
    const memberEntryId = await entryIdForSubject('member-message')
    await expect(detailFor('owner-user', memberEntryId)).rejects.toBeInstanceOf(MailboxAccessError)
    await expect(
      getAttachmentDownload({
        database: env.DB,
        objectStore: createMailObjectStore(testEnvironment, 'r2'),
        userId: 'owner-user',
        entryId: memberEntryId,
        objectId: 'unknown-object',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('分别保存单封放行、可信发件人和单封阻止设置', async () => {
    const ownerEntryId = await entryIdForSubject('owner-message')
    const organizationEntryId = await entryIdForSubject('organization-message')

    const oneMessage = await updateRemoteImagePermission({
      database: env.DB,
      userId: 'owner-user',
      entryId: ownerEntryId,
      mode: 'message',
      now: NOW + 600,
    })
    expect(oneMessage).toMatchObject({
      remoteImagesAllowed: true,
      remoteImagePermission: 'message',
    })
    const resetOneMessage = await updateRemoteImagePermission({
      database: env.DB,
      userId: 'owner-user',
      entryId: ownerEntryId,
      mode: 'block',
      now: NOW + 650,
    })
    expect(resetOneMessage.remoteImagePermission).toBe('default')

    const trusted = await updateRemoteImagePermission({
      database: env.DB,
      userId: 'owner-user',
      entryId: organizationEntryId,
      mode: 'sender',
      now: NOW + 700,
    })
    expect(trusted.trustedSenderAddress).toBe('sender@outside.test')
    expect((await detailFor('owner-user', organizationEntryId)).remoteImagePermission).toBe(
      'sender',
    )

    const blocked = await updateRemoteImagePermission({
      database: env.DB,
      userId: 'owner-user',
      entryId: organizationEntryId,
      mode: 'block',
      now: NOW + 800,
    })
    expect(blocked).toMatchObject({
      remoteImagesAllowed: false,
      remoteImagePermission: 'blocked',
    })

    await removeTrustedSender({
      database: env.DB,
      userId: 'owner-user',
      canonicalSenderAddress: 'sender@outside.test',
    })
    const afterRemoval = await detailFor('owner-user', organizationEntryId)
    expect(afterRemoval.trustedSenderAddress).toBeNull()
    expect(afterRemoval.remoteImagesAllowed).toBe(false)
  })

  it('按当前用户状态提供星标、归档、垃圾邮件和全部邮件视图', async () => {
    const personalEntryId = await entryIdForSubject('owner-message')
    const organizationEntryId = await entryIdForSubject('organization-message')

    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [personalEntryId],
      action: 'archive',
      now: NOW + 900,
    })
    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [personalEntryId, organizationEntryId],
      action: 'star',
      now: NOW + 901,
    })

    expect((await listInbox({ database: env.DB, userId: 'owner-user' })).items).toHaveLength(1)
    expect(
      (
        await listInbox({ database: env.DB, userId: 'owner-user', view: 'archive', now: NOW + 902 })
      ).items.map((item) => item.subject),
    ).toEqual(['owner-message'])
    expect(
      (
        await listInbox({ database: env.DB, userId: 'owner-user', view: 'starred', now: NOW + 902 })
      ).items.map((item) => item.subject),
    ).toEqual(['organization-message', 'owner-message'])
    expect(
      (
        await listInbox({ database: env.DB, userId: 'owner-user', view: 'all', now: NOW + 902 })
      ).items.map((item) => item.subject),
    ).toEqual(['organization-message', 'owner-message'])

    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [organizationEntryId],
      action: 'mark_spam',
      now: NOW + 903,
    })
    expect(
      (
        await listInbox({ database: env.DB, userId: 'owner-user', view: 'spam', now: NOW + 904 })
      ).items.map((item) => item.subject),
    ).toEqual(['organization-message'])
    expect(
      (
        await listInbox({ database: env.DB, userId: 'member-user', view: 'inbox', now: NOW + 904 })
      ).items.map((item) => item.subject),
    ).toContain('organization-message')
  })

  it('垃圾箱保留三十天、可以恢复，并在到期后立即停止访问', async () => {
    const entryId = await entryIdForSubject('owner-message')
    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [entryId],
      action: 'move_to_trash',
      now: NOW + 1_000,
    })

    const trash = await listInbox({
      database: env.DB,
      userId: 'owner-user',
      view: 'trash',
      now: NOW + 1_001,
    })
    expect(trash.items[0]).toMatchObject({
      id: entryId,
      location: 'trash',
      trashDueAt: NOW + 1_000 + 30 * 24 * 60 * 60 * 1000,
    })

    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [entryId],
      action: 'restore_from_trash',
      now: NOW + 1_002,
    })
    expect((await detailFor('owner-user', entryId)).location).toBe('inbox')

    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [entryId],
      action: 'move_to_trash',
      now: NOW + 2_000,
    })
    const dueAt = NOW + 2_000 + 30 * 24 * 60 * 60 * 1000
    await expect(
      getMessageDetail({
        database: env.DB,
        objectStore: createMailObjectStore(testEnvironment, 'r2'),
        userId: 'owner-user',
        entryId,
        now: dueAt,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(await processExpiredMailboxTrash({ database: env.DB, now: dueAt, limit: 90 })).toBe(1)
    await expect(tableCount('mailbox_entries', 'id', entryId)).resolves.toBe(0)
    await expect(
      env.DB.prepare(
        `SELECT actor_type, action_name, reason_code FROM audit_events
         WHERE target_type = 'mailbox_entry' AND target_reference = ?1`,
      )
        .bind(entryId)
        .first(),
    ).resolves.toMatchObject({
      actor_type: 'system',
      action_name: 'mailbox_entry.permanently_deleted',
      reason_code: 'trash_retention_expired',
    })
  })

  it('个人永久删除立即撤销访问，并在后台清理最后一份物理邮件和对象', async () => {
    const entryId = await entryIdForSubject('owner-message')
    const messageId = await messageIdForEntry(entryId)
    const objectKeys = await objectKeysForMessage(messageId)
    await processAllSearchTasks()
    expect(await tableCount('message_search_states', 'message_id', messageId)).toBe(1)
    expect(await tableCount('message_search_chunks', 'message_id', messageId)).toBeGreaterThan(0)
    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [entryId],
      action: 'move_to_trash',
      now: NOW + 1_200,
    })
    expect((await detailFor('owner-user', entryId)).canPermanentlyDelete).toBe(true)
    const usageBeforeDeletion = await logicalUsage('user', 'owner-user')

    const result = await permanentlyDeleteMailboxEntry({
      database: env.DB,
      actorUserId: 'owner-user',
      entryId,
      audit: auditContext('personal-delete'),
      now: NOW + 1_201,
    })
    expect(result).toMatchObject({
      entryId,
      deletionScope: 'personal',
      affectedMemberCount: 1,
      physicalCleanupScheduled: true,
    })
    await expect(detailFor('owner-user', entryId)).rejects.toMatchObject({ code: 'not_found' })
    await expect(logicalUsage('user', 'owner-user')).resolves.toEqual({
      committed_bytes: usageBeforeDeletion!.committed_bytes - (await messageSize(messageId)),
      reserved_bytes: 0,
    })
    expect(await tableCount('messages', 'id', messageId)).toBe(1)

    await processDeletionOperation(result.deletionOperationId, NOW + 1_202)
    expect(await tableCount('messages', 'id', messageId)).toBe(0)
    expect(await tableCount('object_registry', 'message_id', messageId)).toBe(0)
    expect(await tableCount('message_search_states', 'message_id', messageId)).toBe(0)
    expect(await tableCount('message_search_chunks', 'message_id', messageId)).toBe(0)
    for (const key of objectKeys) {
      await expect(testEnvironment.MAIL_OBJECTS_R2.get(key)).resolves.toBeNull()
    }
    await expect(
      env.DB.prepare(`SELECT operation_status FROM deletion_operations WHERE id = ?1`)
        .bind(result.deletionOperationId)
        .first(),
    ).resolves.toEqual({ operation_status: 'completed' })
  })

  it('删除共享物理邮件的一份个人副本时保留其他邮箱和全部对象', async () => {
    const ownerEntryId = await entryIdForSubject('owner-message')
    const messageId = await messageIdForEntry(ownerEntryId)
    const memberEntryId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO mailbox_entries (
         id, message_id, mailbox_type, user_id, organization_id,
         entry_kind, base_location, occurred_at, created_at
       ) VALUES (?1, ?2, 'user', 'member-user', NULL, 'received', 'inbox', ?3, ?3)`,
    )
      .bind(memberEntryId, messageId, NOW + 1_300)
      .run()
    const objectCount = await tableCount('object_registry', 'message_id', messageId)

    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [ownerEntryId],
      action: 'move_to_trash',
      now: NOW + 1_301,
    })
    const result = await permanentlyDeleteMailboxEntry({
      database: env.DB,
      actorUserId: 'owner-user',
      entryId: ownerEntryId,
      audit: auditContext('shared-delete'),
      now: NOW + 1_302,
    })
    expect(result.physicalCleanupScheduled).toBe(false)
    await processDeletionOperation(result.deletionOperationId, NOW + 1_303)

    expect((await detailFor('member-user', memberEntryId)).subject).toBe('owner-message')
    expect(await tableCount('messages', 'id', messageId)).toBe(1)
    expect(await tableCount('object_registry', 'message_id', messageId)).toBe(objectCount)
  })

  it('同一用户仍有这封邮件的其他邮箱条目时不提前归还容量', async () => {
    const receivedEntryId = await entryIdForSubject('owner-message')
    const messageId = await messageIdForEntry(receivedEntryId)
    const sentEntryId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO mailbox_entries (
         id, message_id, mailbox_type, user_id, organization_id,
         entry_kind, base_location, occurred_at, created_at
       ) VALUES (?1, ?2, 'user', 'owner-user', NULL, 'sent', 'sent', ?3, ?3)`,
    )
      .bind(sentEntryId, messageId, NOW + 1_350)
      .run()
    const initialUsage = await logicalUsage('user', 'owner-user')

    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [receivedEntryId],
      action: 'move_to_trash',
      now: NOW + 1_351,
    })
    const first = await permanentlyDeleteMailboxEntry({
      database: env.DB,
      actorUserId: 'owner-user',
      entryId: receivedEntryId,
      audit: auditContext('owner-first-copy'),
      now: NOW + 1_352,
    })
    await processDeletionOperation(first.deletionOperationId, NOW + 1_353)
    await expect(logicalUsage('user', 'owner-user')).resolves.toEqual(initialUsage)

    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [sentEntryId],
      action: 'move_to_trash',
      now: NOW + 1_354,
    })
    const second = await permanentlyDeleteMailboxEntry({
      database: env.DB,
      actorUserId: 'owner-user',
      entryId: sentEntryId,
      audit: auditContext('owner-last-copy'),
      now: NOW + 1_355,
    })
    await expect(logicalUsage('user', 'owner-user')).resolves.toEqual({
      committed_bytes: initialUsage!.committed_bytes - (await messageSize(messageId)),
      reserved_bytes: 0,
    })
    expect(second.physicalCleanupScheduled).toBe(true)
  })

  it('组织普通成员不能永久删除，创建者确认后全体成员立即失去访问', async () => {
    const entryId = await entryIdForSubject('organization-message')
    await organizeMailboxEntries({
      database: env.DB,
      userId: 'member-user',
      entryIds: [entryId],
      action: 'move_to_trash',
      now: NOW + 1_400,
    })
    expect((await detailFor('member-user', entryId)).canPermanentlyDelete).toBe(false)
    await expect(
      permanentlyDeleteMailboxEntry({
        database: env.DB,
        actorUserId: 'member-user',
        entryId,
        audit: auditContext('member-denied'),
        now: NOW + 1_401,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' })

    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [entryId],
      action: 'move_to_trash',
      now: NOW + 1_402,
    })
    const detail = await detailFor('owner-user', entryId)
    expect(detail.canPermanentlyDelete).toBe(true)
    const result = await permanentlyDeleteMailboxEntry({
      database: env.DB,
      actorUserId: 'owner-user',
      entryId,
      audit: auditContext('organization-delete'),
      now: NOW + 1_403,
    })
    expect(result).toMatchObject({ deletionScope: 'organization', affectedMemberCount: 2 })
    await expect(detailFor('owner-user', entryId)).rejects.toMatchObject({ code: 'not_found' })
    await expect(detailFor('member-user', entryId)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('组织成员垃圾箱到期只隐藏自己的状态，不删除组织原始邮件', async () => {
    const entryId = await entryIdForSubject('organization-message')
    await organizeMailboxEntries({
      database: env.DB,
      userId: 'member-user',
      entryIds: [entryId],
      action: 'move_to_trash',
      now: NOW + 1_500,
    })
    const dueAt = NOW + 1_500 + 30 * 24 * 60 * 60 * 1000
    expect(await processExpiredMailboxTrash({ database: env.DB, now: dueAt })).toBe(1)
    await expect(
      env.DB.prepare(
        `SELECT location_override, hidden_at FROM mailbox_user_states
         WHERE mailbox_entry_id = ?1 AND user_id = 'member-user'`,
      )
        .bind(entryId)
        .first(),
    ).resolves.toMatchObject({ location_override: 'hidden', hidden_at: dueAt })
    expect((await detailFor('owner-user', entryId)).subject).toBe('organization-message')
    expect(await tableCount('mailbox_entries', 'id', entryId)).toBe(1)
  })

  it('对象删除暂时失败时保留任务和待删除状态，重试后完成清理', async () => {
    const entryId = await entryIdForSubject('owner-message')
    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [entryId],
      action: 'move_to_trash',
      now: NOW + 1_600,
    })
    const deletion = await permanentlyDeleteMailboxEntry({
      database: env.DB,
      actorUserId: 'owner-user',
      entryId,
      audit: auditContext('retry-delete'),
      now: NOW + 1_601,
    })
    const task = await deletionTask(deletion.deletionOperationId)
    const realStore = createMailObjectStore(testEnvironment, 'r2')
    let failOnce = true
    const failingStore = {
      ...realStore,
      async delete(key: string) {
        if (failOnce) {
          failOnce = false
          throw new Error('模拟对象存储暂时失败')
        }
        await realStore.delete(key)
      },
    }

    await processBackgroundTaskMessage({
      database: env.DB,
      message: { taskId: task.id, inputVersion: task.input_version },
      now: NOW + 1_602,
      workerReference: 'mailbox-delete-failure',
      executeTask: (context) =>
        processMailboxDeletionTask({
          database: env.DB,
          objectStore: failingStore,
          deletionOperationId: context.targetReference,
          inputVersion: context.inputVersion,
          now: context.now,
        }),
    })
    await expect(taskStatus(task.id)).resolves.toBe('retry_wait')
    await expect(
      env.DB.prepare(
        `SELECT integrity_status FROM message_integrity_states
         WHERE message_id = (SELECT target_reference FROM deletion_operations WHERE id = ?1)`,
      )
        .bind(deletion.deletionOperationId)
        .first(),
    ).resolves.toEqual({ integrity_status: 'pending_delete' })

    await processBackgroundTaskMessage({
      database: env.DB,
      message: { taskId: task.id, inputVersion: task.input_version },
      now: NOW + 1_602 + 2 * 60 * 1000,
      workerReference: 'mailbox-delete-retry',
      executeTask: (context) =>
        processMailboxDeletionTask({
          database: env.DB,
          objectStore: failingStore,
          deletionOperationId: context.targetReference,
          inputVersion: context.inputVersion,
          now: context.now,
        }),
    })
    await expect(taskStatus(task.id)).resolves.toBe('succeeded')
  })

  it('批量操作先核对整批权限，失败时不会留下部分状态', async () => {
    const ownerEntryId = await entryIdForSubject('owner-message')
    const memberEntryId = await entryIdForSubject('member-message')
    await expect(
      organizeMailboxEntries({
        database: env.DB,
        userId: 'owner-user',
        entryIds: [ownerEntryId, memberEntryId],
        action: 'star',
        now: NOW + 1_100,
      }),
    ).rejects.toBeInstanceOf(MailboxAccessError)
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM mailbox_user_states
         WHERE mailbox_entry_id = ?1 AND user_id = 'owner-user'`,
      )
        .bind(ownerEntryId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 })

    const organizationEntryId = await entryIdForSubject('organization-message')
    await organizeMailboxEntries({
      database: env.DB,
      userId: 'owner-user',
      entryIds: [ownerEntryId, organizationEntryId],
      action: 'mark_read',
      now: NOW + 1_101,
    })
    expect((await detailFor('owner-user', ownerEntryId)).isRead).toBe(true)
    expect((await detailFor('owner-user', organizationEntryId)).isRead).toBe(true)
    expect((await detailFor('member-user', organizationEntryId)).isRead).toBe(false)
  })

  it('数据库拒绝越权建立邮箱个人状态', async () => {
    const memberEntryId = await entryIdForSubject('member-message')
    await expect(
      env.DB.prepare(
        `INSERT INTO mailbox_user_states (mailbox_entry_id, user_id, is_read, updated_at)
         VALUES (?1, 'owner-user', 1, ?2)`,
      )
        .bind(memberEntryId, NOW + 900)
        .run(),
    ).rejects.toThrow()

    const organizationEntryId = await entryIdForSubject('organization-message')
    await env.DB.prepare(
      `UPDATE organization_memberships
       SET left_at = ?1, left_reason = 'member_exited'
       WHERE organization_id = 'mail-organization' AND user_id = 'member-user'`,
    )
      .bind(NOW + 901)
      .run()
    await expect(
      env.DB.prepare(
        `INSERT INTO mailbox_user_states (mailbox_entry_id, user_id, is_read, updated_at)
         VALUES (?1, 'member-user', 1, ?2)`,
      )
        .bind(organizationEntryId, NOW + 902)
        .run(),
    ).rejects.toThrow()
  })
})

async function detailFor(userId: string, entryId: string) {
  return getMessageDetail({
    database: env.DB,
    objectStore: createMailObjectStore(testEnvironment, 'r2'),
    userId,
    entryId,
  })
}

async function deliver(recipient: string, subject: string, now: number): Promise<void> {
  const queue = createCapturedQueue()
  const result = await receiveIncomingMail({
    database: env.DB,
    queue: queue.binding,
    store: createMailObjectStore(testEnvironment, 'r2'),
    message: createIncomingMessage(recipient, subject),
    now,
  })
  expect(result.status).toBe('accepted')
  await processBackgroundTaskMessage({
    database: env.DB,
    message: queue.messages[0]!,
    now: now + 1,
    workerReference: `mailbox-test-${subject}`,
    executeTask: (task) =>
      processReceiveParsingTask({
        database: env.DB,
        store: createMailObjectStore(testEnvironment, 'r2'),
        operationId: task.targetReference,
        now: task.now,
      }),
  })
}

function createCapturedQueue(): {
  binding: Queue<BackgroundTaskMessage>
  messages: BackgroundTaskMessage[]
} {
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

function createIncomingMessage(to: string, subject: string): IncomingEmailMessage {
  const bytes = new TextEncoder().encode(messageSource(to, subject))
  return {
    from: 'sender@outside.test',
    to,
    rawSize: bytes.byteLength,
    raw: new Blob([bytes]).stream(),
    setReject: vi.fn<(reason: string) => void>(),
  }
}

function messageSource(to: string, subject: string): string {
  return [
    'From: Sender <sender@outside.test>',
    `To: Recipient <${to}>`,
    'Bcc: Hidden <hidden@outside.test>',
    `Subject: ${subject}`,
    `Message-ID: <${subject}@outside.test>`,
    'Date: Wed, 12 Aug 2026 08:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mailbox-boundary"',
    '',
    '--mailbox-boundary',
    'Content-Type: multipart/alternative; boundary="body-boundary"',
    '',
    '--body-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '安全读信测试。',
    '--body-boundary',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>安全读信测试<img src="https://tracker.invalid/pixel" onerror="alert(1)"></p>',
    '--body-boundary--',
    '--mailbox-boundary',
    'Content-Type: text/plain; name="report.txt"',
    'Content-Disposition: attachment; filename="report.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    'YXR0YWNobWVudA==',
    '--mailbox-boundary--',
    '',
  ].join('\r\n')
}

async function entryIdForSubject(subject: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT entry.id
     FROM mailbox_entries AS entry
     JOIN messages AS message ON message.id = entry.message_id
     WHERE message.subject = ?1`,
  )
    .bind(subject)
    .first<{ id: string }>()
  if (!row) throw new Error(`没有找到测试邮件：${subject}`)
  return row.id
}

async function messageIdForEntry(entryId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT message_id FROM mailbox_entries WHERE id = ?1')
    .bind(entryId)
    .first<{ message_id: string }>()
  if (!row) throw new Error('没有找到邮箱条目的物理邮件')
  return row.message_id
}

async function objectKeysForMessage(messageId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT object_key FROM object_registry WHERE message_id = ?1 ORDER BY id',
  )
    .bind(messageId)
    .all<{ object_key: string }>()
  return rows.results.map((row) => row.object_key)
}

async function tableCount(table: string, field: string, value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${field} = ?1`)
    .bind(value)
    .first<{ count: number }>()
  return row?.count ?? 0
}

async function processDeletionOperation(operationId: string, now: number): Promise<void> {
  const task = await deletionTask(operationId)
  await processBackgroundTaskMessage({
    database: env.DB,
    message: { taskId: task.id, inputVersion: task.input_version },
    now,
    workerReference: `mailbox-delete-test-${operationId}`,
    executeTask: (context) =>
      processMailboxDeletionTask({
        database: env.DB,
        objectStore: createMailObjectStore(testEnvironment, 'r2'),
        deletionOperationId: context.targetReference,
        inputVersion: context.inputVersion,
        now: context.now,
      }),
  })
}

async function processAllSearchTasks(now = NOW + 1_900): Promise<void> {
  const tasks = await env.DB.prepare(
    `SELECT id, target_reference, input_version
     FROM background_tasks
     WHERE task_type = 'index_message' AND task_status = 'pending'
     ORDER BY target_reference`,
  ).all<{ id: string; target_reference: string; input_version: number }>()
  for (const task of tasks.results) {
    await processBackgroundTaskMessage({
      database: env.DB,
      message: { taskId: task.id, inputVersion: task.input_version },
      now,
      workerReference: `mail-search-test-${task.id}`,
      executeTask: (context) =>
        processMessageIndexTask({
          database: env.DB,
          objectStore: createMailObjectStore(testEnvironment, 'r2'),
          messageId: context.targetReference,
          inputVersion: context.inputVersion,
          now: context.now,
        }),
    })
  }
}

async function deletionTask(operationId: string) {
  const task = await env.DB.prepare(
    `SELECT id, input_version FROM background_tasks
     WHERE task_type = 'mailbox_delete' AND target_reference = ?1`,
  )
    .bind(operationId)
    .first<{ id: string; input_version: number }>()
  if (!task) throw new Error('没有找到邮件删除任务')
  return task
}

async function taskStatus(taskId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT task_status FROM background_tasks WHERE id = ?1')
    .bind(taskId)
    .first<{ task_status: string }>()
  return row?.task_status ?? null
}

function auditContext(label: string) {
  return {
    requestTraceId: `mailbox-test:${label}`,
    sourceIp: null,
    browserFamily: 'Vitest',
  }
}

async function seedMailboxActors(): Promise<void> {
  await env.DB.batch([
    userStatement('owner-user', '管理员'),
    userStatement('member-user', '成员'),
    env.DB.prepare(
      `INSERT INTO user_organization_policies (
         user_id, organization_limit, updated_by_user_id, created_at, updated_at
       ) VALUES ('owner-user', 5, NULL, 100, 100), ('member-user', 5, NULL, 100, 100)`,
    ),
    env.DB.prepare(
      `INSERT INTO organizations (
         id, name, creator_user_id, status, members_can_send,
         deletion_requested_at, deletion_due_at, created_at, updated_at
       ) VALUES ('mail-organization', '共享邮箱', 'owner-user', 'active', 0,
         NULL, NULL, 100, 100)`,
    ),
    env.DB.prepare(
      `INSERT INTO organization_memberships (
         id, organization_id, user_id, joined_at, left_at, left_reason
       ) VALUES
         ('owner-membership', 'mail-organization', 'owner-user', 100, NULL, NULL),
         ('member-membership', 'mail-organization', 'member-user', 100, NULL, NULL)`,
    ),
    env.DB.prepare(
      `INSERT INTO mail_domains (
         id, canonical_name, display_name, status, catch_all_mode,
         paused_at, created_at, updated_at
       ) VALUES ('mail-domain', 'example.test', 'example.test', 'active', 'reject',
         NULL, 100, 100)`,
    ),
    addressStatement('owner-address', 'owner@example.test'),
    addressStatement('member-address', 'member@example.test'),
    addressStatement('shared-address', 'shared@example.test'),
    claimStatement('owner-address', 'owner@example.test'),
    claimStatement('member-address', 'member@example.test'),
    claimStatement('shared-address', 'shared@example.test'),
    userBindingStatement('owner-binding', 'owner-address', 'owner-user'),
    userBindingStatement('member-binding', 'member-address', 'member-user'),
    env.DB.prepare(
      `INSERT INTO address_bindings (
         id, address_id, owner_type, user_id, organization_id,
         address_role, started_at, ended_at, ended_reason
       ) VALUES ('shared-binding', 'shared-address', 'organization', NULL,
         'mail-organization', 'shared', 100, NULL, NULL)`,
    ),
    env.DB.prepare(
      `INSERT INTO system_instances (
         singleton_id, storage_mode, current_admin_user_id, initialized_at, created_at, updated_at
       ) VALUES (1, 'r2', 'owner-user', 100, 100, 100)`,
    ),
  ])
}

function userStatement(id: string, name: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO users (
       id, status, display_name, timezone, invitation_policy,
       deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
     ) VALUES (?1, 'active', ?2, 'Asia/Shanghai', 'manual',
       NULL, NULL, NULL, 100, 100)`,
  ).bind(id, name)
}

function addressStatement(id: string, address: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO email_addresses (
       id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
     ) VALUES (?1, 'mail-domain', ?2, ?2, NULL, 100, NULL)`,
  ).bind(id, address)
}

function claimStatement(addressId: string, address: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO address_claims (
       canonical_address, address_id, status, reserved_until, created_at, updated_at
     ) VALUES (?1, ?2, 'active', NULL, 100, 100)`,
  ).bind(address, addressId)
}

function userBindingStatement(id: string, addressId: string, userId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO address_bindings (
       id, address_id, owner_type, user_id, organization_id,
       address_role, started_at, ended_at, ended_reason
     ) VALUES (?1, ?2, 'user', ?3, NULL, 'primary', 100, NULL, NULL)`,
  ).bind(id, addressId, userId)
}

function logicalUsage(ownerType: 'user' | 'organization', ownerId: string) {
  const ownerColumn = ownerType === 'user' ? 'user_id' : 'organization_id'
  return env.DB.prepare(
    `SELECT committed_bytes, reserved_bytes FROM logical_storage_usage_accounts
     WHERE storage_mode = 'r2' AND owner_type = ?1 AND ${ownerColumn} = ?2`,
  )
    .bind(ownerType, ownerId)
    .first<{ committed_bytes: number; reserved_bytes: number }>()
}

async function messageSize(messageId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT raw_size_bytes FROM messages WHERE id = ?1`)
    .bind(messageId)
    .first<{ raw_size_bytes: number }>()
  return row?.raw_size_bytes ?? 0
}
