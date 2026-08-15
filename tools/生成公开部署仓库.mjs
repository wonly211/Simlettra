import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const outputDirectory = join(projectDirectory, '公开部署生成')
const sourcePackage = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

await rm(outputDirectory, { force: true, recursive: true })
await mkdir(outputDirectory, { recursive: true })

for (const name of [
  '.dev.vars.example',
  'index.html',
  'tsconfig.app.json',
  'tsconfig.worker.json',
  'vite.config.ts',
  'wrangler.jsonc',
  'wrangler.kv.jsonc',
]) {
  await copyPath(name)
}

await copyPath('src')
await copyMigrations()
for (const name of [
  'Cloudflare连接GitHub构建.mjs',
  'Cloudflare连接GitHub部署.mjs',
  'Cloudflare部署资源.mjs',
  '安全构建.mjs',
  '部署配置自检.mjs',
  '远程正式迁移.mjs',
]) {
  await copyPath(join('tools', name))
}

await writeFile(
  join(outputDirectory, 'package.json'),
  `${JSON.stringify(deploymentPackage(), null, 2)}\n`,
)
await writeFile(join(outputDirectory, 'pnpm-workspace.yaml'), deploymentWorkspace(), 'utf8')
await writeFile(join(outputDirectory, '.gitignore'), deploymentGitignore(), 'utf8')
await writeFile(
  join(outputDirectory, '.gitattributes'),
  '* text=auto eol=lf\nmigrations/*.sql whitespace=-blank-at-eof\n',
  'utf8',
)
await writeFile(join(outputDirectory, 'README.md'), deploymentReadme(), 'utf8')

await verifyOutput()

const files = await listFiles(outputDirectory)
process.stdout.write(
  `公开部署仓库已生成：${outputDirectory}\n部署文件：${String(files.length)} 个\n`,
)

async function copyPath(path) {
  const source = join(projectDirectory, path)
  const destination = join(outputDirectory, path)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
}

