import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, zipSync } from 'fflate'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXED_ZIP_TIME = new Date(1980, 0, 1, 0, 0, 0, 0)
const INCLUDED_ROOT_ENTRIES = [
  '.agents',
  '.dev.vars.example',
  '.editorconfig',
  '.gitignore',
  '.prettierrc.json',
  'AGENTS.md',
  'README.md',
  'drizzle.config.ts',
  'eslint.config.mjs',
  'index.html',
  'migrations',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'src',
  'tests',
  'tools',
  'tsconfig.app.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.test.json',
  'tsconfig.worker.json',
  'vite.config.ts',
  'vitest.config.ts',
  'wrangler.jsonc',
  'wrangler.kv.jsonc',
  'wrangler.test.jsonc',
  '文档',
  '验证性原型',
]
const BLOCKED_PATH_PARTS = new Set([
  '.artifacts',
  '.data',
  '.git',
  '.pnpm-store',
  '.wrangler',
  '.wrangler-original',
  '.临时',
  '.运行迁移',
  'coverage',
  'dist',
  'node_modules',
  '发布制品',
  '公开部署测试',
  '公开部署生成',
])
const IGNORED_ROOT_ENTRY_PATTERNS = [
  /^\.dev-server\..*\.log$/u,
  /^\.dev\.vars(?:\..*)?$/u,
  /^_tmp_/u,
  /\.tsbuildinfo$/u,
  /^worker-configuration\.d\.ts$/u,
  /^wrangler\.production\.local\.jsonc$/u,
  /^wrangler\.github\.generated\..*\.jsonc$/u,
]

const packageJson = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'))
const version = String(packageJson.version)
const outputDirectory = resolve(PROJECT_ROOT, readArgumentValue('--输出目录') ?? '发布制品')
const archiveName = `澄笺-${version}-源代码.zip`
const manifestName = `澄笺-${version}-源码清单.json`
const checksumName = `${archiveName}.sha256`

const sourceFiles = []
await assertNoUnexpectedRootEntries()
for (const rootEntry of INCLUDED_ROOT_ENTRIES) {
  await collectFiles(join(PROJECT_ROOT, rootEntry), sourceFiles)
}
sourceFiles.sort((left, right) => comparePaths(archivePath(left), archivePath(right)))

const secretValues = await loadLocalSecretValues()
const fileRecords = []
const zipEntries = {}
for (const absolutePath of sourceFiles) {
  const path = archivePath(absolutePath)
  assertSafeArchivePath(path)
  const bytes = await readFile(absolutePath)
  assertNoLocalSecrets(path, bytes, secretValues)
  const sha256 = digest(bytes)
  fileRecords.push({ path, bytes: bytes.byteLength, sha256 })
  zipEntries[path] = [new Uint8Array(bytes), { level: 9, mtime: FIXED_ZIP_TIME }]
}

const sourceDigest = digest(
  Buffer.from(
    fileRecords.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(''),
    'utf8',
  ),
)
const manifest = {
  formatVersion: 1,
  product: '澄笺 | Simlettra',
  version,
  sourceDigest,
  fileCount: fileRecords.length,
  totalBytes: fileRecords.reduce((total, file) => total + file.bytes, 0),
  fixedArchiveTimestamp: '1980-01-01 00:00:00',
  files: fileRecords,
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
zipEntries['源码清单.json'] = [new Uint8Array(manifestBytes), { level: 9, mtime: FIXED_ZIP_TIME }]

const firstArchive = Buffer.from(zipSync(zipEntries, { level: 9 }))
const secondArchive = Buffer.from(zipSync(zipEntries, { level: 9 }))
const archiveDigest = digest(firstArchive)
if (archiveDigest !== digest(secondArchive) || !firstArchive.equals(secondArchive)) {
  throw new Error('相同源码生成了不同 ZIP 字节，已停止写出快照')
}
verifyArchive(firstArchive, manifestBytes, fileRecords)

await mkdir(outputDirectory, { recursive: true })
await Promise.all([
  writeFile(join(outputDirectory, archiveName), firstArchive),
  writeFile(join(outputDirectory, manifestName), manifestBytes),
  writeFile(join(outputDirectory, checksumName), `${archiveDigest} *${archiveName}\n`, 'utf8'),
])

console.log(`源码快照已生成：${join(outputDirectory, archiveName)}`)
console.log(`源码文件：${fileRecords.length} 个，原始字节：${manifest.totalBytes}`)
console.log(`源码摘要：${sourceDigest}`)
console.log(`ZIP 字节：${firstArchive.byteLength}，ZIP SHA-256：${archiveDigest}`)
console.log('两次内存生成结果完全一致，本地密钥值未进入快照。')

async function assertNoUnexpectedRootEntries() {
  const included = new Set(INCLUDED_ROOT_ENTRIES)
  const ignoredDirectories = new Set([...BLOCKED_PATH_PARTS, '.git', '.pnpm-store', '.临时'])
  const unexpected = (await readdir(PROJECT_ROOT, { withFileTypes: true }))
    .filter((entry) => {
      if (included.has(entry.name)) return false
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return false
      return !IGNORED_ROOT_ENTRY_PATTERNS.some((pattern) => pattern.test(entry.name))
    })
    .map((entry) => entry.name)
    .sort(comparePaths)
  if (unexpected.length > 0) {
    throw new Error(`发现未审查的根级条目，请决定收录或排除：${unexpected.join('、')}`)
  }
}

async function collectFiles(path, target) {
  const metadata = await stat(path)
  if (metadata.isFile()) {
    if (!isIgnoredGeneratedFile(path)) target.push(path)
    return
  }
  if (!metadata.isDirectory()) return
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (BLOCKED_PATH_PARTS.has(entry.name)) continue
    if (entry.isDirectory() && entry.name.startsWith('.')) continue
    const childPath = join(path, entry.name)
    if (entry.isDirectory()) await collectFiles(childPath, target)
    else if (entry.isFile() && !isIgnoredGeneratedFile(childPath)) target.push(childPath)
  }
}

