# 0051 让 Cloudflare 默认构建命令生成真实部署配置

> 后续细化：[0052 构建阶段幂等创建命名存储资源](0052-构建阶段幂等创建命名存储资源.md)于 2026-08-14 接受，将真实 D1 与 KV/R2 配置来源改为构建阶段按 Worker 项目名称自动查找或创建。默认构建命令、提前停止和 D1 迁移保护继续有效。

## 状态

已接受

- 决定日期：2026-08-14
- 依据：2026-08-14 首次 Cloudflare GitHub 真实部署失败
- 取代关系：取代 [ADR 0049](0049-采用可信管理员可见变量和Cloudflare连接GitHub部署.md)第 5 项中“把 Workers Builds 部署命令改为 `pnpm run deploy:github`”的具体操作；其余结论继续有效

## 背景

公开部署仓库首次连接 Cloudflare 后，平台实际执行默认构建命令 `pnpm run build` 和默认部署命令 `npx wrangler deploy`。原实现只在 `pnpm run deploy:github` 中读取 `SIMLETTRA_*` 构建变量，因此默认构建产物继续使用模板中的全零 D1 编号。Wrangler 在失败前还按模板名称自动创建了 R2 存储桶和 Queue，最后因 D1 编号不存在返回错误代码 `10181`。

Cloudflare Workers Builds 明确提供 `WORKERS_CI=1` 环境变量，Cloudflare Vite 插件会把最终部署配置重定向到构建产物。项目应直接兼容平台默认流程，不能依赖非程序员在创建 Worker 时发现并覆盖部署命令。

## 决定

1. 公开部署仓库的 `pnpm run build` 使用独立构建入口。
2. 本地没有 `WORKERS_CI=1` 时继续执行普通安全生产构建，不要求真实 Cloudflare 资源变量。
3. Workers Builds 中检测到 `WORKERS_CI=1` 时，构建入口必须先读取当前部署所需的构建变量；任何必要变量缺失时在类型生成、D1 查询、迁移、资源创建或部署前停止，并给出简体中文错误。原来要求手工提供 D1、KV/R2 与 Queue 编号或名称的部分已由 ADR 0052 取代，当前普通 Cloudflare Git 部署只需填写 `SIMLETTRA_STORAGE_MODE`。
4. Cloudflare 构建阶段生成真实临时 Wrangler 配置，检查目标 D1，按既有规则迁移全新空白 D1 或拒绝迁移版本不一致的已有 D1，再完成类型检查、安全构建和最终配置自检。
5. 构建完成后保留 Cloudflare Vite 插件生成的重定向部署配置，由默认 `npx wrangler deploy` 部署构建产物。
6. `pnpm run deploy:github` 继续保留，供本地或自定义流水线一次性执行相同预检、构建和部署；它不再是 Cloudflare Git 连接必须修改的命令。
7. 首次失败创建的 `simlettra-mail` R2 存储桶和 `simlettra-tasks` Queue 不自动删除。管理员核对它们属于本次测试且仍为空后可以自行删除；ADR 0052 的新规则不会复用这些旧名称，也不再接受手工 Queue 名称变量。

## 备选方案

1. 只要求部署者把部署命令手工改为 `pnpm run deploy:github`：步骤容易遗漏，首次真实测试已经证明默认页面会直接使用 `npx wrangler deploy`，不采用。
2. 把真实资源编号提交到 `wrangler.jsonc`：会把每套部署的 Cloudflare 资源绑定写入公共仓库，也无法支持不同部署者，不采用。
3. 让 Wrangler 自动创建全部资源：D1 迁移、已有系统升级保护和 KV 编号仍需要明确输入与检查，不采用。
4. 删除源 Wrangler 模板中的占位绑定：本地双模式类型生成、构建验证和部署模板仍需要完整绑定形状，不采用。

## 后果

### 正面

1. Cloudflare 创建 Worker 页面保留默认命令即可部署，步骤更少。
2. 缺少构建变量时不再带着占位编号进入部署，也不会因此自动创建错误绑定资源。
3. 全新 D1 自动迁移和已有 D1 版本保护仍在代码上传前执行。
4. 本地开发和双模式构建不需要真实远程资源。

### 成本与限制

1. Workers Builds 的构建阶段会访问远程 D1；Cloudflare API 权限或 D1 状态异常会使构建失败。
2. 原来要求普通部署者填写 `SIMLETTRA_WORKER_NAME` 的结论已由 ADR 0052 取代。Workers Builds 当前优先读取 Cloudflare 提供的 `WRANGLER_CI_OVERRIDE_NAME`；`SIMLETTRA_WORKER_NAME` 只保留给本地或自定义流水线。
3. 真实 Cloudflare 重试仍需确认默认命令、构建变量、D1 迁移和运行变量保留全部符合预期。

## 验证方式

1. 本地普通 `pnpm run build` 继续完成安全构建。
2. `WORKERS_CI=1` 且缺少 `SIMLETTRA_STORAGE_MODE` 时，构建必须在远程操作前失败并明确指出缺少变量。
3. R2 与 KV 模式生成的配置使用实际 Worker 名称自动创建或复用 `meta` D1、`raw` 对象存储与 `tasks` Queue，不包含 `INIT_KEY`、`CONFIG_KEY` 或第三方凭据。
4. 公开部署仓库使用默认 `pnpm run build` 和 `npx wrangler deploy` 完成真实 Cloudflare 部署。
5. 首次部署后核对 D1 全部迁移、R2/KV 和 Queue 绑定、Cron、静态网页、Worker 四入口及管理员运行变量。
