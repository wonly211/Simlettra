import { describe, expect, it } from 'vitest'
import { parseIncomingMime } from '../../src/modules/mail-receiving/domain/mime-parser'

describe('MIME 邮件关系解析', () => {
  it('规范化 Message-ID 并保留有序且去重的回复引用', async () => {
    const parsed = await parseIncomingMime(
      source([
        'Message-ID: <child@outside.test>',
        'In-Reply-To: <parent@outside.test>',
        'References: <root@outside.test> <parent@outside.test> <root@outside.test>',
      ]),
    )

    expect(parsed.internetMessageId).toBe('<child@outside.test>')
    expect(parsed.relations).toEqual([
      {
        relationType: 'in_reply_to',
        sequenceNumber: 0,
        targetReference: '<parent@outside.test>',
      },
      {
        relationType: 'reference',
        sequenceNumber: 0,
        targetReference: '<root@outside.test>',
      },
      {
        relationType: 'reference',
        sequenceNumber: 1,
        targetReference: '<parent@outside.test>',
      },
    ])
  })

  it('拒绝超过安全数量上限的关系引用', async () => {
    const references = Array.from(
      { length: 101 },
      (_, index) => `<ref-${index}@outside.test>`,
    ).join(' ')

    await expect(parseIncomingMime(source([`References: ${references}`]))).rejects.toMatchObject({
      code: 'relation_count_exceeded',
    })
  })

  it('读取大小写不敏感且可折行的 Simlettra 转发标记', async () => {
    const parsed = await parseIncomingMime(
      source(['X-Simlettra-Forwarded: 1', 'X-Simlettra-Forward-Hop:', ' 4']),
    )

    expect(parsed.sourceMarkedBySimlettra).toBe(true)
    expect(parsed.forwardingHopCount).toBe(4)
  })
})

function source(extraHeaders: string[]): ArrayBuffer {
  const raw = [
    'From: Sender <sender@outside.test>',
    'To: Owner <owner@example.test>',
    'Subject: 关系解析',
    ...extraHeaders,
    'Content-Type: text/plain; charset=utf-8',
    '',
    '正文',
    '',
  ].join('\r\n')
  return new TextEncoder().encode(raw).slice().buffer as ArrayBuffer
}
