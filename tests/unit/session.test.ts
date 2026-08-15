import { describe, expect, it } from 'vitest'
import {
  constantTimeEqual,
  createSessionTokens,
  digestToken,
  isPlausibleToken,
} from '../../src/modules/identity/domain/session'

describe('不透明登录会话', () => {
  it('生成独立的 256 位会话和 CSRF 令牌', async () => {
    const first = await createSessionTokens()
    const second = await createSessionTokens()

    expect(isPlausibleToken(first.sessionToken)).toBe(true)
    expect(isPlausibleToken(first.csrfToken)).toBe(true)
    expect(first.sessionTokenDigest).toHaveLength(32)
    expect(first.csrfTokenDigest).toHaveLength(32)
    expect(first.sessionToken).not.toBe(first.csrfToken)
    expect(first.sessionToken).not.toBe(second.sessionToken)
  })

  it('摘要比较只接受相同令牌', async () => {
    const first = await digestToken('同一个令牌')
    const same = await digestToken('同一个令牌')
    const different = await digestToken('另一个令牌')

    expect(constantTimeEqual(first, same)).toBe(true)
    expect(constantTimeEqual(first, different)).toBe(false)
  })
})
