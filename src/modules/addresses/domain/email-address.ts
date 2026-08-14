export class AddressValidationError extends Error {
  constructor(
    readonly field: 'domainName' | 'localPart',
    message: string,
  ) {
    super(message)
  }
}

export interface NormalizedEmailAddress {
  displayDomain: string
  canonicalDomain: string
  localPart: string
  canonicalAddress: string
}

const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const EXTERNAL_LOCAL_PART_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function normalizeEmailAddress(
  localPartInput: string,
  domainInput: string,
): NormalizedEmailAddress {
  const localPart = normalizeLocalPart(localPartInput)
  const domain = normalizeDomain(domainInput)

  return {
    ...domain,
    localPart,
    canonicalAddress: `${localPart}@${domain.canonicalDomain}`,
  }
}

export function normalizeCompleteEmailAddress(input: string): NormalizedEmailAddress {
  const value = input.trim()
  const separator = value.lastIndexOf('@')
  if (separator < 1 || separator !== value.indexOf('@') || separator === value.length - 1) {
    throw new AddressValidationError('localPart', '请输入完整的邮箱地址')
  }

  return normalizeEmailAddress(value.slice(0, separator), value.slice(separator + 1))
}

export function normalizeRecipientEmailAddress(input: string): NormalizedEmailAddress {
  const value = input.trim()
  const separator = value.lastIndexOf('@')
  if (separator < 1 || separator !== value.indexOf('@') || separator === value.length - 1) {
    throw new AddressValidationError('localPart', '请输入完整的邮箱地址')
  }

  const localPart = value.slice(0, separator).toLowerCase()
  if (localPart.length > 64 || !EXTERNAL_LOCAL_PART_PATTERN.test(localPart)) {
    throw new AddressValidationError('localPart', '收件邮箱前缀格式无效')
  }
  const domain = normalizeDomain(value.slice(separator + 1))
  return {
    ...domain,
    localPart,
    canonicalAddress: `${localPart}@${domain.canonicalDomain}`,
  }
}

export function normalizeLocalPart(input: string): string {
  const value = input.trim().toLowerCase()

  if (value.length < 1 || value.length > 64) {
    throw new AddressValidationError('localPart', '邮箱前缀必须包含 1 至 64 个字符')
  }

  if (!LOCAL_PART_PATTERN.test(value)) {
    throw new AddressValidationError(
      'localPart',
      '邮箱前缀只能使用小写英文字母、数字、点、下划线和连字符，且首尾必须是字母或数字',
    )
  }

  if (value.includes('..')) {
    throw new AddressValidationError('localPart', '邮箱前缀不能包含连续两个点')
  }

  return value
}

export function normalizeDomain(
  input: string,
): Pick<NormalizedEmailAddress, 'displayDomain' | 'canonicalDomain'> {
  const displayDomain = input.trim().replace(/\.$/, '').toLowerCase()

  if (
    !displayDomain ||
    displayDomain.includes('/') ||
    displayDomain.includes('\\') ||
    displayDomain.includes('@') ||
    displayDomain.includes(':')
  ) {
    throw new AddressValidationError('domainName', '请输入不包含协议、端口或路径的邮件域名')
  }

  let canonicalDomain: string
  try {
    canonicalDomain = new URL(`http://${displayDomain}`).hostname.toLowerCase()
  } catch {
    throw new AddressValidationError('domainName', '邮件域名格式无效')
  }

  if (canonicalDomain.length < 3 || canonicalDomain.length > 253) {
    throw new AddressValidationError('domainName', '邮件域名长度必须在 3 至 253 个字符之间')
  }

  const labels = canonicalDomain.split('.')
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label))) {
    throw new AddressValidationError('domainName', '请输入包含有效后缀的完整邮件域名')
  }

  return {
    displayDomain,
    canonicalDomain,
  }
}
