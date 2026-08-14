# 澄笺 | Simlettra

这是澄笺的 Cloudflare 部署测试仓库，只包含建立 Worker 所需的网页、Worker、D1 迁移和部署工具，不包含内部测试、验证原型、研发记录、真实资源编号或密钥。

> 当前版本是 `0.1.0-dev.0` 开发测试版。请使用测试域名和独立 Cloudflare 资源，不要直接接管正在使用的生产邮箱。

## 需要的资源

- 一份全新的 Cloudflare D1 数据库；
- 一个 Cloudflare Queue；
- R2 模式需要一个 R2 存储桶，KV 模式需要一个 KV 命名空间；
- 一个能够连接此 GitHub 仓库的 Cloudflare Worker。

## 在 Cloudflare 连接 GitHub

在 Cloudflare 的“创建 Worker”页面连接本仓库。保持 Workers Builds 的默认命令：

| 项目 | 命令 |
| --- | --- |
| 构建命令 | `pnpm run build` |
| 部署命令 | `npx wrangler deploy` |

构建变量按所选模式填写：

| 名称 | R2 模式 | KV 模式 |
| --- | --- | --- |
| `SIMLETTRA_STORAGE_MODE` | `r2` | `kv` |
| `SIMLETTRA_WORKER_NAME` | Cloudflare 页面实际创建的 Worker 名称 | Cloudflare 页面实际创建的 Worker 名称 |
| `SIMLETTRA_D1_DATABASE_ID` | D1 编号 | D1 编号 |
| `SIMLETTRA_QUEUE_NAME` | Queue 名称 | Queue 名称 |
| `SIMLETTRA_R2_BUCKET_NAME` | R2 存储桶名称 | 不填写 |
| `SIMLETTRA_KV_NAMESPACE_ID` | 不填写 | KV 命名空间编号 |

默认构建会生成真实资源配置。缺少变量时会在远程操作前停止；全新空白 D1 会自动应用全部正式迁移；已有 D1 的迁移账本与当前代码不完全一致时，构建会停止。

`pnpm run deploy:github` 仅保留给本地或自定义流水线一次性完成构建和部署，Cloudflare Git 连接不需要改用它。

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
