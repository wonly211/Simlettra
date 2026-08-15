import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const isWorkersBuild = process.env.WORKERS_CI === '1'
const toolName = isWorkersBuild ? 'Cloudflare连接GitHub部署.mjs' : '安全构建.mjs'
const args = isWorkersBuild ? ['--仅构建'] : []

if (isWorkersBuild) {
  process.stdout.write(
    '检测到 Cloudflare Workers Builds，正在按 Worker 项目名称准备 D1、KV/R2 与 Queue 并生成真实部署配置。\n',
  )
}

await runNodeTool(toolName, args)

function runNodeTool(name, toolArgs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(projectDirectory, 'tools', name), ...toolArgs], {
      cwd: projectDirectory,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: 'inherit',
    })

    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      rejectPromise(
        new Error(
          signal
            ? `${name} 被信号 ${signal} 终止。`
            : `${name} 执行失败，退出码为 ${String(code)}。`,
        ),
      )
    })
  })
}
