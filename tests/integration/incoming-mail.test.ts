import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  createMailObjectStore,
  processReceiveParsingTask,
  processReceiveRouteCommitTask,
  receiveIncomingMail,
  type IncomingEmailMessage,
} from '../../src/modules/mail-receiving/public'
import { processBackgroundTaskMessage } from '../../src/modules/tasks/public'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'

interface MailTestEnvironment extends Env {
  MAIL_OBJECTS_KV: KVNamespace
  MAIL_OBJECTS_R2: R2Bucket
}

interface CapturedQueue {
  binding: Queue<BackgroundTaskMessage>
  messages: BackgroundTaskMessage[]
}

const testEnvironment = env as MailTestEnvironment
const RECEIVED_AT = 1_800_000_000_000

describe('邮件接收与完整性提交', () => {
  it('先保存原始邮件，Queue 完整解析后才建立个人邮箱条目', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    const queue = createCapturedQueue()
    const message = createIncomingMessage('owner@example.test', simpleMessage())

    const receiveResult = await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message,
      now: RECEIVED_AT,
    })

    expect(receiveResult).toMatchObject({ status: 'accepted', duplicate: false })
    expect(message.setReject).not.toHaveBeenCalled()
    expect(queue.messages).toHaveLength(1)
    await expect(tableCount('messages')).resolves.toBe(0)
    await expect(tableCount('mailbox_entries')).resolves.toBe(0)
    await expect(logicalUsage('user', 'owner-user', 'r2')).resolves.toEqual({
      committed_bytes: 0,
      reserved_bytes: new TextEncoder().encode(simpleMessage()).byteLength,
    })
    await expect(
      scalar<string>(`SELECT object_status FROM object_registry WHERE object_role = 'raw_mime'`),
    ).resolves.toBe('verified')

    await processTask(queue.messages[0]!, 'r2', RECEIVED_AT + 1)

    await expect(tableCount('messages')).resolves.toBe(1)
    await expect(tableCount('mailbox_entries')).resolves.toBe(1)
    await expect(
      scalar<string>(`SELECT integrity_status FROM message_integrity_states`),
    ).resolves.toBe('ready')
    await expect(scalar<string>(`SELECT operation_status FROM receive_operations`)).resolves.toBe(
      'visible',
    )
    const objects = await env.DB.prepare(
      `SELECT object_role, object_status, is_current
       FROM object_registry ORDER BY object_role`,
    ).all<{ object_role: string; object_status: string; is_current: number }>()
    expect(objects.results).toEqual([
      { object_role: 'attachment', object_status: 'active', is_current: 1 },
      { object_role: 'plain_body', object_status: 'active', is_current: 1 },
      { object_role: 'raw_mime', object_status: 'active', is_current: 1 },
    ])
    await expect(
      scalar<string>(`SELECT canonical_recipient_address FROM message_deliveries`),
    ).resolves.toBe('owner@example.test')
    await expect(logicalUsage('user', 'owner-user', 'r2')).resolves.toEqual({
      committed_bytes: new TextEncoder().encode(simpleMessage()).byteLength,
      reserved_bytes: 0,
    })
  })

  it('同一小时窗口内的重复投递只推进同一收信操作', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    const queue = createCapturedQueue()
    const raw = simpleMessage()
    const first = await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('owner@example.test', raw),
      now: RECEIVED_AT,
    })
    await processTask(queue.messages[0]!, 'r2', RECEIVED_AT + 1)

    const duplicateQueue = createCapturedQueue()
    const second = await receiveIncomingMail({
      database: env.DB,
      queue: duplicateQueue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('owner@example.test', raw),
      now: RECEIVED_AT + 10 * 60 * 1000,
    })

    expect(first.status).toBe('accepted')
    expect(second).toEqual({
      status: 'accepted',
      operationId: first.status === 'accepted' ? first.operationId : '',
      duplicate: true,
    })
    await expect(tableCount('receive_operations')).resolves.toBe(1)
    await expect(tableCount('messages')).resolves.toBe(1)
    await expect(tableCount('mailbox_entries')).resolves.toBe(1)
  })

  it('首次 Queue 发送失败后同一地址重投会重新唤醒原解析任务', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    const raw = simpleMessage()
    const failedQueue = {
      send: async () => {
        throw new Error('测试 Queue 暂时不可用')
      },
    } as unknown as Queue<BackgroundTaskMessage>
    await expect(
      receiveIncomingMail({
        database: env.DB,
        queue: failedQueue,
        store: createMailObjectStore(testEnvironment, 'r2'),
        message: createIncomingMessage('owner@example.test', raw),
        now: RECEIVED_AT,
      }),
    ).rejects.toThrow('测试 Queue 暂时不可用')

    const retryQueue = createCapturedQueue()
    const retry = await receiveIncomingMail({
      database: env.DB,
      queue: retryQueue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('owner@example.test', raw),
      now: RECEIVED_AT + 1,
    })
    expect(retry).toMatchObject({ status: 'accepted', duplicate: true })
    expect(retryQueue.messages).toHaveLength(1)
    await processTask(retryQueue.messages[0]!, 'r2', RECEIVED_AT + 2)

    await expect(tableCount('receive_operations')).resolves.toBe(1)
    await expect(tableCount('messages')).resolves.toBe(1)
    await expect(tableCount('mailbox_entries')).resolves.toBe(1)
  })

  it('解析前命中同一用户的主地址和别名时只建立一封邮件与一个邮箱条目', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    await insertAdditionalUserAddress('owner-user', 'alias@example.test', 'alias', false)
    const raw = simpleMessage()
    const firstQueue = createCapturedQueue()
    const first = await receiveIncomingMail({
      database: env.DB,
      queue: firstQueue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('owner@example.test', raw),
      now: RECEIVED_AT,
    })
    const secondQueue = createCapturedQueue()
    const second = await receiveIncomingMail({
      database: env.DB,
      queue: secondQueue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('alias@example.test', raw),
      now: RECEIVED_AT + 1,
    })

    expect(first).toMatchObject({ status: 'accepted', duplicate: false })
    expect(second).toEqual({
      status: 'accepted',
      operationId: first.status === 'accepted' ? first.operationId : '',
      duplicate: false,
    })
    await expect(tableCount('receive_operations')).resolves.toBe(1)
    await processTask(firstQueue.messages[0]!, 'r2', RECEIVED_AT + 2)
    for (const message of secondQueue.messages) {
      await processTask(message, 'r2', RECEIVED_AT + 3)
    }

    await expect(tableCount('messages')).resolves.toBe(1)
    await expect(tableCount('message_deliveries')).resolves.toBe(2)
    await expect(tableCount('mailbox_entries')).resolves.toBe(1)
    await expect(tableCount('mailbox_entry_deliveries')).resolves.toBe(2)
    const addresses = await env.DB.prepare(
      `SELECT canonical_recipient_address FROM message_deliveries
       ORDER BY canonical_recipient_address`,
    ).all<{ canonical_recipient_address: string }>()
    expect(addresses.results.map((row) => row.canonical_recipient_address)).toEqual([
      'alias@example.test',
      'owner@example.test',
    ])
    await expect(logicalUsage('user', 'owner-user', 'r2')).resolves.toEqual({
      committed_bytes: new TextEncoder().encode(raw).byteLength,
      reserved_bytes: 0,
    })
  })

  it('物理邮件可见后命中另一名用户时通过补交付复用内容并分别可见', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    await insertAdditionalUserAddress('second-user', 'second@example.test', 'second', true)
    const raw = simpleMessage()
    const firstQueue = createCapturedQueue()
    const first = await receiveIncomingMail({
      database: env.DB,
      queue: firstQueue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('owner@example.test', raw),
      now: RECEIVED_AT,
    })
    await processTask(firstQueue.messages[0]!, 'r2', RECEIVED_AT + 1)

    const failedQueue = {
      send: async () => {
        throw new Error('测试补交付 Queue 暂时不可用')
      },
    } as unknown as Queue<BackgroundTaskMessage>
    await expect(
      receiveIncomingMail({
        database: env.DB,
        queue: failedQueue,
        store: createMailObjectStore(testEnvironment, 'r2'),
        message: createIncomingMessage('second@example.test', raw),
        now: RECEIVED_AT + 2,
      }),
    ).rejects.toThrow('测试补交付 Queue 暂时不可用')

    const secondQueue = createCapturedQueue()
    const second = await receiveIncomingMail({
      database: env.DB,
      queue: secondQueue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('second@example.test', raw),
      now: RECEIVED_AT + 3,
    })
    expect(second).toEqual({
      status: 'accepted',
      operationId: first.status === 'accepted' ? first.operationId : '',
      duplicate: true,
    })
    expect(secondQueue.messages).toHaveLength(1)
    await processTask(secondQueue.messages[0]!, 'r2', RECEIVED_AT + 4)

    await expect(tableCount('receive_operations')).resolves.toBe(1)
    await expect(tableCount('messages')).resolves.toBe(1)
    await expect(tableCount('message_deliveries')).resolves.toBe(2)
    await expect(tableCount('mailbox_entries')).resolves.toBe(2)
    const owners = await env.DB.prepare(
      `SELECT user_id FROM mailbox_entries WHERE mailbox_type = 'user' ORDER BY user_id`,
    ).all<{ user_id: string }>()
    expect(owners.results.map((row) => row.user_id)).toEqual(['owner-user', 'second-user'])
    const expectedBytes = new TextEncoder().encode(raw).byteLength
    await expect(logicalUsage('user', 'owner-user', 'r2')).resolves.toEqual({
      committed_bytes: expectedBytes,
      reserved_bytes: 0,
    })
    await expect(logicalUsage('user', 'second-user', 'r2')).resolves.toEqual({
      committed_bytes: expectedBytes,
      reserved_bytes: 0,
    })

    const duplicateQueue = createCapturedQueue()
    const duplicate = await receiveIncomingMail({
      database: env.DB,
      queue: duplicateQueue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('second@example.test', raw),
      now: RECEIVED_AT + 5,
    })
    expect(duplicate).toMatchObject({ status: 'accepted', duplicate: true })
    expect(duplicateQueue.messages).toHaveLength(0)
  })

  it('组织地址只建立一个组织邮箱条目，不按成员复制邮件', async () => {
    await insertOrganizationAddress('creator-user', 'shared@example.test')
    const queue = createCapturedQueue()
    await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('shared@example.test', simpleMessage()),
      now: RECEIVED_AT,
    })
    await processTask(queue.messages[0]!, 'r2', RECEIVED_AT + 1)

    const entry = await env.DB.prepare(
      `SELECT mailbox_type, user_id, organization_id FROM mailbox_entries`,
    ).first<{ mailbox_type: string; user_id: string | null; organization_id: string | null }>()
    expect(entry).toEqual({
      mailbox_type: 'organization',
      user_id: null,
      organization_id: 'mail-organization',
    })
    await expect(tableCount('mailbox_entries')).resolves.toBe(1)
    await expect(logicalUsage('organization', 'mail-organization', 'r2')).resolves.toEqual({
      committed_bytes: new TextEncoder().encode(simpleMessage()).byteLength,
      reserved_bytes: 0,
    })
    await expect(logicalUsage('user', 'creator-user', 'r2')).resolves.toEqual({
      committed_bytes: 0,
      reserved_bytes: 0,
    })
  })

  it('暂停域名、禁用用户和超大邮件会在保存前拒收', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    await env.DB.prepare(
      `UPDATE mail_domains SET status = 'paused', paused_at = ?1, updated_at = ?1
       WHERE canonical_name = 'example.test'`,
    )
      .bind(RECEIVED_AT)
      .run()
    const pausedMessage = createIncomingMessage('owner@example.test', simpleMessage())
    const pausedResult = await receiveIncomingMail({
      database: env.DB,
      queue: createCapturedQueue().binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: pausedMessage,
      now: RECEIVED_AT,
    })
    expect(pausedResult).toEqual({ status: 'rejected', reason: 'recipient_unavailable' })
    expect(pausedMessage.setReject).toHaveBeenCalledOnce()

    await env.DB.prepare(
      `UPDATE mail_domains SET status = 'active', paused_at = NULL, updated_at = ?1
       WHERE canonical_name = 'example.test'`,
    )
      .bind(RECEIVED_AT + 1)
      .run()
    await env.DB.prepare(
      `UPDATE users SET status = 'disabled', updated_at = ?1 WHERE id = 'owner-user'`,
    )
      .bind(RECEIVED_AT + 2)
      .run()
    const disabledMessage = createIncomingMessage('owner@example.test', simpleMessage())
    const disabledResult = await receiveIncomingMail({
      database: env.DB,
      queue: createCapturedQueue().binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: disabledMessage,
      now: RECEIVED_AT + 2,
    })
    expect(disabledResult).toEqual({ status: 'rejected', reason: 'recipient_unavailable' })

    await env.DB.prepare(
      `UPDATE users SET status = 'active', updated_at = ?1 WHERE id = 'owner-user'`,
    )
      .bind(RECEIVED_AT + 3)
      .run()
    const oversizedMessage = createIncomingMessage('owner@example.test', simpleMessage())
    Object.defineProperty(oversizedMessage, 'rawSize', { value: 20_000_001 })
    const oversizedResult = await receiveIncomingMail({
      database: env.DB,
      queue: createCapturedQueue().binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: oversizedMessage,
      now: RECEIVED_AT + 3,
    })
    expect(oversizedResult).toEqual({ status: 'rejected', reason: 'message_too_large' })
    await expect(tableCount('receive_operations')).resolves.toBe(0)
    await expect(tableCount('object_registry')).resolves.toBe(0)
  })

  it('独立暂停域名、地址或用户收信时不会读取原始邮件流', async () => {
    for (const scope of [
      { type: 'domain', column: 'domain_id', id: 'mail-domain' },
      { type: 'address', column: 'address_id', id: 'mail-address' },
      { type: 'user', column: 'user_id', id: 'owner-user' },
    ] as const) {
      await insertUserAddress('owner-user', 'owner@example.test')
      await env.DB.prepare(
        `INSERT INTO inbound_receive_controls (
          id, scope_type, domain_id, address_id, user_id, receive_status,
          updated_by_user_id, paused_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'paused', 'owner-user', ?6, ?6, ?6)`,
      )
        .bind(
          `control-${scope.type}`,
          scope.type,
          scope.column === 'domain_id' ? scope.id : null,
          scope.column === 'address_id' ? scope.id : null,
          scope.column === 'user_id' ? scope.id : null,
          RECEIVED_AT,
        )
        .run()
      const message = createObservedIncomingMessage('owner@example.test', simpleMessage())
      const result = await receiveIncomingMail({
        database: env.DB,
        queue: createCapturedQueue().binding,
        store: createMailObjectStore(testEnvironment, 'r2'),
        message: message.value,
        now: RECEIVED_AT,
      })

      expect(result).toEqual({ status: 'rejected', reason: 'recipient_unavailable' })
      expect(message.wasRead()).toBe(false)
      await expect(tableCount('receive_operations')).resolves.toBe(0)
      await resetMailFixture()
    }
  })

  it('发件地址和发件域名拒收规则在读取原始邮件流前生效', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    for (const [ruleType, matchValue] of [
      ['sender_address', 'sender@outside.test'],
      ['sender_domain', 'outside.test'],
    ] as const) {
      await insertInboundRule(ruleType, matchValue)
      const message = createObservedIncomingMessage('owner@example.test', simpleMessage())
      const result = await receiveIncomingMail({
        database: env.DB,
        queue: createCapturedQueue().binding,
        store: createMailObjectStore(testEnvironment, 'r2'),
        message: message.value,
        now: RECEIVED_AT,
      })

      expect(result).toEqual({ status: 'rejected', reason: 'rejection_rule_matched' })
      expect(message.wasRead()).toBe(false)
      await expect(tableCount('receive_operations')).resolves.toBe(0)
      await env.DB.prepare('DELETE FROM inbound_rejection_rules').run()
    }
  })

  it('主题和正文关键词只检查解码正文与 HTML 可见文字并在持久化前拒收', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    await insertInboundRule('subject_keyword', '完整收信')
    const subjectMessage = createObservedIncomingMessage('owner@example.test', simpleMessage())
    const subjectResult = await receiveIncomingMail({
      database: env.DB,
      queue: createCapturedQueue().binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: subjectMessage.value,
      now: RECEIVED_AT,
    })
    expect(subjectResult).toEqual({ status: 'rejected', reason: 'rejection_rule_matched' })
    expect(subjectMessage.wasRead()).toBe(true)
    await expect(tableCount('receive_operations')).resolves.toBe(0)

    await env.DB.prepare('DELETE FROM inbound_rejection_rules').run()
    await insertInboundRule('body_keyword', '可见命中词')
    const html = [
      'From: Sender <sender@outside.test>',
      'To: Owner <owner@example.test>',
      'Subject: HTML 正文检查',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>这里包含<strong>可见命中词</strong></p><script>隐藏脚本词</script>',
      '',
    ].join('\r\n')
    const bodyMessage = createIncomingMessage('owner@example.test', html)
    const bodyResult = await receiveIncomingMail({
      database: env.DB,
      queue: createCapturedQueue().binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: bodyMessage,
      now: RECEIVED_AT + 1,
    })
    expect(bodyResult).toEqual({ status: 'rejected', reason: 'rejection_rule_matched' })
    await expect(tableCount('receive_operations')).resolves.toBe(0)
  })

  it('KV 模式经过下一次任务复核后才允许邮件可见', async () => {
    await insertUserAddress('owner-user', 'owner@example.test', 'kv')
    const queue = createCapturedQueue()
    await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'kv'),
      message: createIncomingMessage('owner@example.test', simpleMessage()),
      now: RECEIVED_AT,
    })
    await expect(
      scalar<string>(`SELECT object_status FROM object_registry WHERE object_role = 'raw_mime'`),
    ).resolves.toBe('waiting_consistency')

    await processTask(queue.messages[0]!, 'kv', RECEIVED_AT + 1)
    await expect(tableCount('messages')).resolves.toBe(0)
    const retryTask = await env.DB.prepare(
      `SELECT id, input_version, next_attempt_at FROM background_tasks
       WHERE task_type = 'receive_parse'`,
    ).first<{ id: string; input_version: number; next_attempt_at: number }>()
    expect(retryTask?.next_attempt_at).toBeGreaterThan(RECEIVED_AT + 1)

    await processTask(
      { taskId: retryTask!.id, inputVersion: retryTask!.input_version },
      'kv',
      retryTask!.next_attempt_at,
    )
    await expect(tableCount('messages')).resolves.toBe(1)
    await expect(scalar<string>(`SELECT operation_status FROM receive_operations`)).resolves.toBe(
      'visible',
    )
  })

  it('最终邮箱事务失败时不留下物理邮件或半封可见邮件', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    const queue = createCapturedQueue()
    await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('owner@example.test', simpleMessage()),
      now: RECEIVED_AT,
    })
    await env.DB.prepare(
      `CREATE TRIGGER fail_mailbox_commit
       BEFORE INSERT ON mailbox_entries
       BEGIN SELECT RAISE(ABORT, '模拟最终事务失败'); END`,
    ).run()

    await processTask(queue.messages[0]!, 'r2', RECEIVED_AT + 1)
    await expect(tableCount('messages')).resolves.toBe(0)
    await expect(tableCount('mailbox_entries')).resolves.toBe(0)
    await expect(tableCount('message_integrity_states')).resolves.toBe(0)
    await expect(scalar<string>(`SELECT operation_status FROM receive_operations`)).resolves.toBe(
      'committing',
    )
    await expect(logicalUsage('user', 'owner-user', 'r2')).resolves.toEqual({
      committed_bytes: 0,
      reserved_bytes: new TextEncoder().encode(simpleMessage()).byteLength,
    })

    await env.DB.prepare('DROP TRIGGER fail_mailbox_commit').run()
    const retryTask = await env.DB.prepare(
      `SELECT id, input_version, next_attempt_at FROM background_tasks
       WHERE task_type = 'receive_parse'`,
    ).first<{ id: string; input_version: number; next_attempt_at: number }>()
    await processTask(
      { taskId: retryTask!.id, inputVersion: retryTask!.input_version },
      'r2',
      retryTask!.next_attempt_at,
    )
    await expect(tableCount('messages')).resolves.toBe(1)
    await expect(tableCount('mailbox_entries')).resolves.toBe(1)
    await expect(logicalUsage('user', 'owner-user', 'r2')).resolves.toEqual({
      committed_bytes: new TextEncoder().encode(simpleMessage()).byteLength,
      reserved_bytes: 0,
    })
  })

  it('存储配额不足时拒收，原始对象损坏时释放逻辑预留', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    await env.DB.prepare(
      `UPDATE logical_storage_quota_policies
       SET limit_bytes = 1
       WHERE storage_mode = 'r2' AND owner_type = 'system_default'
         AND default_owner_type = 'user' AND policy_status = 'active'`,
    ).run()
    const fullMessage = createIncomingMessage('owner@example.test', simpleMessage())
    const rejected = await receiveIncomingMail({
      database: env.DB,
      queue: createCapturedQueue().binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: fullMessage,
      now: RECEIVED_AT,
    })
    expect(rejected).toEqual({ status: 'rejected', reason: 'storage_quota_exceeded' })
    await expect(logicalUsage('user', 'owner-user', 'r2')).resolves.toEqual({
      committed_bytes: 0,
      reserved_bytes: 0,
    })

    await env.DB.prepare(
      `UPDATE logical_storage_quota_policies
       SET limit_bytes = 1000000000
       WHERE storage_mode = 'r2' AND owner_type = 'system_default'
         AND default_owner_type = 'user' AND policy_status = 'active'`,
    ).run()
    const queue = createCapturedQueue()
    const accepted = await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('owner@example.test', simpleMessage()),
      now: RECEIVED_AT + 1,
    })
    expect(accepted.status).toBe('accepted')
    const objectKey = await scalar<string>(
      `SELECT object_key FROM object_registry WHERE object_role = 'raw_mime'`,
    )
    await testEnvironment.MAIL_OBJECTS_R2.put(objectKey!, new TextEncoder().encode('damaged'))
    await processTask(queue.messages[0]!, 'r2', RECEIVED_AT + 2)
    await expect(scalar<string>(`SELECT operation_status FROM receive_operations`)).resolves.toBe(
      'damaged',
    )
    await expect(logicalUsage('user', 'owner-user', 'r2')).resolves.toEqual({
      committed_bytes: 0,
      reserved_bytes: 0,
    })
  })

  it('未知地址默认拒收，启用全域收信后完整保存但不建立个人副作用', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    const rejectedMessage = createObservedIncomingMessage('unknown@example.test', simpleMessage())
    const rejected = await receiveIncomingMail({
      database: env.DB,
      queue: createCapturedQueue().binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: rejectedMessage.value,
      now: RECEIVED_AT,
    })
    expect(rejected).toEqual({ status: 'rejected', reason: 'recipient_unavailable' })
    expect(rejectedMessage.wasRead()).toBe(false)
    await expect(tableCount('receive_operations')).resolves.toBe(0)

    await env.DB.prepare(
      `UPDATE mail_domains SET catch_all_mode = 'unallocated', updated_at = ?1
       WHERE id = 'mail-domain'`,
    )
      .bind(RECEIVED_AT + 1)
      .run()
    const queue = createCapturedQueue()
    const accepted = await receiveIncomingMail({
      database: env.DB,
      queue: queue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('unknown@example.test', simpleMessage()),
      now: RECEIVED_AT + 2,
    })
    expect(accepted).toMatchObject({ status: 'accepted', duplicate: false })
    await processTask(queue.messages[0]!, 'r2', RECEIVED_AT + 3)

    await expect(tableCount('messages')).resolves.toBe(1)
    await expect(tableCount('unallocated_address_periods')).resolves.toBe(1)
    await expect(tableCount('unallocated_message_deliveries')).resolves.toBe(1)
    await expect(tableCount('mailbox_entries')).resolves.toBe(0)
    await expect(tableCount('message_deliveries')).resolves.toBe(0)
    await expect(tableCount('notification_operations')).resolves.toBe(0)
    await expect(tableCount('mail_forward_operations')).resolves.toBe(0)
    await expect(logicalUsage('user', 'owner-user', 'r2')).resolves.toEqual({
      committed_bytes: 0,
      reserved_bytes: 0,
    })
    await expect(scalar<string>(`SELECT operation_status FROM receive_operations`)).resolves.toBe(
      'visible',
    )
    await expect(
      scalar<string>(`SELECT route_status FROM receive_operation_unallocated_routes`),
    ).resolves.toBe('committed')
    const taskTypes = await env.DB.prepare(
      `SELECT task_type FROM background_tasks ORDER BY task_type`,
    ).all<{ task_type: string }>()
    expect(taskTypes.results.map((row) => row.task_type)).toEqual([
      'index_message',
      'rebuild_conversation',
      'receive_parse',
    ])
  })

  it('同一未知地址复用开放时期，重复投递仍只保存一次', async () => {
    await insertUserAddress('owner-user', 'owner@example.test')
    await env.DB.prepare(
      `UPDATE mail_domains SET catch_all_mode = 'unallocated', updated_at = ?1
       WHERE id = 'mail-domain'`,
    )
      .bind(RECEIVED_AT)
      .run()
    const firstQueue = createCapturedQueue()
    const first = await receiveIncomingMail({
      database: env.DB,
      queue: firstQueue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('unknown@example.test', simpleMessage()),
      now: RECEIVED_AT + 1,
    })
    await processTask(firstQueue.messages[0]!, 'r2', RECEIVED_AT + 2)

    const duplicate = await receiveIncomingMail({
      database: env.DB,
      queue: createCapturedQueue().binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage('unknown@example.test', simpleMessage()),
      now: RECEIVED_AT + 10 * 60 * 1000,
    })
    const secondQueue = createCapturedQueue()
    const second = await receiveIncomingMail({
      database: env.DB,
      queue: secondQueue.binding,
      store: createMailObjectStore(testEnvironment, 'r2'),
      message: createIncomingMessage(
        'unknown@example.test',
        simpleMessage().replace('incoming-1', 'incoming-2').replace('完整收信测试', '第二封来信'),
      ),
      now: RECEIVED_AT + 11 * 60 * 1000,
    })
    await processTask(secondQueue.messages[0]!, 'r2', RECEIVED_AT + 11 * 60 * 1000 + 1)

    expect(duplicate).toEqual({
      status: 'accepted',
      operationId: first.status === 'accepted' ? first.operationId : '',
      duplicate: true,
    })
    expect(second).toMatchObject({ status: 'accepted', duplicate: false })
    await expect(tableCount('unallocated_address_periods')).resolves.toBe(1)
    await expect(tableCount('unallocated_message_deliveries')).resolves.toBe(2)
    await expect(tableCount('receive_operations')).resolves.toBe(2)
    await expect(tableCount('mailbox_entries')).resolves.toBe(0)
  })
})

