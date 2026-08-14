export const SESSION_IDLE_DURATION_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_DURATION_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 60 * 60 * 1000

export interface NewSessionTokens {
  sessionToken: string
  sessionTokenDigest: Uint8Array
  csrfToken: string
  csrfTokenDigest: Uint8Array
}

export async function createSessionTokens(): Promise<NewSessionTokens> {
  const sessionToken = randomToken()
  const csrfToken = randomToken()

  return {
    sessionToken,
    sessionTokenDigest: await digestToken(sessionToken),
    csrfToken,
    csrfTokenDigest: await digestToken(csrfToken),
  }
}

export async function digestToken(token: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
}

export function isPlausibleToken(token: string | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(token)
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false

  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!
  }

  return difference === 0
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
