import type { ApiErrorResponse } from '../../shared/contracts/api-error'
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../../shared/contracts/authentication'

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly field?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

export async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
  })
  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const error = isApiErrorResponse(payload)
      ? payload.error
      : { code: 'request_failed', message: `请求失败：${response.status}` }
    const retryAfter = response.headers.get('retry-after')

    throw new ApiRequestError(
      error.message,
      response.status,
      error.code,
      error.field,
      retryAfter ? Number(retryAfter) : undefined,
    )
  }

  return payload
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function authenticatedMutationHeaders(options?: { json?: boolean }): Record<string, string> {
  const csrfToken = readCookie(CSRF_COOKIE_NAME)
  if (!csrfToken) throw new Error('当前页面缺少请求保护令牌，请重新登录')

  return {
    Accept: 'application/json',
    [CSRF_HEADER_NAME]: csrfToken,
    ...(options?.json ? { 'Content-Type': 'application/json' } : {}),
  }
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string' &&
    (value.error.field === undefined || typeof value.error.field === 'string')
  )
}

export function readCookie(name: string): string | undefined {
  for (const item of document.cookie.split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    if (item.slice(0, separator).trim() === name) {
      return decodeURIComponent(item.slice(separator + 1).trim())
    }
  }
  return undefined
}