async function processTask(message: BackgroundTaskMessage, mode: 'kv' | 'r2', now: number) {
  return processBackgroundTaskMessage({
    database: env.DB,
    message,
    now,
    workerReference: `test-worker-${now}`,
    executeTask: (task) => {
      if (task.taskType !== 'receive_parse') {
        if (task.taskType === 'receive_route_commit') {
          return processReceiveRouteCommitTask({
            database: env.DB,
            store: createMailObjectStore(testEnvironment, mode),
            routeId: task.targetReference,
            now: task.now,
          })
        }
        return Promise.resolve({ status: 'needs_attention', errorCode: 'unsupported_task_type' })
      }
      return processReceiveParsingTask({
        database: env.DB,
        store: createMailObjectStore(testEnvironment, mode),
        operationId: task.targetReference,
        now: task.now,
      })
    },
  })
}

function createCapturedQueue(): CapturedQueue {
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

function createIncomingMessage(to: string, raw: string) {
  const bytes = new TextEncoder().encode(raw)
  const setReject = vi.fn<(reason: string) => void>()
  return {
    from: 'sender@outside.test',
    to,
    rawSize: bytes.byteLength,
    raw: new Blob([bytes]).stream(),
    setReject,
  } satisfies IncomingEmailMessage
}

function createObservedIncomingMessage(to: string, raw: string) {
  const bytes = new TextEncoder().encode(raw)
  let rawAccessed = false
  const setReject = vi.fn<(reason: string) => void>()
  const value = {
    from: 'sender@outside.test',
    to,
    rawSize: bytes.byteLength,
    get raw() {
      rawAccessed = true
      return new Blob([bytes]).stream()
    },
    setReject,
  } satisfies IncomingEmailMessage
  return {
    value,
    wasRead: () => rawAccessed,
  }
}

function simpleMessage(): string {
  return [
    'From: Sender <sender@outside.test>',
    'To: Owner <owner@example.test>',
    'Subject: 完整收信测试',
    'Message-ID: <incoming-1@outside.test>',
    'Date: Wed, 12 Aug 2026 08:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="simlettra-boundary"',
    '',
    '--simlettra-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '这是一封用于验证完整性提交的邮件。',
    '--simlettra-boundary',
    'Content-Type: text/plain; name="note.txt"',
    'Content-Disposition: attachment; filename="note.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    'YXR0YWNobWVudA==',
    '--simlettra-boundary--',
    '',
  ].join('\r\n')
}

async function insertUserAddress(
  userId: string,
  address: string,
  storageMode: 'kv' | 'r2' = 'r2',
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
        id, status, display_name, timezone, invitation_policy,
        deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
       ) VALUES (?1, 'active', '收信用户', 'Asia/Shanghai', 'manual',
         NULL, NULL, NULL, 100, 100)`,
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO mail_domains (
        id, canonical_name, display_name, status, catch_all_mode,
        paused_at, created_at, updated_at
       ) VALUES ('mail-domain', 'example.test', 'example.test', 'active', 'reject',
         NULL, 100, 100)`,
    ),
    env.DB.prepare(
      `INSERT INTO email_addresses (
        id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
       ) VALUES ('mail-address', 'mail-domain', ?1, ?1, NULL, 100, NULL)`,
    ).bind(address),
    env.DB.prepare(
      `INSERT INTO address_claims (
        canonical_address, address_id, status, reserved_until, created_at, updated_at
       ) VALUES (?1, 'mail-address', 'active', NULL, 100, 100)`,
    ).bind(address),
    env.DB.prepare(
      `INSERT INTO address_bindings (
        id, address_id, owner_type, user_id, organization_id,
        address_role, started_at, ended_at, ended_reason
       ) VALUES ('mail-binding', 'mail-address', 'user', ?1, NULL,
         'primary', 100, NULL, NULL)`,
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO system_instances (
        singleton_id, storage_mode, current_admin_user_id, initialized_at, created_at, updated_at
       ) VALUES (1, ?1, ?2, 100, 100, 100)`,
    ).bind(storageMode, userId),
  ])
}

async function insertOrganizationAddress(creatorUserId: string, address: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
        id, status, display_name, timezone, invitation_policy,
        deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
       ) VALUES (?1, 'active', '创建者', 'Asia/Shanghai', 'manual',
         NULL, NULL, NULL, 100, 100)`,
    ).bind(creatorUserId),
    env.DB.prepare(
      `INSERT INTO user_organization_policies (
        user_id, organization_limit, updated_by_user_id, created_at, updated_at
       ) VALUES (?1, 5, NULL, 100, 100)`,
    ).bind(creatorUserId),
    env.DB.prepare(
      `INSERT INTO organizations (
        id, name, creator_user_id, status, members_can_send,
        deletion_requested_at, deletion_due_at, created_at, updated_at
       ) VALUES ('mail-organization', '共享收信组', ?1, 'active', 0,
         NULL, NULL, 100, 100)`,
    ).bind(creatorUserId),
    env.DB.prepare(
      `INSERT INTO organization_memberships (
        id, organization_id, user_id, joined_at, left_at, left_reason
       ) VALUES ('mail-membership', 'mail-organization', ?1, 100, NULL, NULL)`,
    ).bind(creatorUserId),
    env.DB.prepare(
      `INSERT INTO mail_domains (
        id, canonical_name, display_name, status, catch_all_mode,
        paused_at, created_at, updated_at
       ) VALUES ('mail-domain', 'example.test', 'example.test', 'active', 'reject',
         NULL, 100, 100)`,
    ),
    env.DB.prepare(
      `INSERT INTO email_addresses (
        id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
       ) VALUES ('mail-address', 'mail-domain', ?1, ?1, NULL, 100, NULL)`,
    ).bind(address),
    env.DB.prepare(
      `INSERT INTO address_claims (
        canonical_address, address_id, status, reserved_until, created_at, updated_at
       ) VALUES (?1, 'mail-address', 'active', NULL, 100, 100)`,
    ).bind(address),
    env.DB.prepare(
      `INSERT INTO address_bindings (
        id, address_id, owner_type, user_id, organization_id,
        address_role, started_at, ended_at, ended_reason
       ) VALUES ('mail-binding', 'mail-address', 'organization', NULL, 'mail-organization',
         'shared', 100, NULL, NULL)`,
    ),
    env.DB.prepare(
      `INSERT INTO system_instances (
        singleton_id, storage_mode, current_admin_user_id, initialized_at, created_at, updated_at
       ) VALUES (1, 'r2', ?1, 100, 100, 100)`,
    ).bind(creatorUserId),
  ])
}

