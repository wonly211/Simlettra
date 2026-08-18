import { describe, expect, it, vi } from 'vitest'
import { submitOutboundProviderMessage } from '../../src/modules/sending/public'

describe('域外发信服务响应解析', () => {
  it('识别 SMTP2GO 的 email_response 响应并保留提交编号', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          request_id: 'request-1',
          email_response: { succeeded: 1, failed: 0, email_id: 'smtp2go-email-1' },
        }),
        { status: 200 },
      ),
    )

    const result = await submitOutboundProviderMessage({
      fetcher,
      providerType: 'smtp2go',
      credential: 'test-key',
      idempotencyKey: 'simlettra-test-1',
      message: {
        senderAddress: 'sender@example.com',
        recipientAddress: 'recipient@example.net',
        subject: '测试',
        text: '正文',
      },
    })

    expect(result).toEqual({ kind: 'accepted', submissionId: 'smtp2go-email-1' })
    const requestBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      fastaccept?: boolean
    }
    expect(requestBody.fastaccept).toBe(true)
    const requestHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(requestHeaders.get('Accept')).toBe('application/json')
  })

  it('SMTP2GO 明确拒绝时返回可切换备用服务的结果', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          email_response: { succeeded: 0, failed: 1, email_id: [] },
        }),
        { status: 200 },
      ),
    )

    const result = await submitOutboundProviderMessage({
      fetcher,
      providerType: 'smtp2go',
      credential: 'test-key',
      idempotencyKey: 'simlettra-test-2',
      message: {
        senderAddress: 'sender@example.com',
        recipientAddress: 'recipient@example.net',
        subject: '测试',
        text: '正文',
      },
    })

    expect(result).toEqual({
      kind: 'not_accepted',
      retryWithFallback: true,
      code: 'message_rejected',
    })
  })

  it('成功响应缺少提交编号时保留结果未知', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ email_response: { succeeded: 1, failed: 0 } }), {
        status: 200,
      }),
    )

    const result = await submitOutboundProviderMessage({
      fetcher,
      providerType: 'smtp2go',
      credential: 'test-key',
      idempotencyKey: 'simlettra-test-3',
      message: {
        senderAddress: 'sender@example.com',
        recipientAddress: 'recipient@example.net',
        subject: '测试',
        text: '正文',
      },
    })

    expect(result).toEqual({ kind: 'unknown', code: 'provider_response_invalid' })
  })

  it('兼容 SMTP2GO 直接返回 email_response 字段的成功响应', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ succeeded: 1, failed: 0, email_id: 'smtp2go-top-level-1' }), {
        status: 200,
      }),
    )

    const result = await submitOutboundProviderMessage({
      fetcher,
      providerType: 'smtp2go',
      credential: 'test-key',
      idempotencyKey: 'simlettra-test-4',
      message: {
        senderAddress: 'sender@example.com',
        recipientAddress: 'recipient@example.net',
        subject: '测试',
        text: '正文',
      },
    })

    expect(result).toEqual({ kind: 'accepted', submissionId: 'smtp2go-top-level-1' })
  })
})
