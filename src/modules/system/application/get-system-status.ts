import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import {
  APPLICATION_DISPLAY_NAME,
  APPLICATION_NAME,
  APPLICATION_VERSION,
  type SystemStatusResponse,
} from '../../../shared/contracts/system-status'
import type { StorageMode } from '../../../shared/contracts/storage-mode'
import { systemInstances } from '../infrastructure/schema'

export async function getSystemStatus(
  database: D1Database,
  storageMode: StorageMode,
  now: () => Date = () => new Date(),
): Promise<SystemStatusResponse> {
  const initialized = await isSystemInitialized(database)

  return buildSystemStatus(initialized, storageMode, now)
}

export function buildSystemStatus(
  initialized: boolean,
  storageMode: StorageMode,
  now: () => Date = () => new Date(),
): SystemStatusResponse {
  return {
    data: {
      application: APPLICATION_NAME,
      displayName: APPLICATION_DISPLAY_NAME,
      version: APPLICATION_VERSION,
      health: 'ok',
      initialization: initialized ? 'initialized' : 'not_initialized',
      storageMode,
      checkedAt: now().toISOString(),
    },
  }
}

export async function isSystemInitialized(database: D1Database): Promise<boolean> {
  const rows = await drizzle(database)
    .select({ singletonId: systemInstances.singletonId })
    .from(systemInstances)
    .where(eq(systemInstances.singletonId, 1))
    .limit(1)

  return rows.length === 1
}