function isIgnoredGeneratedFile(absolutePath) {
  const path = archivePath(absolutePath)
  return (
    /^验证性原型\/(?:域外发信网关|对象存储故障恢复|邮件解析)\/验证结果\.json$/u.test(path) ||
    /^验证性原型\/搜索与规模\/验证结果[^/]*\.json$/u.test(path)
  )
}

function archivePath(absolutePath) {
  return relative(PROJECT_ROOT, absolutePath).split(sep).join('/')
}

function comparePaths(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function assertSafeArchivePath(path) {
  const parts = path.split('/')
  if (parts.some((part) => BLOCKED_PATH_PARTS.has(part))) {
    throw new Error(`源码快照包含禁止路径：${path}`)
  }
  if (/^\.dev\.vars(?:\.|$)/iu.test(basename(path)) && path !== '.dev.vars.example') {
    throw new Error(`源码快照包含本地密钥文件：${path}`)
  }
  if (/\.log$/iu.test(path) || /\.tsbuildinfo$/iu.test(path) || /^_tmp_/iu.test(basename(path))) {
    throw new Error(`源码快照包含生成或临时文件：${path}`)
  }
}

async function loadLocalSecretValues() {
  const actual = await parseEnvironmentFile(join(PROJECT_ROOT, '.dev.vars'))
  const publicFixtures = new Set([
    ...(await parseEnvironmentFile(join(PROJECT_ROOT, '.dev.vars.example'))),
    ...(await parseTestConfigurationValues()),
  ])
  return actual.filter((value) => value.length >= 8 && !publicFixtures.has(value))
}

async function parseTestConfigurationValues() {
  const content = await readFile(join(PROJECT_ROOT, 'wrangler.test.jsonc'), 'utf8')
  return [...content.matchAll(/"(?:INIT_KEY|CONFIG_KEY)"\s*:\s*("(?:\\.|[^"\\])*")/gu)]
    .map((match) => JSON.parse(match[1]))
    .filter(Boolean)
}

async function parseEnvironmentFile(path) {
  try {
    const content = await readFile(path, 'utf8')
    return content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => stripOptionalQuotes(line.slice(line.indexOf('=') + 1).trim()))
      .filter(Boolean)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
}

function stripOptionalQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function assertNoLocalSecrets(path, bytes, secretValues) {
  for (const secret of secretValues) {
    if (bytes.includes(Buffer.from(secret, 'utf8'))) {
      throw new Error(`源码快照文件命中本地密钥值，已停止：${path}`)
    }
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function verifyArchive(archive, manifest, records) {
  const files = unzipSync(new Uint8Array(archive))
  const paths = Object.keys(files).sort(comparePaths)
  const expectedPaths = [...records.map((record) => record.path), '源码清单.json'].sort(
    comparePaths,
  )
  if (
    paths.length !== expectedPaths.length ||
    paths.some((path, index) => path !== expectedPaths[index])
  ) {
    throw new Error('ZIP 内的文件路径与源码清单不一致')
  }
  for (const record of records) {
    const bytes = files[record.path]
    if (!bytes || bytes.byteLength !== record.bytes || digest(bytes) !== record.sha256) {
      throw new Error(`ZIP 内文件校验失败：${record.path}`)
    }
  }
  const archivedManifest = files['源码清单.json']
  if (!archivedManifest || !Buffer.from(archivedManifest).equals(manifest)) {
    throw new Error('ZIP 内源码清单与外部清单不一致')
  }
}

function readArgumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
  return value
}
