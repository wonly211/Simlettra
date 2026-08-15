# 密码与会话验证性原型

本目录验证 Cloudflare Worker 环境中的密码哈希候选、密码记录版本化、会话令牌摘要、撤销语义、Cookie/CSRF 边界和登录限速。它只使用合成账号和临时数据库，不是生产认证实现，也不得被正式工程直接依赖。

## 运行

```powershell
pnpm install
pnpm run check
pnpm run validate
```

验证脚本会重新建立本地 D1 数据，启动本地 Wrangler Worker，执行算法测量和安全场景，然后把机器可读结果写入 `验证结果.json`。

## 边界

1. 本地 Wrangler 结果只能比较候选方案，不能替代真实 Cloudflare Worker 的 CPU、内存和冷启动复核。
2. 原型中的密码、令牌、IP 地址和恢复密钥均为合成测试数据。
3. 原型不会验证真实用户密码，也不会连接生产 Cloudflare 资源。
4. 用户接受架构决策前，本目录中的参数都只是候选值。
