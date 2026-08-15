import { describe, expect, it } from 'vitest'
import {
  AddressValidationError,
  normalizeEmailAddress,
} from '../../src/modules/addresses/domain/email-address'

describe('邮箱地址规范化', () => {
  it('统一小写并把国际化域名转换为 Punycode', () => {
    expect(normalizeEmailAddress('Alice.Smith', '例子.中国')).toEqual({
      displayDomain: '例子.中国',
      canonicalDomain: 'xn--fsqu00a.xn--fiqs8s',
      localPart: 'alice.smith',
      canonicalAddress: 'alice.smith@xn--fsqu00a.xn--fiqs8s',
    })
  })

  it.each(['.alice', 'alice-', 'alice..mail', 'alice+tag', '中文'])('拒绝无效前缀 %s', (value) => {
    expect(() => normalizeEmailAddress(value, 'example.com')).toThrow(AddressValidationError)
  })

  it.each(['example', 'https://example.com', 'example.com:443'])('拒绝无效域名 %s', (value) => {
    expect(() => normalizeEmailAddress('alice', value)).toThrow(AddressValidationError)
  })
})
