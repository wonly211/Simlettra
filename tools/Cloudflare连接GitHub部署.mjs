import { spawn } from 'node:child_process'
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const storageMode = requiredEnvironment('SIMLETTRA_STORAGE_MODE').toLowerCase()
if (storageMode !== 'r2' && storageMode !== 'kv') {
  throw new Error('SIMLETTRA_STORAGE_MODE 必须是 r2 或 kv。')
}

const templatePath = join(
  projectDirectory,
  storageMode === 'r2' ? 'wrangler.jsonc' : 'wrangler.kv.jsonc',
)
const template = parseJsonc(await readFile(templatePath, 'utf8'))
const workerName = optionalEnvironment('SIMLETTRA_WORKER_NAME') ?? template.name
const databaseId = requiredEnvironment('SIMLETTRA_D1_DATABASE_ID')
const queueName = requiredEnvironment('SIMLETTRA_QUEUE_NAME')
const generatedConfigOutput = readArgument('--仅生成配置')
const buildOnly = process.argv.includes('--仅构建')
const generatedConfigPath = join(
  projectDirectory,
  `wrangler.github.generated.${String(process.pid)}.jsonc`,
)

try {
  const config = {
    ...template,
    name: workerName,
    d1_databases: template.d1_databases.map((database) => ({
      ...database,
      database_id: databaseId,
    })),
    queues: {
      producers: template.queues.producers.map((producer) => ({ ...producer, queue: queueName })),
      consumers: template.queues.consumers.map((consumer) => ({ ...consumer, queue: queueName })),
    },
  }

  if (storageMode === 'r2') {
    const bucketName = requiredEnvironment('SIMLETTRA_R2_BUCKET_NAME')
    config.r2_buckets = template.r2_buckets.map((bucket) => ({
      ...bucket,
      bucket_name: bucketName,
    }))
  } else {
    const namespaceId = requiredEnvironment('SIMLETTRA_KV_NAMESPACE_ID')
    config.kv_namespaces = template.kv_namespaces.map((namespace) => ({
      ...namespace,
      id: namespaceId,
    }))
  }

  await writeFile(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  if (generatedConfigOutput) {
    await writeFile(
      resolve(projectDirectory, generatedConfigOutput),
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    )
    process.stdout.write('Cloudflare GitHub 部署配置已生成，本次未连接远程资源。\n')
  } else {
    await runWrangler(['types', '--config', generatedConfigPath])
    await runPackageManager(['exec', 'vue-tsc', '--noEmit', '-p', 'tsconfig.app.json'])
    await runPackageManager(['exec', 'tsc', '--noEmit', '-p', 'tsconfig.worker.json'])
    await assertRemoteDatabaseIsReady(generatedConfigPath)
    await runNodeTool('安全构建.mjs', ['--config', generatedConfigPath])

    const builtConfigPath = await findBuiltConfig(workerName)
    await runNodeTool('部署配置自检.mjs', ['--config', builtConfigPath])
    if (buildOnly) {
      process.stdout.write(
        'Cloudflare GitHub 构建已完成，真实资源配置已写入构建产物，等待 Wrangler 默认部署命令。\n',
      )
    } else {
      await runWrangler(['deploy', '--config', builtConfigPath])
    }
  }
} finally {
  await rm(generatedConfigPath, { force: true })
}

async function assertRemoteDatabaseIsReady(configPath) {
  const result = await runWrangler([
    'd1',
    'execute',
    'DB',
    '--remote',
    '--config',
    configPath,
    '--command',
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    '--json',
  ])
  const tables = extractRows(result.stdout).map((row) => String(row.name))

  if (tables.length === 0) {
    await runNodeTool('远程正式迁移.mjs', ['--config', configPath])
    return
  }

  if (!tables.includes('d1_migrations')) {
    throw new Error('目标 D1 已有数据但没有正式迁移账本，GitHub 自动部署已停止。')
  }

  const ledgerResult = await runWrangler([
    'd1',
    'execute',
    'DB',
    '--remote',
    '--config',
    configPath,
    '--command',
    'SELECT name FROM d1_migrations ORDER BY id;',
    '--json',
  ])
  const appliedNames = extractRows(ledgerResult.stdout).map((row) => String(row.name))
  const migrationNames = await loadMigrationNames()
  if (JSON.stringify(appliedNames) !== JSON.stringify(migrationNames)) {
    throw new Error(
      '目标 D1 不是当前迁移版本。GitHub 自动部署不会升级已有系统，请先按升级手册备份、迁移和检查。',
    )
  }
}

async function loadMigrationNames() {
  const migrationDirectory = join(projectDirectory, 'migrations')
  return (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}-.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

async function findBuiltConfig(expectedName) {
  const distributionDirectory = join(projectDirectory, 'dist')
  const candidates = []
  for (const entry of await readdir(distributionDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(distributionDirectory, entry.name, 'wrangler.json')
    try {
      await access(path)
      const config = JSON.parse(await readFile(path, 'utf8'))
      if (config.name === expectedName) candidates.push(path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`无法唯一定位 Worker ${expectedName} 的构建配置。`)
  }
  return candidates[0]
}

function requiredEnvironment(name) {
  const value = optionalEnvironment(name)
  if (!value) throw new Error(`Cloudflare 构建变量缺少 ${name}。`)
  return value
}

function optionalEnvironment(name) {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function readArgument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]?.trim()
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值。`)
  return value
}

function parseJsonc(content) {
  return JSON.parse(content.replace(/,\s*([}\]])/gu, '$1'))
}

function extractRows(output) {
  const parsed = JSON.parse(output.trim())
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0]?.results)) {
    throw new Error('无法解析远程 D1 查询结果。')
  }
  return parsed[0].results
}

function runPackageManager(args) {
  return runCommand(process.env.npm_execpath ? process.execPath : 'pnpm', [
    ...(process.env.npm_execpath ? [process.env.npm_execpath] : []),
    ...args,
  ])
}

function runNodeTool(name, args) {
  return runCommand(process.execPath, [join(projectDirectory, 'tools', name), ...args])
}

function runWrangler(args) {
  return runCommand(process.execPath, [
    join(projectDirectory, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    ...args,
  ])
}

function runCommand(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: projectDirectory,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => {
      stdout.push(Buffer.from(chunk))
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr.push(Buffer.from(chunk))
      process.stderr.write(chunk)
    })
    child.once('error', rejectPromise)
    child.once('close', (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code !== 0) {
        rejectPromise(new Error(result.stderr || result.stdout || `命令退出码：${String(code)}`))
        return
      }
      resolvePromise(result)
    })
  })
}
