# KV 与 R2 故障恢复验证原型

## 目的

本原型使用本地 workerd、D1、KV 和 R2 绑定，验证邮件对象与 D1 状态之间发生部分失败时的隐藏、重试、对账、修复和永久删除行为。

该目录不属于生产工程骨架，不读取真实邮件。KV 跨地区最终一致由故障适配层模拟，本地结果不能替代真实 Cloudflare 多地区验证。

## 执行

```powershell
pnpm install
pnpm run check
pnpm run validate
```

验证命令会重建 `.data/` 本地资源，应用 D1 迁移，启动本地 Worker，运行两种存储模式的故障场景，并写出 `验证结果.json`。
