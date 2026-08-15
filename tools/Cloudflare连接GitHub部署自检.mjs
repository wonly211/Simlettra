import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  createManagedDeploymentConfig,
  createManagedResourceNames,
  ensureManagedCloudflareResources,
  filterD1ApplicationTableNames,
} from './Cloudflare部署资源.mjs'

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const buildToolPath = join(projectDirectory, 'tools', 'Cloudflare连接GitHub构建.mjs')
const r2Template = parseJsonc(await readFile(join(projectDirectory, 'wrangler.jsonc'), 'utf8'))
const kvTemplate = parseJsonc(await readFile(join(projectDirectory, 'wrangler.kv.jsonc'), 'utf8'))

await verifyFreshMode('r2', r2Template)
await verifyFreshMode('kv', kvTemplate)
await verifyExistingResourcesAreReused()
await verifyConcurrentCreationIsReused()
verifyWorkerNameBoundary()
verifyD1ReservedTableBoundary()
await verifyMissingBuildVariablesFailEarly()

process.stdout.write(
  'Cloudflare 连接 GitHub 部署自检通过：D1、KV/R2、Queue 命名创建、复用、并发恢复、D1 保留表和提前停止均符合规则。\n',
)

async function verifyFreshMode(mode, template) {
  const fake = createFakeWrangler({ mode })
  const resources = await ensureManagedCloudflareResources({
    storageMode: mode,
    workerName: 'simlettra-github',
    runWrangler: fake.run,
  })
  const config = createManagedDeploymentConfig({
    template,
    workerName: 'simlettra-github',
    storageMode: mode,
    resources,
  })

  assert(resources.databaseName === 'simlettra-simlettra-github-meta', `${mode} D1 名称错误`)
  assert(resources.objectName === 'simlettra-simlettra-github-raw', `${mode} 对象名称错误`)
  assert(resources.queueName === 'simlettra-simlettra-github-tasks', `${mode} Queue 名称错误`)
  assert(config.name === 'simlettra-github', `${mode} Worker 名称错误`)
  assert(config.keep_vars === true, `${mode} 未保留 Cloudflare 控制台变量`)
  assert(config.vars?.STORAGE_MODE === mode, `${mode} 存储模式错误`)
  assert(
    config.d1_databases?.[0]?.database_name === 'simlettra-simlettra-github-meta',
    `${mode} D1 名称未写入`,
  )
  assert(config.d1_databases?.[0]?.database_id.endsWith('1'), `${mode} D1 编号未写入`)
  assert(
    config.queues?.producers?.[0]?.queue === 'simlettra-simlettra-github-tasks',
    `${mode} Queue 名称未写入`,
  )
  assert(!('INIT_KEY' in config.vars), `${mode} 配置不应携带 INIT_KEY`)
  assert(!('CONFIG_KEY' in config.vars), `${mode} 配置不应携带 CONFIG_KEY`)

  if (mode === 'r2') {
    assert(config.r2_buckets?.[0]?.bucket_name === 'simlettra-simlettra-github-raw', 'R2 名称错误')
    assert((config.kv_namespaces?.length ?? 0) === 0, 'R2 模式不应绑定 KV')
  } else {
    assert(config.kv_namespaces?.[0]?.id.startsWith('1'), 'KV 编号错误')
    assert((config.r2_buckets?.length ?? 0) === 0, 'KV 模式不应绑定 R2')
  }

  const commands = fake.commands.join('\n')
  assert(commands.includes('d1 create simlettra-simlettra-github-meta'), `${mode} 未创建 D1`)
  assert(
    commands.includes('queues create simlettra-simlettra-github-tasks'),
    `${mode} 未创建 Queue`,
  )
  assert(
    commands.includes(
      mode === 'r2'
        ? 'r2 bucket create simlettra-simlettra-github-raw'
        : 'kv namespace create simlettra-simlettra-github-raw',
    ),
    `${mode} 未创建对象资源`,
  )
}

async function verifyExistingResourcesAreReused() {
  const fake = createFakeWrangler({ mode: 'kv', preexisting: true })
  const resources = await ensureManagedCloudflareResources({
    storageMode: 'kv',
    workerName: 'family-mail',
    runWrangler: fake.run,
  })

  assert(resources.databaseName === 'simlettra-family-mail-meta', '已有 D1 名称错误')
  assert(resources.objectName === 'simlettra-family-mail-raw', '已有 KV 名称错误')
  assert(resources.queueName === 'simlettra-family-mail-tasks', '已有 Queue 名称错误')
  assert(!fake.commands.some((command) => command.includes(' create ')), '已有资源不应重新创建')
}

async function verifyConcurrentCreationIsReused() {
  const fake = createFakeWrangler({
    mode: 'r2',
    conflicts: new Set(['d1', 'r2', 'queue']),
  })
  const resources = await ensureManagedCloudflareResources({
    storageMode: 'r2',
    workerName: 'team-mail',
    runWrangler: fake.run,
  })

  assert(resources.databaseId.endsWith('1'), '并发创建后没有复用 D1')
  assert(resources.objectName === 'simlettra-team-mail-raw', '并发创建后没有复用 R2')
  assert(resources.queueName === 'simlettra-team-mail-tasks', '并发创建后没有复用 Queue')
}

