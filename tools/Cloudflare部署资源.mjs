const RESOURCE_PREFIX = 'simlettra-'
const RESOURCE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u
const R2_MAX_NAME_LENGTH = 63
const QUEUE_MAX_NAME_LENGTH = 63
const D1_RESERVED_TABLE_NAMES = new Set(['_cf_KV'])

export function createManagedResourceNames(workerName) {
  const normalizedWorkerName = String(workerName ?? '').trim()
  if (!RESOURCE_NAME_PATTERN.test(normalizedWorkerName)) {
    throw new Error(
      'Worker 项目名称只能使用小写英文字母、数字和连字符，且必须以字母或数字开头和结尾。',
    )
  }

  const names = {
    databaseName: `${RESOURCE_PREFIX}${normalizedWorkerName}-meta`,
    objectName: `${RESOURCE_PREFIX}${normalizedWorkerName}-raw`,
    queueName: `${RESOURCE_PREFIX}${normalizedWorkerName}-tasks`,
  }

  if (names.objectName.length > R2_MAX_NAME_LENGTH) {
    throw new Error(
      `Worker 项目名称过长，生成的 R2 名称 ${names.objectName} 超过 ${String(R2_MAX_NAME_LENGTH)} 个字符。请把 Worker 项目名称缩短到 49 个字符以内。`,
    )
  }
  if (names.queueName.length > QUEUE_MAX_NAME_LENGTH) {
    throw new Error(
      `Worker 项目名称过长，生成的 Queue 名称 ${names.queueName} 超过 ${String(QUEUE_MAX_NAME_LENGTH)} 个字符。请把 Worker 项目名称缩短到 47 个字符以内。`,
    )
  }

  return names
}

export async function ensureManagedCloudflareResources({
  storageMode,
  workerName,
  runWrangler,
  writeStatus = () => {},
}) {
  if (storageMode !== 'r2' && storageMode !== 'kv') {
    throw new Error('存储模式必须是 r2 或 kv。')
  }

  const names = createManagedResourceNames(workerName)
  const database = await ensureListedResource({
    displayName: 'D1 数据库',
    resourceName: names.databaseName,
    list: async () => {
      const result = await runWrangler(['d1', 'list', '--json'], {
        allowFailure: true,
        echo: false,
      })
      assertCommandSucceeded(result, '列出 D1 数据库')
      return parseJsonArray(result.stdout, 'D1 数据库列表')
    },
    getName: (entry) => entry?.name,
    getId: (entry) => entry?.uuid,
    create: () =>
      runWrangler(['d1', 'create', names.databaseName], {
        allowFailure: true,
        echo: false,
      }),
    writeStatus,
  })

  let object
  if (storageMode === 'kv') {
    object = await ensureListedResource({
      displayName: 'KV 命名空间',
      resourceName: names.objectName,
      list: async () => {
        const result = await runWrangler(['kv', 'namespace', 'list'], {
          allowFailure: true,
          echo: false,
        })
        assertCommandSucceeded(result, '列出 KV 命名空间')
        return parseJsonArray(result.stdout, 'KV 命名空间列表')
      },
      getName: (entry) => entry?.title,
      getId: (entry) => entry?.id,
      create: () =>
        runWrangler(['kv', 'namespace', 'create', names.objectName], {
          allowFailure: true,
          echo: false,
        }),
      writeStatus,
    })
  } else {
    await ensureNamedResource({
      displayName: 'R2 存储桶',
      resourceName: names.objectName,
      probe: () =>
        runWrangler(['r2', 'bucket', 'info', names.objectName, '--json'], {
          allowFailure: true,
          echo: false,
        }),
      create: () =>
        runWrangler(['r2', 'bucket', 'create', names.objectName], {
          allowFailure: true,
          echo: false,
        }),
      writeStatus,
    })
    object = { name: names.objectName }
  }

  await ensureNamedResource({
    displayName: 'Queue',
    resourceName: names.queueName,
    probe: () =>
      runWrangler(['queues', 'info', names.queueName], {
        allowFailure: true,
        echo: false,
      }),
    create: () =>
      runWrangler(['queues', 'create', names.queueName], {
        allowFailure: true,
        echo: false,
      }),
    writeStatus,
  })

  return {
    databaseId: database.id,
    databaseName: database.name,
    objectId: object.id,
    objectName: object.name,
    queueName: names.queueName,
  }
}

