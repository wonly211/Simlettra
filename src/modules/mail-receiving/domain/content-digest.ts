export async function sha256Bytes(value: ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : toUint8Array(value)
  const input =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input as ArrayBuffer))
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

export function equalBytes(
  left: ArrayBuffer | Uint8Array,
  right: ArrayBuffer | Uint8Array,
): boolean {
  const leftBytes = toUint8Array(left)
  const rightBytes = toUint8Array(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  return leftBytes.every((value, index) => value === rightBytes[index])
}

export function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  const bytes = toUint8Array(value)
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : bytes.slice().buffer
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}
