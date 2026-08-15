# D1 数据库工具与迁移验证性原型

本目录比较原生 D1、Drizzle 和 Prisma 处理同一组邮箱表、组合查询、FTS5 与版本迁移时的行为。它只使用合成数据，不是正式数据模型或生产工程骨架。

## 目标

1. 验证普通表结构能否由 TypeScript 模型生成可审查 SQL。
2. 验证 FTS5、外键检查和数据回填能否与生成迁移共存。
3. 验证迁移重复执行、失败回滚、升级前导出和恢复对账。
4. 比较 Drizzle、Prisma 和原生 D1 的类型检查、查询表达、运行时包体与 Cloudflare 边界。

## 边界

1. 本目录中的表不是正式 Simlettra 数据模型。
2. 本地 Wrangler 不能替代远程 D1 Time Travel 和多地区 Sessions 验证。
3. 用户接受架构决策前，不得把任何候选工具加入正式生产依赖。

## 运行

```powershell
pnpm install
pnpm run generate:prisma
pnpm run check:drizzle
pnpm run check:prisma
pnpm run validate
```

验证脚本会重新建立本地 D1，分阶段应用迁移，启动 Drizzle 与 Prisma 两个候选 Worker，执行 11 组场景，并把机器可读证据写入 `验证结果.json`。`.artifacts/` 中的逻辑备份只包含合成数据。
