const RESOURCE_CREDENTIAL_ALGORITHM = 'AES-GCM-256'

export class PlatformResourceCredentialError extends Error {}

export async function encryptPlatformResourceToken(options: {
  encryptionKeyBase64?: string
  configurationVersion: number
  token: string
}): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const key = await importKey(options.encryptionKeyBase64)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: additionalData(options.configurationVersion),
    },
    key,
    new TextEncoder().encode(options.token),
  )
  return { ciphertext: new Uint8Array(ciphertext), nonce }
}

export async function decryptPlatformResourceToken(options: {
  encryptionKeyBase64?: string
  configurationVersion: number
  ciphertext: ArrayBuffer
  nonce: ArrayBuffer
}): Promise<string> {
  const key = await importKey(options.encryptionKeyBase64)
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(options.nonce).slice(),
        additionalData: additionalData(options.configurationVersion),
      },
      key,
      new Uint8Array(options.ciphertext).slice(),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    throw new PlatformResourceCredentialError('Cloudflare 只读令牌无法使用当前配置主密钥解密')
  }
}

export { RESOURCE_CREDENTIAL_ALGORITHM }

async function importKey(value?: string): Promise<CryptoKey> {
  if (!value?.trim()) {
    throw new PlatformResourceCredentialError('部署配置尚未设置 CONFIG_KEY')
  }
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(value.trim()), (character) => character.charCodeAt(0))
  } catch {
    throw new PlatformResourceCredentialError('CONFIG_KEY 不是有效的 Base64')
  }
  if (bytes.byteLength !== 32) {
    throw new PlatformResourceCredentialError('CONFIG_KEY 必须解码为 32 字节')
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function additionalData(version: number): Uint8Array {
  return new TextEncoder().encode(`simlettra:cloudflare-resource-token:${version}`)
}