async function copyMigrations() {
  const sourceDirectory = join(projectDirectory, 'migrations')
  const destinationDirectory = join(outputDirectory, 'migrations')
  await mkdir(destinationDirectory, { recursive: true })
  const names = (await readdir(sourceDirectory))
    .filter((name) => /^\d{4}-.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  for (const name of names) {
    await cp(join(sourceDirectory, name), join(destinationDirectory, name))
  }
}

function deploymentPackage() {
  const developmentDependencyNames = [
    '@cloudflare/vite-plugin',
    '@vitejs/plugin-vue',
    'typescript',
    'vite',
    'vue-tsc',
    'wrangler',
  ]
  return {
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: 'module',
    packageManager: sourcePackage.packageManager,
    engines: sourcePackage.engines,
    scripts: {
      build: 'node tools/Cloudflare连接GitHub构建.mjs',
      'check:r2':
        'wrangler types --config wrangler.jsonc && vue-tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.worker.json && node tools/安全构建.mjs --config wrangler.jsonc && node tools/部署配置自检.mjs --config dist/simlettra/wrangler.json --允许占位编号',
      'check:kv':
        'wrangler types --config wrangler.kv.jsonc && vue-tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.worker.json && node tools/安全构建.mjs --config wrangler.kv.jsonc && node tools/部署配置自检.mjs --config dist/simlettra_kv/wrangler.json --允许占位编号',
      check: 'pnpm run check:r2 && pnpm run check:kv',
      'deploy:github': 'node tools/Cloudflare连接GitHub部署.mjs',
    },
    dependencies: sourcePackage.dependencies,
    devDependencies: Object.fromEntries(
      developmentDependencyNames.map((name) => [name, sourcePackage.devDependencies[name]]),
    ),
  }
}

function deploymentWorkspace() {
  return `allowBuilds:\n  core-js-pure: false\n  esbuild: true\n  workerd: true\npackages:\n  - '.'\n`
}

function deploymentGitignore() {
  return `node_modules/\ndist/\n.wrangler/\n.dev.vars\n.dev.vars.*\n!.dev.vars.example\nwrangler.github.generated.*.jsonc\nworker-configuration.d.ts\n*.tsbuildinfo\n*.log\n.env\n.env.*\n`
}

function deploymentReadme() {
  return `# 澄笺 | Simlettra\n\n这是澄笺的 Cloudflare 部署测试仓库，只包含建立 Worker 所需的网页、Worker、D1 迁移和部署工具，不包含内部测试、验证原型、研发记录、真实资源编号或密钥。\n\n> 当前版本是 \`${sourcePackage.version}\` 开发测试版。请使用测试域名和独立 Cloudflare 资源，不要直接接管正在使用的生产邮箱。\n\n## 需要的资源\n\n- 一个能够连接此 GitHub 仓库的 Cloudflare Worker；\n- 当前 Cloudflare 账号能够使用 D1、Queues，以及所选模式的 R2 或 KV；\n- 不需要手工创建 D1、KV、R2 或 Queue，也不需要复制资源编号。\n\n## 在 Cloudflare 连接 GitHub\n\n在 Cloudflare 的“创建 Worker”页面连接本仓库。保持 Workers Builds 的默认命令：\n\n| 项目 | 命令 |\n| --- | --- |\n| 构建命令 | \`pnpm run build\` |\n| 部署命令 | \`npx wrangler deploy\` |\n\n构建变量只填写存储模式：\n\n| 名称 | R2 模式 | KV 模式 |\n| --- | --- | --- |\n| \`SIMLETTRA_STORAGE_MODE\` | \`r2\` | \`kv\` |\n\nCloudflare 会提供实际 Worker 项目名称。构建会自动创建或复用：\n\n- \`simlettra-<Worker项目名称>-meta\`：D1；\n- \`simlettra-<Worker项目名称>-raw\`：R2 存储桶或 KV 命名空间；\n- \`simlettra-<Worker项目名称>-tasks\`：Queue。\n\n全新空白 D1 会自动应用全部正式迁移；已有 D1 的迁移账本与当前代码不完全一致时，构建会停止。资源创建后若后续步骤失败，资源会保留并在下次构建复用，不会自动删除。\n\n\`SIMLETTRA_WORKER_NAME\` 只用于本地或自定义流水线。\`pnpm run deploy:github\` 也只保留给这些高级路径，Cloudflare Git 连接不需要填写它们。\n\n## 设置运行变量\n\n第一次代码部署成功后，在 Worker 的“设置 → 变量和机密”中添加两项管理员可查看的文本变量：\n\n| 名称 | 要求 |\n| --- | --- |\n| \`INIT_KEY\` | 至少 16 个字符的随机值 |\n| \`CONFIG_KEY\` | 32 个随机字节的 Base64 编码 |\n\n不要把这两项放入 GitHub、构建变量、截图或日志。仓库配置启用了 \`keep_vars\`，后续 GitHub 自动部署会保留它们。\n\n## 本地检查\n\n安装 Node.js 22.13 或更高版本和 pnpm 11 后运行：\n\n\`\`\`text\npnpm install --frozen-lockfile\npnpm check\n\`\`\`\n\n\`pnpm check\` 会分别生成 R2 与 KV 类型，检查 Vue 和 Worker TypeScript，完成生产安全构建并核对部署绑定。\n\n## 当前边界\n\n本仓库用于部署测试，尚未完成正式首发要求的真实收发、接近 20 MB 邮件、完整备份恢复、外部 Provider、通知通道、跨浏览器和非程序员真人验收。当前未发布开源许可证。\n`
}

async function verifyOutput() {
  const forbiddenPaths = [
    'tests',
    '文档',
    '验证性原型',
    '.agents',
    'AGENTS.md',
    'wrangler.production.local.jsonc',
    '.dev.vars',
  ]
  const files = await listFiles(outputDirectory)
  const relativePaths = files.map((path) => relative(outputDirectory, path).replaceAll('\\', '/'))
  for (const forbidden of forbiddenPaths) {
    if (relativePaths.some((path) => path === forbidden || path.startsWith(`${forbidden}/`))) {
      throw new Error(`公开部署仓库包含禁止路径：${forbidden}`)
    }
  }

  const localSecretValues = await readLocalSecretValues()
  for (const path of files) {
    const content = await readFile(path)
    for (const secret of localSecretValues) {
      if (content.includes(Buffer.from(secret, 'utf8'))) {
        throw new Error(`公开部署文件包含本地密钥值：${relative(outputDirectory, path)}`)
      }
    }
    for (const forbiddenVariable of [
      'CONFIG_ENCRYPTION_KEY_V1',
      'SIMLETTRA_D1_DATABASE_ID',
      'SIMLETTRA_QUEUE_NAME',
      'SIMLETTRA_R2_BUCKET_NAME',
      'SIMLETTRA_KV_NAMESPACE_ID',
    ]) {
      if (content.includes(Buffer.from(forbiddenVariable, 'utf8'))) {
        throw new Error(
          `公开部署文件仍包含已取代变量 ${forbiddenVariable}：${relative(outputDirectory, path)}`,
        )
      }
    }
  }
}

async function readLocalSecretValues() {
  try {
    const content = await readFile(join(projectDirectory, '.dev.vars'), 'utf8')
    return content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) =>
        line
          .slice(line.indexOf('=') + 1)
          .trim()
          .replace(/^['"]|['"]$/gu, ''),
      )
      .filter((value) => value.length >= 8)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(path)))
    if (entry.isFile()) files.push(path)
  }
  return files
}
