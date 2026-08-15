import type { StorageMode } from './storage-mode'

export const INITIALIZATION_KEY_HEADER = 'X-Simlettra-Init-Key'

export interface InitializeSystemRequest {
  adminDisplayName: string
  domainName: string
  localPart: string
  password: string
  timezone: string
}

export interface InitializationAuthorizationResponse {
  data: {
    authorized: true
    storageMode: StorageMode
  }
}

export interface InitializeSystemResponse {
  data: {
    initialization: 'initialized'
    administrator: {
      displayName: string
      primaryAddress: string
    }
    domain: {
      displayName: string
      canonicalName: string
    }
    storageMode: StorageMode
  }
}
