import { describe, expect, it } from 'vitest'
import {
  BodySearchInputError,
  createBodyMatchPhrase,
  tokenizeSearchText,
} from '../../src/modules/mail-search/public'

describe('邮件正文搜索词元', () => {
  it('为连续中文生成相邻双字词元', () => {
    expect(tokenizeSearchText('项目预算调整')).toBe('项目 目预 预算 算调 调整')
    expect(createBodyMatchPhrase('预算调整')).toBe('"预算 算调 调整"')
  })

  it('统一兼容字符、大小写、拉丁文字和数字', () => {
    expect(tokenizeSearchText('Ｔｅａｍ-Report ２０２６')).toBe('team report 2026')
    expect(createBodyMatchPhrase('TEAM 2026')).toBe('"team 2026"')
  })

  it('拒绝只有一个汉字的正文查询', () => {
    expect(() => createBodyMatchPhrase('预')).toThrow(BodySearchInputError)
    expect(() => createBodyMatchPhrase('预')).toThrow('至少输入两个连续汉字')
  })
})
