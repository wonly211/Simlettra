import { describe, expect, it } from 'vitest'
import {
  generateTemporaryPassword,
  hashPassword,
  PASSWORD_ALGORITHM,
  PASSWORD_DERIVATION_ROUNDS,
  PASSWORD_FORMAT_VERSION,
  PASSWORD_ITERATIONS,
  PASSWORD_ITERATIONS_PER_DERIVATION,
  PasswordValidationError,
  validatePassword,
  verifyPassword,
  verifyPasswordAgainstVirtualRecord,
} from '../../src/modules/identity/domain/password'

const context = {
  displayName: '测试管理员',
  localPart: 'owner',
  canonicalDomain: 'example.com',
}

describe('初始化密码规则', () => {
  it('接受足够长且与账号无关的密码', () => {
    expect(() => validatePassword('长河-Glass-47-Quiet', context)).not.toThrow()
  })

  it.each(['short-password', 'passwordpassword', 'owner-安全密码-2026-very-long'])(
    '拒绝弱密码 %s',
    (value) => {
      expect(() => validatePassword(value, context)).toThrow(PasswordValidationError)
    },
  )

  it('使用随机盐和已接受的 PBKDF2 参数', async () => {
    const first = await hashPassword('长河-Glass-47-Quiet')
    const second = await hashPassword('长河-Glass-47-Quiet')

    expect(first.formatVersion).toBe(PASSWORD_FORMAT_VERSION)
    expect(first.algorithm).toBe(PASSWORD_ALGORITHM)
    expect(first.iterations).toBe(PASSWORD_ITERATIONS)
    expect(PASSWORD_DERIVATION_ROUNDS).toBe(9)
    expect(PASSWORD_ITERATIONS_PER_DERIVATION).toBe(100_000)
    expect(first.salt).toHaveLength(16)
    expect(first.derivedKey).toHaveLength(32)
    expect(first.salt).not.toEqual(second.salt)
    expect(first.derivedKey).not.toEqual(second.derivedKey)
  })

  it('只接受与密码记录匹配的密码', async () => {
    const record = await hashPassword('长河-Glass-47-Quiet')

    await expect(verifyPassword('长河-Glass-47-Quiet', record)).resolves.toBe(true)
    await expect(verifyPassword('错误但长度足够的登录密码', record)).resolves.toBe(false)
  })

  it('拒绝Workers不支持的旧单次密码格式', async () => {
    const record = await hashPassword('长河-Glass-47-Quiet')

    await expect(
      verifyPassword('长河-Glass-47-Quiet', {
        ...record,
        formatVersion: 1,
        algorithm: 'PBKDF2-HMAC-SHA-256',
      }),
    ).resolves.toBe(false)
  })

  it('不存在账号时执行固定虚拟密码记录', async () => {
    await expect(verifyPasswordAgainstVirtualRecord('任意登录密码')).resolves.toBeUndefined()
  })

  it('生成具有足够随机长度且符合正式规则的临时密码', () => {
    const values = new Set(Array.from({ length: 20 }, () => generateTemporaryPassword()))

    expect(values.size).toBe(20)
    for (const value of values) {
      expect(value).toMatch(/^[A-HJ-NP-Za-km-z2-9]{5}(?:-[A-HJ-NP-Za-km-z2-9]{5}){3}$/u)
      expect(() => validatePassword(value, context)).not.toThrow()
    }
  })
})
