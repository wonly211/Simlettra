import { equalBytes, sha256Bytes } from '../../mail-receiving/domain/content-digest'

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE_BYTES = 10

export async function createExternalEmailVerificationCode(): Promise<{
  displayCode: string
  salt: Uint8Array
  digest: Uint8Array
}> {
  const random = crypto.getRandomValues(new Uint8Array(CODE_BYTES))
  let value = 0n
  for (const byte of random) value = (value << 8n) | BigInt(byte)
  let code = ''
  for (let index = 0; index < 16; index += 1) {
    code = ALPHABET[Number(value & 31n)] + code
    value >>= 5n
  }
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return {
    displayCode: code.match(/.{1,4}/gu)?.join('-') ?? code,
    salt,
    digest: await digestVerificationCode(code, salt),
  }
}

export async function verifyExternalEmailCode(
  suppliedCode: string,
  salt: ArrayBuffer,
  expectedDigest: ArrayBuffer,
): Promise<boolean> {
  const normalized = normalizeVerificationCode(suppliedCode)
  if (!normalized) return false
  const digest = await digestVerificationCode(normalized, new Uint8Array(salt))
  return equalBytes(digest, new Uint8Array(expectedDigest))
}

export function normalizeVerificationCode(value: string): string | null {
  const normalized = value.toUpperCase().replace(/[\s-]/gu, '')
  return normalized.length === 16 &&
    [...normalized].every((character) => ALPHABET.includes(character))
    ? normalized
    : null
}

async function digestVerificationCode(code: string, salt: Uint8Array): Promise<Uint8Array> {
  const codeBytes = new TextEncoder().encode(code)
  const input = new Uint8Array(salt.byteLength + codeBytes.byteLength)
  input.set(salt)
  input.set(codeBytes, salt.byteLength)
  return sha256Bytes(input)
}