export function createManagedDeploymentConfig({ template, workerName, storageMode, resources }) {
  const config = {
    ...template,
    name: workerName,
    d1_databases: template.d1_databases.map((database) => ({
      ...database,
      database_name: resources.databaseName,
      database_id: resources.databaseId,
    })),
    queues: {
      producers: template.queues.producers.map((producer) => ({
        ...producer,
        queue: resources.queueName,
      })),
      consumers: template.queues.consumers.map((consumer) => ({
        ...consumer,
        queue: resources.queueName,
      })),
    },
  }

  if (storageMode === 'r2') {
    config.r2_buckets = template.r2_buckets.map((bucket) => ({
      ...bucket,
      bucket_name: resources.objectName,
    }))
  } else {
    config.kv_namespaces = template.kv_namespaces.map((namespace) => ({
      ...namespace,
      id: resources.objectId,
    }))
  }

  return config
}

export function filterD1ApplicationTableNames(tableNames) {
  return tableNames
    .map((name) => String(name))
    .filter((name) => !name.startsWith('sqlite_') && !D1_RESERVED_TABLE_NAMES.has(name))
}

async function ensureListedResource({
  displayName,
  resourceName,
  list,
  getName,
  getId,
  create,
  writeStatus,
}) {
  const existing = findUniqueResource(await list(), resourceName, getName, displayName)
  if (existing) {
    writeStatus(`复用已有${displayName}：${resourceName}`)
    return requireResourceIdentity(existing, resourceName, getName, getId, displayName)
  }

  writeStatus(`创建${displayName}：${resourceName}`)
  const creation = await create()
  const created = findUniqueResource(await list(), resourceName, getName, displayName)
  if (created) {
    return requireResourceIdentity(created, resourceName, getName, getId, displayName)
  }

  assertCommandSucceeded(creation, `创建${displayName} ${resourceName}`)
  throw new Error(`${displayName} ${resourceName} 的创建命令成功，但重新查询时没有找到该资源。`)
}

async function ensureNamedResource({ displayName, resourceName, probe, create, writeStatus }) {
  const existing = await probe()
  if (existing.code === 0) {
    writeStatus(`复用已有${displayName}：${resourceName}`)
    return
  }

  writeStatus(`创建${displayName}：${resourceName}`)
  const creation = await create()
  const created = await probe()
  if (created.code === 0) return

  assertCommandSucceeded(creation, `创建${displayName} ${resourceName}`)
  assertCommandSucceeded(created, `重新查询${displayName} ${resourceName}`)
}

function findUniqueResource(entries, resourceName, getName, displayName) {
  const matches = entries.filter((entry) => getName(entry) === resourceName)
  if (matches.length > 1) {
    throw new Error(`账号中存在多份同名${displayName} ${resourceName}，自动部署已停止。`)
  }
  return matches[0]
}

function requireResourceIdentity(entry, resourceName, getName, getId, displayName) {
  const name = getName(entry)
  const id = getId(entry)
  if (name !== resourceName || typeof id !== 'string' || id.length === 0) {
    throw new Error(`${displayName} ${resourceName} 缺少可用的真实编号。`)
  }
  return { id, name }
}

function parseJsonArray(output, description) {
  try {
    const parsed = JSON.parse(stripAnsi(output).trim())
    if (Array.isArray(parsed)) return parsed
  } catch {
    // 统一在下方给出不包含完整远程响应的安全错误。
  }
  throw new Error(`无法解析${description}。`)
}

function assertCommandSucceeded(result, action) {
  if (result.code === 0) return
  const detail = stripAnsi(result.stderr || result.stdout || '').trim()
  throw new Error(detail ? `${action}失败：${detail}` : `${action}失败。`)
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/gu, '')
}
