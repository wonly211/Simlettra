import { describe, expect, it } from 'vitest'
import {
  createExternalEmailVerificationCode,
  normalizeVerificationCode,
  verifyExternalEmailCode,
} from '../../src/modules/forwarding/domain/verification-code'

describe('外部邮箱一次性验证码', () => {
  it('只保存带随机盐的摘要并接受忽略连字符和大小写的输入', async () => {
    const created = await createExternalEmailVerificationCode()
    expect(created.displayCode).toMatch(/^[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}$/u)
    expect(created.salt).toHaveLength(16)
    expect(created.digest).toHaveLength(32)
    await expect(
      verifyExternalEmailCode(
        created.displayCode.toLowerCase(),
        created.salt.slice().buffer as ArrayBuffer,
        created.digest.slice().buffer as ArrayBuffer,
      ),
    ).resolves.toBe(true)
    await expect(
      verifyExternalEmailCode(
        '2222-2222-2222-2222',
        created.salt.buffer as ArrayBuffer,
        created.digest.buffer as ArrayBuffer,
      ),
    ).resolves.toBe(false)
    expect(normalizeVerificationCode('bad-code')).toBeNull()
  })
})