async function insertAdditionalUserAddress(
  userId: string,
  address: string,
  suffix: string,
  createUser: boolean,
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  if (createUser) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO users (
            id, status, display_name, timezone, invitation_policy,
            deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
           ) VALUES (?1, 'active', '第二收信用户', 'Asia/Shanghai', 'manual',
             NULL, NULL, NULL, 101, 101)`,
      ).bind(userId),
    )
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO user_alias_policies (
          user_id, alias_limit, self_creation_enabled,
          updated_by_user_id, created_at, updated_at
         ) VALUES (?1, 20, 1, ?1, 101, 101)`,
      ).bind(userId),
    )
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO email_addresses (
          id, domain_id, display_address, canonical_address, public_label, created_at, retired_at
         ) VALUES (?1, 'mail-domain', ?2, ?2, NULL, 101, NULL)`,
    ).bind(`mail-address-${suffix}`, address),
    env.DB.prepare(
      `INSERT INTO address_claims (
          canonical_address, address_id, status, reserved_until, created_at, updated_at
         ) VALUES (?1, ?2, 'active', NULL, 101, 101)`,
    ).bind(address, `mail-address-${suffix}`),
    env.DB.prepare(
      `INSERT INTO address_bindings (
          id, address_id, owner_type, user_id, organization_id,
          address_role, started_at, ended_at, ended_reason
         ) VALUES (?1, ?2, 'user', ?3, NULL, ?4, 101, NULL, NULL)`,
    ).bind(
      `mail-binding-${suffix}`,
      `mail-address-${suffix}`,
      userId,
      createUser ? 'primary' : 'alias',
    ),
  )
  await env.DB.batch(statements)
}

async function insertInboundRule(
  ruleType: 'sender_address' | 'sender_domain' | 'subject_keyword' | 'body_keyword',
  matchValue: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO inbound_rejection_rules (
      id, rule_type, match_value, rule_status,
      created_by_user_id, updated_by_user_id, created_at, updated_at
     ) VALUES (?1, ?2, ?3, 'active', 'owner-user', 'owner-user', ?4, ?4)`,
  )
    .bind(`rule-${ruleType}`, ruleType, matchValue, RECEIVED_AT)
    .run()
}

