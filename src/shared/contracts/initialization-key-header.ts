const HEADER_PREFIX = 'b64.'

export function encodeInitializationKeyHeader(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return `${HEADER_PREFIX}${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`
}

export function decodeInitializationKeyHeader(value: string): string {
  if (!value.startsWith(HEADER_PREFIX)) {
    return value
  }

  const encoded = value.slice(HEADER_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/')
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')

  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return ''
  }
}
