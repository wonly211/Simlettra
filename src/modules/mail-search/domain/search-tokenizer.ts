const CHINESE_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const LETTER_NUMBER_OR_MARK = /\p{Letter}|\p{Number}|\p{Mark}/u
const MAX_LATIN_TOKEN_LENGTH = 64

export class BodySearchInputError extends Error {}

export function tokenizeSearchText(input: string): string {
  const normalized = input.normalize('NFKC').toLocaleLowerCase('zh-CN')
  const tokens: string[] = []
  let chineseRun = ''
  let latinRun = ''

  const flushChinese = () => {
    if (chineseRun.length === 1) {
      tokens.push(chineseRun)
    } else {
      for (let index = 0; index < chineseRun.length - 1; index += 1) {
        tokens.push(chineseRun.slice(index, index + 2))
      }
    }
    chineseRun = ''
  }

  const flushLatin = () => {
    for (let index = 0; index < latinRun.length; index += MAX_LATIN_TOKEN_LENGTH) {
      tokens.push(latinRun.slice(index, index + MAX_LATIN_TOKEN_LENGTH))
    }
    latinRun = ''
  }

  for (const character of normalized) {
    if (CHINESE_CHARACTER.test(character)) {
      flushLatin()
      chineseRun += character
    } else if (LETTER_NUMBER_OR_MARK.test(character)) {
      flushChinese()
      latinRun += character
    } else {
      flushChinese()
      flushLatin()
    }
  }
  flushChinese()
  flushLatin()
  return tokens.filter(Boolean).join(' ')
}

export function createBodyMatchPhrase(input: string): string {
  const value = input.trim()
  if (!value) throw new BodySearchInputError('请输入正文关键词')
  if (value.length > 200) throw new BodySearchInputError('正文关键词不能超过 200 个字符')

  const normalized = value.normalize('NFKC')
  const chineseCharacters = [...normalized].filter((character) => CHINESE_CHARACTER.test(character))
  const hasChinesePair = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2}/u.test(normalized)
  const hasNonChineseSearchText = [...normalized].some(
    (character) => !CHINESE_CHARACTER.test(character) && LETTER_NUMBER_OR_MARK.test(character),
  )
  if (chineseCharacters.length > 0 && !hasChinesePair && !hasNonChineseSearchText) {
    throw new BodySearchInputError('中文正文搜索请至少输入两个连续汉字')
  }

  const tokens = tokenizeSearchText(value)
    .split(' ')
    .filter(Boolean)
    .map((token) => token.replaceAll('"', '""'))
  if (tokens.length === 0) throw new BodySearchInputError('正文关键词没有可搜索的文字')
  return `"${tokens.join(' ')}"`
}