async function resetMailFixture(): Promise<void> {
  const tables = [
    'inbound_receive_controls',
    'logical_storage_usage_accounts',
    'system_instances',
    'address_bindings',
    'address_claims',
    'email_addresses',
    'mail_domains',
    'users',
  ]
  for (const table of tables) await env.DB.prepare(`DELETE FROM ${table}`).run()
}

async function tableCount(tableName: string): Promise<number> {
  return (await scalar<number>(`SELECT COUNT(*) FROM ${tableName}`)) ?? 0
}

async function scalar<T>(query: string): Promise<T | null> {
  const row = await env.DB.prepare(query).first<Record<string, T>>()
  return row ? (Object.values(row)[0] ?? null) : null
}

function logicalUsage(
  ownerType: 'user' | 'organization',
  ownerId: string,
  storageMode: 'kv' | 'r2',
) {
  const ownerColumn = ownerType === 'user' ? 'user_id' : 'organization_id'
  return env.DB.prepare(
    `SELECT committed_bytes, reserved_bytes FROM logical_storage_usage_accounts
     WHERE storage_mode = ?1 AND owner_type = ?2 AND ${ownerColumn} = ?3`,
  )
    .bind(storageMode, ownerType, ownerId)
    .first<{ committed_bytes: number; reserved_bytes: number }>()
}
