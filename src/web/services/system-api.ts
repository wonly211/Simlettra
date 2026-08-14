import {
  INITIALIZATION_KEY_HEADER,
  type InitializationAuthorizationResponse,
  type InitializeSystemRequest,
  type InitializeSystemResponse,
} from '../../shared/contracts/initialization'
import { encodeInitializationKeyHeader } from '../../shared/contracts/initialization-key-header'
import type { SystemStatusResponse } from '../../shared/contracts/system-status'
import { isRecord, requestJson } from './api-client'

export { ApiRequestError } from './api-client'

export async function fetchSystemStatus(signal?: AbortSignal): Promise<SystemStatusResponse> {
  const payload = await requestJson('/api/system/status', {
    headers: { Accept: 'application/json' },
    signal: signal ?? null,
  })

  if (!isSystemStatusResponse(payload)) {
    throw new Error('系统状态响应格式无效')
  }

  return payload
}

export async function authorizeInitialization(
  initKey: string,
): Promise<InitializationAuthorizationResponse> {
  const payload = await requestJson('/api/initialization/authorize', {
    method: 'POST',
    headers: initializationHeaders(initKey),
  })

  if (!isRecord(payload) || !isRecord(payload.data) || payload.data.authorized !== true) {
    throw new Error('初始化鉴权响应格式无效')
  }

  return payload as unknown as InitializationAuthorizationResponse
}

export async function completeInitialization(
  initKey: string,
  input: InitializeSystemRequest,
): Promise<InitializeSystemResponse> {
  const payload = await requestJson('/api/initialization/complete', {
    method: 'POST',
    headers: {
      ...initializationHeaders(initKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    payload.data.initialization !== 'initialized'
  ) {
    throw new Error('初始化结果响应格式无效')
  }

  return payload as unknown as InitializeSystemResponse
}

function initializationHeaders(initKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    [INITIALIZATION_KEY_HEADER]: encodeInitializationKeyHeader(initKey),
  }
}

function isSystemStatusResponse(value: unknown): value is SystemStatusResponse {
  if (!isRecord(value) || !isRecord(value.data)) {
    return false
  }

  return (
    value.data.application === 'Simlettra' &&
    value.data.displayName === '澄笺' &&
    typeof value.data.version === 'string' &&
    value.data.health === 'ok' &&
    (value.data.initialization === 'not_initialized' ||
      value.data.initialization === 'initialized') &&
    (value.data.storageMode === 'kv' || value.data.storageMode === 'r2') &&
    typeof value.data.checkedAt === 'string'
  )
}
