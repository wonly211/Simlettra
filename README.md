# 澄笺 | Simlettra

这是澄笺的 Cloudflare 部署测试仓库，只包含建立 Worker 所需的网页、Worker、D1 迁移和部署工具，不包含内部测试、验证原型、研发记录、真实资源编号或密钥。

> 当前版本是 `0.1.0-dev.0` 开发测试版。请使用测试域名和独立 Cloudflare 资源，不要直接接管正在使用的生产邮箱。

## 需要的资源

- 一个能够连接此 GitHub 仓库的 Cloudflare Worker；
- 当前 Cloudflare 账号能够使用 D1、Queues，以及所选模式的 R2 或 KV；
- 不需要手工创建 D1、KV、R2 或 Queue，也不需要复制资源编号。

## 在 Cloudflare 连接 GitHub

在 Cloudflare 的“创建 Worker”页面连接本仓库。保持 Workers Builds 的默认命令：

| 项目 | 命令 |
| --- | --- |
| 构建命令 | `pnpm run build` |
| 部署命令 | `npx wrangler deploy` |

构建变量只填写存储模式：

| 名称 | R2 模式 | KV 模式 |
| --- | --- | --- |
| `SIMLETTRA_STORAGE_MODE` | `r2` | `kv` |

Cloudflare 会提供实际 Worker 项目名称。构建会自动创建或复用：

- `simlettra-<Worker项目名称>-meta`：D1；
- `simlettra-<Worker项目名称>-raw`：R2 存储桶或 KV 命名空间；
- `simlettra-<Worker项目名称>-tasks`：Queue。

全新空白 D1 会自动应用全部正式迁移；已有 D1 的迁移账本与当前代码不完全一致时，构建会停止。资源创建后若后续步骤失败，资源会保留并在下次构建复用，不会自动删除。

`SIMLETTRA_WORKER_NAME` 只用于本地或自定义流水线。`pnpm run deploy:github` 也只保留给这些高级路径，Cloudflare Git 连接不需要填写它们。

## 设置运行变量

第一次代码部署成功后，在 Worker 的“设置 → 变量和机密”中添加两项管理员可查看的文本变量：

| 名称 | 要求 |
| --- | --- |
| `INIT_KEY` | 至少 16 个字符的随机值 |
| `CONFIG_KEY` | 32 个随机字节的 Base64 编码 |

不要把这两项放入 GitHub、构建变量、截图或日志。仓库配置启用了 `keep_vars`，后续 GitHub 自动部署会保留它们。

## 本地检查

安装 Node.js 22.13 或更高版本和 pnpm 11 后运行：

```text
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 会分别生成 R2 与 KV 类型，检查 Vue 和 Worker TypeScript，完成生产安全构建并核对部署绑定。

## 当前边界

本仓库用于部署测试，尚未完成正式首发要求的真实收发、接近 20 MB 邮件、完整备份恢复、外部 Provider、通知通道、跨浏览器和非程序员真人验收。当前未发布开源许可证。
