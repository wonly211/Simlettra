import { spawn } from 'node:child_process'
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(toolsDirectory)
const outputDirectory = join(projectRoot, 'dist')
const viteEntry = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const configArgumentIndex = process.argv.indexOf('--config')
const wranglerConfigPath =
  configArgumentIndex >= 0 ? process.argv[configArgumentIndex + 1]?.trim() : undefined

if (configArgumentIndex >= 0 && !wranglerConfigPath) {
  throw new Error('使用 --config 时必须提供 Wrangler 配置文件路径。')
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findSecretFiles() {
  const entries = await readdir(projectRoot, { withFileTypes: true })

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === '.dev.vars' || entry.name.startsWith('.dev.vars.')) &&
        entry.name !== '.dev.vars.example',
    )
    .map((entry) => join(projectRoot, entry.name))
}

function extractSecretValues(content) {
  const values = []

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    const separator = trimmed.indexOf('=')
    if (separator < 1) continue

    let value = trimmed.slice(separator + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
      value = value.slice(1, -1)
    }

    if (value.length >= 8) values.push(value)
  }

  return values
}

async function moveSecretsOutOfProject(secretFiles) {
  if (secretFiles.length === 0) return undefined

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'simlettra-build-'))
  const temporaryState = { temporaryDirectory, movedFiles: [] }

  try {
    for (const source of secretFiles) {
      const destination = join(temporaryDirectory, source.split(/[\\/]/u).at(-1))

      try {
        await rename(source, destination)
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error
        await copyFile(source, destination)
        await rm(source)
      }

      temporaryState.movedFiles.push({ source, destination })
    }
  } catch (error) {
    await restoreSecrets(temporaryState)
    throw error
  }

  return temporaryState
}

async function restoreSecrets(temporaryState) {
  if (!temporaryState) return

  for (const { source, destination } of temporaryState.movedFiles) {
    if (!(await exists(destination))) continue

    try {
      await rename(destination, source)
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
      await copyFile(destination, source)
      await rm(destination)
    }
  }

  await rm(temporaryState.temporaryDirectory, { force: true, recursive: true })
}

async function runViteBuild() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteEntry, 'build'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...(wranglerConfigPath ? { SIMLETTRA_WRANGLER_CONFIG: wranglerConfigPath } : {}),
      },
      stdio: 'inherit',
    })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          signal ? `Vite 构建被信号 ${signal} 终止。` : `Vite 构建失败，退出码为 ${String(code)}。`,
        ),
      )
    })
  })
}

async function listFiles(directory) {
  if (!(await exists(directory))) return []

  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(path)))
    if (entry.isFile()) files.push(path)
  }

  return files
}

async function verifyBuildOutput(secretSources) {
  const outputFiles = await listFiles(outputDirectory)
  const forbiddenNames = outputFiles.filter((path) => {
    const name = path.split(/[\\/]/u).at(-1)
    return name === '.dev.vars' || name.startsWith('.dev.vars.')
  })

  const secretNeedles = []
  for (const { content } of secretSources) {
    if (content.length >= 8) secretNeedles.push(Buffer.from(content))
    for (const value of extractSecretValues(content)) {
      secretNeedles.push(Buffer.from(value))
    }
  }

  const leakedContent = []
  for (const path of outputFiles) {
    const information = await stat(path)
    if (information.size === 0 || secretNeedles.length === 0) continue

    const output = await readFile(path)
    if (secretNeedles.some((needle) => output.includes(needle))) {
      leakedContent.push(path)
    }
  }

  const violations = [...new Set([...forbiddenNames, ...leakedContent])]
  if (violations.length === 0) return

  await rm(outputDirectory, { force: true, recursive: true })
  const paths = violations.map((path) => relative(projectRoot, path)).join('、')
  throw new Error(`生产构建发现本地密钥文件或密钥内容，已删除 dist：${paths}`)
}

async function removeLocalPathsFromBuildConfigs() {
  const outputFiles = await listFiles(outputDirectory)
  const configFiles = outputFiles.filter((path) => path.endsWith('wrangler.json'))

  for (const path of configFiles) {
    const config = JSON.parse(await readFile(path, 'utf8'))
    delete config.configPath
    delete config.userConfigPath
    await writeFile(path, `${JSON.stringify(config)}\n`, 'utf8')
  }
}

const secretFiles = await findSecretFiles()
const secretSources = await Promise.all(
  secretFiles.map(async (path) => ({ path, content: await readFile(path, 'utf8') })),
)

let temporaryState
let buildError

try {
  temporaryState = await moveSecretsOutOfProject(secretFiles)
  await runViteBuild()
  await removeLocalPathsFromBuildConfigs()
  await verifyBuildOutput(secretSources)
  process.stdout.write('生产构建安全检查通过：dist 不含本地 .dev.vars 或已知密钥内容。\n')
} catch (error) {
  buildError = error
} finally {
  try {
    await restoreSecrets(temporaryState)
  } catch (restoreError) {
    if (buildError) {
      throw new AggregateError([buildError, restoreError], '构建失败，且本地密钥配置恢复失败。')
    }
    throw restoreError
  }
}

if (buildError) throw buildError
