import type { StorageMode } from '../../../shared/contracts/storage-mode'

export interface StoredMailObject {
  bytes: ArrayBuffer
  backendVersionReference: string | null
}

export interface MailObjectStore {
  readonly mode: StorageMode
  put(options: {
    key: string
    bytes: ArrayBuffer
    mediaType: string
    sha256Hex: string
  }): Promise<string | null>
  get(key: string): Promise<StoredMailObject | null>
  delete(key: string): Promise<void>
}

export interface MailObjectBindings {
  MAIL_OBJECTS_KV?: KVNamespace
  MAIL_OBJECTS_R2?: R2Bucket
}

export function createMailObjectStore(
  bindings: MailObjectBindings,
  mode: StorageMode,
): MailObjectStore {
  if (mode === 'r2') {
    if (!bindings.MAIL_OBJECTS_R2) {
      throw new Error('R2 邮件对象存储绑定尚未配置')
    }
    return createR2ObjectStore(bindings.MAIL_OBJECTS_R2)
  }

  if (!bindings.MAIL_OBJECTS_KV) {
    throw new Error('KV 邮件对象存储绑定尚未配置')
  }
  return createKvObjectStore(bindings.MAIL_OBJECTS_KV)
}

function createR2ObjectStore(bucket: R2Bucket): MailObjectStore {
  return {
    mode: 'r2',
    async put(options) {
      const result = await bucket.put(options.key, options.bytes, {
        httpMetadata: { contentType: options.mediaType },
        customMetadata: { sha256: options.sha256Hex },
      })
      return result?.version ?? result?.etag ?? null
    },
    async get(key) {
      const object = await bucket.get(key)
      if (!object) return null
      return {
        bytes: await object.arrayBuffer(),
        backendVersionReference: object.version ?? object.etag ?? null,
      }
    },
    async delete(key) {
      await bucket.delete(key)
    },
  }
}

function createKvObjectStore(namespace: KVNamespace): MailObjectStore {
  return {
    mode: 'kv',
    async put(options) {
      await namespace.put(options.key, options.bytes, {
        metadata: {
          mediaType: options.mediaType,
          sha256: options.sha256Hex,
        },
      })
      return null
    },
    async get(key) {
      const bytes = await namespace.get(key, 'arrayBuffer')
      if (!bytes) return null
      return { bytes, backendVersionReference: null }
    },
    async delete(key) {
      await namespace.delete(key)
    },
  }
}