function verifyWorkerNameBoundary() {
  assertThrows(() => createManagedResourceNames('Bad_Name'), '非法 Worker 名称没有停止')
  assertThrows(() => createManagedResourceNames('a'.repeat(48)), '过长 Worker 名称没有停止')
}

function verifyD1ReservedTableBoundary() {
  assert(
    filterD1ApplicationTableNames(['_cf_KV']).length === 0,
    'Cloudflare D1 保留表不应使全新数据库被判定为已有业务数据',
  )
  assert(
    filterD1ApplicationTableNames(['sqlite_sequence', '_cf_KV']).length === 0,
    'SQLite 与 Cloudflare 保留表不应进入业务表集合',
  )
  assert(
    JSON.stringify(filterD1ApplicationTableNames(['_cf_KV', 'users', 'd1_migrations'])) ===
      JSON.stringify(['users', 'd1_migrations']),
    '业务表和正式迁移账本必须保留',
  )
  assert(filterD1ApplicationTableNames(['_cf_unknown']).length === 1, '未知 _cf_ 表不能被宽泛忽略')
}

async function verifyMissingBuildVariablesFailEarly() {
  const environment = { ...process.env, WORKERS_CI: '1' }
  for (const name of [
    'SIMLETTRA_STORAGE_MODE',
    'SIMLETTRA_WORKER_NAME',
    'SIMLETTRA_D1_DATABASE_ID',
    'SIMLETTRA_QUEUE_NAME',
    'SIMLETTRA_R2_BUCKET_NAME',
    'SIMLETTRA_KV_NAMESPACE_ID',
    'WRANGLER_CI_OVERRIDE_NAME',
  ]) {
    delete environment[name]
  }

  const result = await runProcess(buildToolPath, [], environment)
  assert(result.code !== 0, 'Cloudflare 默认构建缺少存储模式时不应成功')
  assert(
    `${result.stdout}\n${result.stderr}`.includes('Cloudflare 构建变量缺少 SIMLETTRA_STORAGE_MODE'),
    'Cloudflare 默认构建没有给出缺少存储模式变量的明确错误',
  )
}

function createFakeWrangler({ mode, preexisting = false, conflicts = new Set() }) {
  const names = createManagedResourceNames(
    preexisting ? 'family-mail' : conflicts.size > 0 ? 'team-mail' : 'simlettra-github',
  )
  const state = {
    d1: preexisting ? [{ name: names.databaseName, uuid: testDatabaseId() }] : [],
    kv: preexisting && mode === 'kv' ? [{ title: names.objectName, id: testNamespaceId() }] : [],
    r2: new Set(preexisting && mode === 'r2' ? [names.objectName] : []),
    queues: new Set(preexisting ? [names.queueName] : []),
  }
  const commands = []
  const pendingConflicts = new Set(conflicts)

  return {
    commands,
    run: async (args) => {
      const command = args.join(' ')
      commands.push(command)

      if (command === 'd1 list --json') return success(JSON.stringify(state.d1))
      if (args[0] === 'd1' && args[1] === 'create') {
        state.d1 = [{ name: args[2], uuid: testDatabaseId() }]
        return consumeConflict(pendingConflicts, 'd1')
      }
      if (command === 'kv namespace list') return success(JSON.stringify(state.kv))
      if (args[0] === 'kv' && args[1] === 'namespace' && args[2] === 'create') {
        state.kv = [{ title: args[3], id: testNamespaceId() }]
        return consumeConflict(pendingConflicts, 'kv')
      }
      if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'info') {
        return state.r2.has(args[3]) ? success('{}') : failure('R2 不存在')
      }
      if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'create') {
        state.r2.add(args[3])
        return consumeConflict(pendingConflicts, 'r2')
      }
      if (args[0] === 'queues' && args[1] === 'info') {
        return state.queues.has(args[2]) ? success('Queue exists') : failure('Queue 不存在')
      }
      if (args[0] === 'queues' && args[1] === 'create') {
        state.queues.add(args[2])
        return consumeConflict(pendingConflicts, 'queue')
      }
      throw new Error(`自检没有模拟 Wrangler 命令：${command}`)
    },
  }
}

function consumeConflict(conflicts, type) {
  if (conflicts.delete(type)) return failure(`${type} 已由并发构建创建`)
  return success('created')
}

function success(stdout) {
  return { code: 0, stdout, stderr: '' }
}

function failure(stderr) {
  return { code: 1, stdout: '', stderr }
}

function testDatabaseId() {
  return '00000000-0000-0000-0000-000000000001'
}

function testNamespaceId() {
  return '11111111111111111111111111111111'
}

function runProcess(path, args, environment) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [path, ...args], {
      cwd: projectDirectory,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', rejectPromise)
    child.once('close', (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

function parseJsonc(content) {
  return JSON.parse(content.replace(/,\s*([}\]])/gu, '$1'))
}

function assertThrows(action, message) {
  try {
    action()
  } catch {
    return
  }
  throw new Error(message)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
