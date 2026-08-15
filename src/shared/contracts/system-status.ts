export const APPLICATION_NAME = 'Simlettra'
export const APPLICATION_DISPLAY_NAME = '澄笺'
export const APPLICATION_VERSION = '0.1.0-dev.0'

export interface SystemStatusResponse {
  data: {
    application: typeof APPLICATION_NAME
    displayName: typeof APPLICATION_DISPLAY_NAME
    version: typeof APPLICATION_VERSION
    health: 'ok'
    initialization: 'not_initialized' | 'initialized'
    storageMode: StorageMode
    checkedAt: string
  }
}
import type { StorageMode } from './storage-mode'
