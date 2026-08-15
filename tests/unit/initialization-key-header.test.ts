import { describe, expect, it } from 'vitest'
import {
  decodeInitializationKeyHeader,
  encodeInitializationKeyHeader,
} from '../../src/shared/contracts/initialization-key-header'

describe('初始化密钥传输编码', () => {
  it('可以无损传输中文和符号', () => {
    const value = '澄笺-初始化-密钥-2026-!@#'
    const encoded = encodeInitializationKeyHeader(value)

    expect(encoded).toMatch(/^b64\.[A-Za-z0-9_-]+$/u)
    expect(decodeInitializationKeyHeader(encoded)).toBe(value)
  })

  it('兼容尚未编码的 ASCII 密钥', () => {
    expect(decodeInitializationKeyHeader('legacy-ascii-key')).toBe('legacy-ascii-key')
  })
})
