import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsDirectory = join(projectDirectory, 'migrations')
const wranglerPath = join(projectDirectory, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const configPath = resolve(projectDirectory, readArgument('--config') ?? 'wrangler.jsonc')
const databaseBinding = readArgument('--database') ?? 'DB'
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'simlettra-remote-migration-'))

try {
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}-.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))

  if (migrationNames.length === 0) throw new Error('正式迁移目录中没有可执行的 SQL 文件。')

  await runWrangler([
    'd1',
    'execute',
    databaseBinding,
    '--remote',
    '--config',
    configPath,
    '--command',
    `CREATE TABLE IF NOT EXISTS d1_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT UNIQUE,
       applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
     );`,
    '--json',
  ])

  const ledgerResult = await runWrangler([
    'd1',
    'execute',
    databaseBinding,
    '--remote',
    '--config',
    configPath,
    '--command',
    'SELECT id, name, applied_at FROM d1_migrations ORDER BY id',
    '--json',
  ])
  const appliedNames = extractRows(ledgerResult.stdout).map((row) => String(row.name))

  for (const [index, name] of appliedNames.entries()) {
    if (migrationNames[index] !== name) {
      throw new Error(
        `远程迁移账本不是当前正式迁移的连续前缀：第 ${String(index + 1)} 项为 ${name}。`,
      )
    }
  }

  const pendingNames = migrationNames.slice(appliedNames.length)
  if (pendingNames.length === 0) {
    process.stdout.write(`远程 D1 已应用全部 ${String(migrationNames.length)} 个正式迁移。\n`)
    process.exitCode = 0
  } else {
    process.stdout.write(
      `准备从 ${pendingNames[0]} 开始应用 ${String(pendingNames.length)} 个远程正式迁移。\n`,
    )

    for (const name of pendingNames) {
      const sql = await readFile(join(migrationsDirectory, name), 'utf8')
      const escapedName = name.replaceAll("'", "''")
      const importPath = join(temporaryDirectory, name)
      await writeFile(
        importPath,
        `${sql.trimEnd()}\n\nINSERT INTO d1_migrations (name) VALUES ('${escapedName}');\n`,
        'utf8',
      )

      await runWrangler([
        'd1',
        'execute',
        databaseBinding,
        '--remote',
        '--config',
        configPath,
        '--file',
        importPath,
      ])
      process.stdout.write(`已应用：${name}\n`)
    }

    const finalResult = await runWrangler([
      'd1',
      'execute',
      databaseBinding,
      '--remote',
      '--config',
      configPath,
      '--command',
      'SELECT id, name, applied_at FROM d1_migrations ORDER BY id',
      '--json',
    ])
    const finalNames = extractRows(finalResult.stdout).map((row) => String(row.name))
    if (JSON.stringify(finalNames) !== JSON.stringify(migrationNames)) {
      throw new Error('远程迁移完成后的账本与正式迁移目录不一致。')
    }

    process.stdout.write(`远程 D1 已按顺序应用全部 ${String(migrationNames.length)} 个正式迁移。\n`)
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}

function readArgument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]?.trim()
  if (!value) throw new Error(`参数 ${name} 缺少值。`)
  return value
}

function extractRows(output) {
  const parsed = JSON.parse(output.trim())
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0]?.results)) {
    throw new Error('无法解析远程 D1 查询结果。')
  }
  return parsed[0].results
}

function runWrangler(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [wranglerPath, ...args], {
      cwd: projectDirectory,
      env: process.env,
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
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code !== 0) {
        rejectPromise(
          new Error(result.stderr || result.stdout || `Wrangler 退出码：${String(code)}`),
        )
        return
      }
      resolvePromise(result)
    })
  })
}
