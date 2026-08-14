import type { StorageMode } from '../shared/contracts/storage-mode'
import type { BackgroundTaskMessage } from '../shared/contracts/background-task'

export interface WorkerBindings {
  DB: D1Database
  INIT_KEY: string
  CONFIG_KEY?: string
  STORAGE_MODE: string
  TASK_QUEUE: Queue<BackgroundTaskMessage>
  MAIL_OBJECTS_KV?: KVNamespace
  MAIL_OBJECTS_R2?: R2Bucket
}

export function parseStorageMode(value: string): StorageMode {
  if (value === 'kv' || value === 'r2') {
    return value
  }

  throw new Error('部署配置中的 STORAGE_MODE 必须是 kv 或 r2')
}
