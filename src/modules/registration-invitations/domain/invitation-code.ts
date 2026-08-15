const INVITATION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const INVITATION_CODE_LENGTH = 25
const INVITATION_CODE_GROUP_LENGTH = 5
const ENCRYPTION_ALGORITHM = 'AES-GCM-256'

export class InvitationCodeConfigurationError extends Error {}

export interface EncryptedInvitationCode {
  ciphertext: Uint8Array
  nonce: Uint8Array
  algorithm: typeof ENCRYPTION_ALGORITHM
  keyVersion: 1
}

export function generateInvitationCode(): string {
  const characters: string[] = []
  const usableByteLimit =
    Math.floor(256 / INVITATION_CODE_ALPHABET.length) * INVITATION_CODE_ALPHABET.length

  while (characters.length < INVITATION_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    for (const value of bytes) {
      if (value >= usableByteLimit) continue
      characters.push(INVITATION_CODE_ALPHABET[value % INVITATION_CODE_ALPHABET.length]!)
      if (characters.length === INVITATION_CODE_LENGTH) break
    }
  }

  const groups: string[] = []
  for (let index = 0; index < characters.length; index += INVITATION_CODE_GROUP_LENGTH) {
    groups.push(characters.slice(index, index + INVITATION_CODE_GROUP_LENGTH).join(''))
  }
  return groups.join('-')
}

export function normalizeInvitationCode(value: string): string | null {
  const normalized = value.toUpperCase().replace(/[\s-]+/gu, '')
  return normalized.length === INVITATION_CODE_LENGTH &&
    [...normalized].every((character) => INVITATION_CODE_ALPHABET.includes(character))
    ? normalized
    : null
}

export async function digestInvitationCode(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

export async function encryptInvitationCode(options: {
  code: string
  invitationId: string
  encryptionKeyBase64?: string
}): Promise<EncryptedInvitationCode> {
  const key = await importEncryptionKey(options.encryptionKeyBase64)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: additionalData(options.invitationId),
    },
    key,
    new TextEncoder().encode(options.code),
  )
  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce,
    algorithm: ENCRYPTION_ALGORITHM,
    keyVersion: 1,
  }
}

export async function decryptInvitationCode(options: {
  ciphertext: ArrayBuffer
  nonce: ArrayBuffer
  invitationId: string
  encryptionKeyBase64?: string
}): Promise<string> {
  const key = await importEncryptionKey(options.encryptionKeyBase64)
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(options.nonce).slice(),
        additionalData: additionalData(options.invitationId),
      },
      key,
      new Uint8Array(options.ciphertext).slice(),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    throw new InvitationCodeConfigurationError('邀请码加密数据无法读取，请检查配置加密主密钥')
  }
}

export async function digestRegistrationSource(options: {
  source: string
  encryptionKeyBase64?: string
}): Promise<Uint8Array> {
  const bytes = decodeEncryptionKey(options.encryptionKeyBase64)
  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`account-registration\u0000${options.source}`),
    ),
  )
}

async function importEncryptionKey(value?: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', decodeEncryptionKey(value), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

function decodeEncryptionKey(value?: string): Uint8Array {
  if (!value) {
    throw new InvitationCodeConfigurationError('部署配置尚未设置 CONFIG_KEY')
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new InvitationCodeConfigurationError('CONFIG_KEY 不是有效的 Base64')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (bytes.length !== 32) {
    throw new InvitationCodeConfigurationError('CONFIG_KEY 必须解码为 32 字节')
  }
  return bytes
}

function additionalData(invitationId: string): Uint8Array {
  return new TextEncoder().encode(`simlettra:account-registration-invitation:v1:${invitationId}`)
}
