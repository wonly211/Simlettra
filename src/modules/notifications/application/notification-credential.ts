const CREDENTIAL_ALGORITHM = 'AES-GCM-256'

export class NotificationCredentialError extends Error {
  constructor(message: string) {
    super(message)
  }
}

export async function notificationEncryptionConfigured(value?: string): Promise<boolean> {
  try {
    return (await importNotificationEncryptionKey(value, false)) !== null
  } catch {
    return false
  }
}

export async function encryptNotificationCredential(options: {
  encryptionKeyBase64?: string
  subscriptionId: string
  credential: object
}): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array; algorithm: string; keyVersion: number }> {
  const key = await importNotificationEncryptionKey(options.encryptionKeyBase64, true)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const additionalData = credentialAdditionalData(options.subscriptionId)
  const plaintext = new TextEncoder().encode(JSON.stringify(options.credential))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData },
    key!,
    plaintext,
  )
  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce,
    algorithm: CREDENTIAL_ALGORITHM,
    keyVersion: 1,
  }
}

export async function decryptNotificationCredential<T>(options: {
  encryptionKeyBase64?: string
  subscriptionId: string
  ciphertext: ArrayBuffer
  nonce: ArrayBuffer
}): Promise<T> {
  const key = await importNotificationEncryptionKey(options.encryptionKeyBase64, true)
  try {
    const nonce = new Uint8Array(options.nonce).slice()
    const ciphertext = new Uint8Array(options.ciphertext).slice()
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: credentialAdditionalData(options.subscriptionId),
      },
      key!,
      ciphertext,
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
  } catch {
    throw new NotificationCredentialError('通知凭据无法使用当前配置加密主密钥解密')
  }
}

async function importNotificationEncryptionKey(
  value: string | undefined,
  required: boolean,
): Promise<CryptoKey | null> {
  if (!value) {
    if (required) {
      throw new NotificationCredentialError('部署配置尚未设置 CONFIG_KEY')
    }
    return null
  }
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  } catch {
    throw new NotificationCredentialError('CONFIG_KEY 不是有效的 Base64')
  }
  if (bytes.byteLength !== 32) {
    throw new NotificationCredentialError('CONFIG_KEY 必须解码为 32 字节')
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function credentialAdditionalData(subscriptionId: string): Uint8Array {
  return new TextEncoder().encode(`simlettra:notification:${subscriptionId}:1`)
}
