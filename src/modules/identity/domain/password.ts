export const PASSWORD_FORMAT_VERSION = 1
export const PASSWORD_ALGORITHM = 'PBKDF2-HMAC-SHA-256'
export const PASSWORD_ITERATIONS = 900_000
export const PASSWORD_BLOCKLIST_VERSION = '2026-08-11-1'
export const TEMPORARY_PASSWORD_DURATION_MS = 24 * 60 * 60 * 1000

const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
const TEMPORARY_PASSWORD_GROUP_LENGTH = 5
const TEMPORARY_PASSWORD_GROUPS = 4

const COMMON_PASSWORDS = new Set([
  '111111111111111',
  '123456789012345',
  '1234567890123456',
  'administrator',
  'adminadminadmin',
  'changemechangeme',
  'iloveyouiloveyou',
  'letmeinletmein',
  'passwordpassword',
  'qwertyqwertyqwerty',
  'qwertyuiopasdfgh',
  'simlettrasimlettra',
  'welcome123456789',
  'welcomewelcome',
])

export class PasswordValidationError extends Error {
  readonly field = 'password'
}

export interface PasswordContext {
  displayName: string
  localPart: string
  canonicalDomain: string
}

export interface PasswordRecord {
  formatVersion: number
  algorithm: string
  iterations: number
  salt: Uint8Array
  derivedKey: Uint8Array
}

const VIRTUAL_PASSWORD_RECORD: PasswordRecord = {
  formatVersion: PASSWORD_FORMAT_VERSION,
  algorithm: PASSWORD_ALGORITHM,
  iterations: PASSWORD_ITERATIONS,
  salt: new Uint8Array([
    0x53, 0x69, 0x6d, 0x6c, 0x65, 0x74, 0x74, 0x72, 0x61, 0x2d, 0x76, 0x69, 0x72, 0x74, 0x75, 0x61,
  ]),
  derivedKey: new Uint8Array(32),
}

export function validatePassword(password: string, context: PasswordContext): void {
  const length = [...password].length
  if (length < 15 || length > 128) {
    throw new PasswordValidationError('密码必须包含 15 至 128 个字符')
  }

  const comparable = normalizeComparableText(password)
  if (COMMON_PASSWORDS.has(comparable) || isSimpleRepeatedPassword(comparable)) {
    throw new PasswordValidationError('该密码过于常见，请使用更难猜测的密码')
  }

  const accountTokens = [
    context.localPart,
    ...context.canonicalDomain.split('.'),
    normalizeComparableText(context.displayName),
    'simlettra',
    '澄笺',
  ]
    .map(normalizeComparableText)
    .filter((token) => token.length >= 4)

  if (accountTokens.some((token) => comparable.includes(token))) {
    throw new PasswordValidationError('密码不能包含邮箱、域名、显示名称或产品名称中的明显文字')
  }
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const derivedKey = await derivePassword(password, salt, PASSWORD_ITERATIONS)

  return {
    formatVersion: PASSWORD_FORMAT_VERSION,
    algorithm: PASSWORD_ALGORITHM,
    iterations: PASSWORD_ITERATIONS,
    salt,
    derivedKey,
  }
}

export function generateTemporaryPassword(): string {
  const characters: string[] = []
  const usableByteLimit =
    Math.floor(256 / TEMPORARY_PASSWORD_ALPHABET.length) * TEMPORARY_PASSWORD_ALPHABET.length

  while (characters.length < TEMPORARY_PASSWORD_GROUP_LENGTH * TEMPORARY_PASSWORD_GROUPS) {
    const randomBytes = crypto.getRandomValues(new Uint8Array(32))
    for (const value of randomBytes) {
      if (value >= usableByteLimit) continue
      characters.push(TEMPORARY_PASSWORD_ALPHABET[value % TEMPORARY_PASSWORD_ALPHABET.length]!)
      if (characters.length === TEMPORARY_PASSWORD_GROUP_LENGTH * TEMPORARY_PASSWORD_GROUPS) break
    }
  }

  const groups: string[] = []
  for (let index = 0; index < characters.length; index += TEMPORARY_PASSWORD_GROUP_LENGTH) {
    groups.push(characters.slice(index, index + TEMPORARY_PASSWORD_GROUP_LENGTH).join(''))
  }
  return groups.join('-')
}

export function generateValidTemporaryPassword(context: PasswordContext): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const password = generateTemporaryPassword()
    try {
      validatePassword(password, context)
      return password
    } catch (error) {
      if (!(error instanceof PasswordValidationError)) throw error
    }
  }

  throw new Error('无法生成符合规则的临时密码')
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  if (
    record.formatVersion !== PASSWORD_FORMAT_VERSION ||
    record.algorithm !== PASSWORD_ALGORITHM ||
    !Number.isInteger(record.iterations) ||
    record.iterations < 600_000 ||
    record.salt.length !== 16 ||
    record.derivedKey.length !== 32
  ) {
    return false
  }

  const actual = await derivePassword(password, record.salt, record.iterations)
  return constantTimeEqual(actual, record.derivedKey)
}

export async function verifyPasswordAgainstVirtualRecord(password: string): Promise<void> {
  await verifyPassword(password, VIRTUAL_PASSWORD_RECORD)
}

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const source = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      salt,
    },
    source,
    256,
  )

  return new Uint8Array(derivedBits)
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false

  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!
  }

  return difference === 0
}

function normalizeComparableText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function isSimpleRepeatedPassword(value: string): boolean {
  if (/^(.)\1{14,}$/u.test(value)) {
    return true
  }

  for (let size = 1; size <= 8; size += 1) {
    if (value.length >= 15 && value.length % size === 0) {
      const unit = value.slice(0, size)
      if (unit.repeat(value.length / size) === value) {
        return true
      }
    }
  }

  return false
}
