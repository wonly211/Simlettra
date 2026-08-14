import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const configArgumentIndex = process.argv.indexOf('--config')
const configPath = process.argv[configArgumentIndex + 1]
const allowPlaceholders = process.argv.includes('--允许占位编号')

if (configArgumentIndex < 0 || !configPath) {
  throw new Error('必须使用 --config 指定安全构建生成的 wrangler.json。')
}

const resolvedPath = resolve(configPath)
const config = JSON.parse(await readFile(resolvedPath, 'utf8'))
const failures = []

if ('configPath' in config || 'userConfigPath' in config) {
  failures.push('产物仍包含本机 Wrangler 配置绝对路径')
}
if (!/^\d{4}-\d{2}-\d{2}$/u.test(config.compatibility_date ?? '')) {
  failures.push('compatibility_date 不是 YYYY-MM-DD')
}
if (config.main !== 'index.js') failures.push('Worker 入口不是构建产物 index.js')
if (config.keep_vars !== true) failures.push('必须保留管理员在 Cloudflare 控制台设置的变量')

const storageMode = config.vars?.STORAGE_MODE
if (storageMode !== 'r2' && storageMode !== 'kv') failures.push('STORAGE_MODE 必须是 r2 或 kv')
const variableNames = Object.keys(config.vars ?? {})
if (variableNames.some((name) => !['STORAGE_MODE'].includes(name))) {
  failures.push('仓库配置中的 vars 只能包含非敏感的 STORAGE_MODE')
}

const database = singleBinding(config.d1_databases, 'D1')
if (database?.binding !== 'DB') failures.push('D1 绑定必须命名为 DB')
if (!database?.migrations_dir?.endsWith('migrations')) failures.push('D1 未指向正式 migrations')
if (!database?.database_id) failures.push('D1 缺少 database_id')
if (!allowPlaceholders && database?.database_id === '00000000-0000-0000-0000-000000000000') {
  failures.push('D1 仍使用全零占位编号')
}

if (storageMode === 'r2') {
  const bucket = singleBinding(config.r2_buckets, 'R2')
  if (bucket?.binding !== 'MAIL_OBJECTS_R2') failures.push('R2 绑定名称不正确')
  if (!bucket?.bucket_name) failures.push('R2 缺少 bucket_name')
  if ((config.kv_namespaces?.length ?? 0) !== 0) failures.push('R2 模式不能同时绑定邮件 KV')
}

if (storageMode === 'kv') {
  const namespace = singleBinding(config.kv_namespaces, 'KV')
  if (namespace?.binding !== 'MAIL_OBJECTS_KV') failures.push('KV 绑定名称不正确')
  if (!namespace?.id) failures.push('KV 缺少命名空间 id')
  if (!allowPlaceholders && namespace?.id === '00000000000000000000000000000000') {
    failures.push('KV 仍使用全零占位编号')
  }
  if ((config.r2_buckets?.length ?? 0) !== 0) failures.push('KV 模式不能同时绑定邮件 R2')
}

const producer = singleBinding(config.queues?.producers, 'Queue producer')
const consumer = singleBinding(config.queues?.consumers, 'Queue consumer')
if (producer?.binding !== 'TASK_QUEUE') failures.push('Queue producer 绑定必须命名为 TASK_QUEUE')
if (!producer?.queue || producer.queue !== consumer?.queue) {
  failures.push('Queue producer 与 consumer 必须使用同一队列')
}
if (consumer?.max_batch_size !== 10) failures.push('Queue max_batch_size 必须为 10')
if (consumer?.max_batch_timeout !== 5) failures.push('Queue max_batch_timeout 必须为 5')
if (consumer?.max_retries !== 3) failures.push('Queue max_retries 必须为 3')

if (JSON.stringify(config.triggers?.crons) !== JSON.stringify(['0 * * * *'])) {
  failures.push('Cron 必须保持每小时执行一次')
}
if (config.assets?.not_found_handling !== 'single-page-application') {
  failures.push('静态资源必须使用单页应用回退')
}
if (!config.assets?.run_worker_first?.includes('/api/*')) {
  failures.push('API 请求必须先进入 Worker')
}

if (failures.length > 0) {
  throw new Error(`部署配置自检失败：\n${failures.join('\n')}`)
}

console.log(
  `部署配置自检通过：${config.name} 使用 ${storageMode.toUpperCase()}，${allowPlaceholders ? '当前允许模板占位编号' : '资源编号已替换'}。`,
)

function singleBinding(value, label) {
  if (!Array.isArray(value) || value.length !== 1) {
    failures.push(`${label} 必须且只能配置一个`)
    return undefined
  }
  return value[0]
}
