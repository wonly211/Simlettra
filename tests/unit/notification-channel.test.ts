import { describe, expect, it, vi } from 'vitest'
import {
  buildNotificationRequest,
  notificationPayloadLimitError,
  submitNotificationToChannel,
  type NotificationChannelInput,
} from '../../src/modules/notifications/public'

describe('外部通知通道契约', () => {
  it.each([
    {
      name: 'ntfy',
      input: channelInput(
        'ntfy',
        { baseUrl: 'https://ntfy.example.com', topic: 'mail' },
        { accessToken: 'tk_secret' },
      ),
      url: 'https://ntfy.example.com/',
      header: ['Authorization', 'Bearer tk_secret'],
      body: { topic: 'mail', title: '澄笺新邮件', message: '完整通知正文' },
    },
    {
      name: 'Gotify',
      input: channelInput(
        'gotify',
        { baseUrl: 'https://gotify.example.com' },
        { applicationToken: 'app-token' },
      ),
      url: 'https://gotify.example.com/message',
      header: ['X-Gotify-Key', 'app-token'],
      body: { title: '澄笺新邮件', message: '完整通知正文', priority: 5 },
    },
    {
      name: 'WxPusher',
      input: channelInput('wxpusher', { uid: 'UID_reader' }, { appToken: 'AT_secret' }),
      url: 'https://wxpusher.zjiecode.com/api/send/message',
      header: null,
      body: {
        appToken: 'AT_secret',
        content: '完整通知正文',
        summary: '澄笺新邮件',
        contentType: 1,
        uids: ['UID_reader'],
      },
    },
    {
      name: 'Telegram',
      input: channelInput(
        'telegram',
        { chatId: '-100123456' },
        { botToken: '123456:abcdefghijklmnopqrstuvwxyzABCDE' },
      ),
      url: 'https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyzABCDE/sendMessage',
      header: null,
      body: {
        chat_id: '-100123456',
        text: '完整通知正文',
        link_preview_options: { is_disabled: true },
      },
    },
    {
      name: 'Bark',
      input: channelInput(
        'bark',
        { baseUrl: 'https://bark.example.com' },
        { deviceKey: 'device-secret' },
      ),
      url: 'https://bark.example.com/push',
      header: null,
      body: {
        device_key: 'device-secret',
        title: '澄笺新邮件',
        body: '完整通知正文',
        group: 'Simlettra',
      },
    },
  ])('$name 使用当前官方请求边界且不发送附件字段', async ({ input, url, header, body }) => {
    const request = buildNotificationRequest(input)
    expect(request.method).toBe('POST')
    expect(request.url).toBe(url)
    if (header) expect(request.headers.get(header[0]!)).toBe(header[1])
    const value = await request.json<Record<string, unknown>>()
    expect(value).toEqual(body)
    expect(Object.keys(value).some((key) => /attach|file/iu.test(key))).toBe(false)
  })

  it('按三种官方已知上限拒绝完整正文超限，Gotify 与 Bark 不预设统一上限', () => {
    expect(notificationPayloadLimitError('ntfy', '中'.repeat(1_366))).toBe('ntfy_message_too_large')
    expect(notificationPayloadLimitError('telegram', '信'.repeat(4_097))).toBe(
      'telegram_message_too_large',
    )
    expect(notificationPayloadLimitError('wxpusher', '信'.repeat(40_001))).toBe(
      'wxpusher_message_too_large',
    )
    expect(notificationPayloadLimitError('gotify', '信'.repeat(50_000))).toBeNull()
    expect(notificationPayloadLimitError('bark', '信'.repeat(50_000))).toBeNull()
  })

  it('网络无响应和服务端错误按结果未知收口，明确限流才允许重试', async () => {
    const input = channelInput(
      'ntfy',
      { baseUrl: 'https://ntfy.example.com', topic: 'mail' },
      { accessToken: null },
    )
    const network = await submitNotificationToChannel(
      input,
      vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout')),
    )
    expect(network).toEqual({ kind: 'unknown', code: 'network_result_unknown', httpStatus: null })

    const serverError = await submitNotificationToChannel(
      input,
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 })),
    )
    expect(serverError).toEqual({
      kind: 'unknown',
      code: 'provider_result_unknown',
      httpStatus: 503,
    })

    const limited = await submitNotificationToChannel(
      input,
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 })),
    )
    expect(limited).toEqual({
      kind: 'not_accepted',
      retryable: true,
      code: 'provider_rate_limited',
      httpStatus: 429,
    })
  })

  it.each([
    ['ntfy', { event: 'message', id: 'ntfy-id' }, 'ntfy-id'],
    ['gotify', { id: 42 }, '42'],
    ['wxpusher', { code: 1000, success: true, data: [{ code: 1000, sendRecordId: 73 }] }, '73'],
    ['telegram', { ok: true, result: { message_id: 99 } }, '99'],
    ['bark', { code: 200, message: 'success' }, null],
  ] as const)('%s 只在官方成功形状明确时记为已提交', async (channel, response, reference) => {
    const inputs: Record<string, NotificationChannelInput> = {
      ntfy: channelInput(
        'ntfy',
        { baseUrl: 'https://ntfy.example.com', topic: 'mail' },
        { accessToken: null },
      ),
      gotify: channelInput(
        'gotify',
        { baseUrl: 'https://gotify.example.com' },
        { applicationToken: 'token' },
      ),
      wxpusher: channelInput('wxpusher', { uid: 'UID_reader' }, { appToken: 'token' }),
      telegram: channelInput(
        'telegram',
        { chatId: '123' },
        { botToken: '123456:abcdefghijklmnopqrstuvwxyzABCDE' },
      ),
      bark: channelInput('bark', { baseUrl: 'https://bark.example.com' }, { deviceKey: 'key' }),
    }
    const result = await submitNotificationToChannel(
      inputs[channel]!,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    expect(result).toEqual({ kind: 'accepted', providerReference: reference, httpStatus: 200 })
  })
})

function channelInput(
  channelType: NotificationChannelInput['channelType'],
  publicOptions: Record<string, string>,
  credential: Record<string, string | null>,
): NotificationChannelInput {
  return { channelType, publicOptions, credential, payload: '完整通知正文' }
}
