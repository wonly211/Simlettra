# 域外发信网关验证原型

> 历史状态：本原型记录 2026-08-10 对三家候选 Provider 的验证。用户已于 2026-08-11 决定首发移除 Cloudflare Email Sending；当前只支持 Resend 和 SMTP2GO。本目录中的 Cloudflare 代码与结果仅作为历史证据，不得作为当前生产实现依据。

## 目的

本原型验证 Cloudflare Email Sending、Resend 和 SMTP2GO 的统一大小限制、提交幂等、结果未知处理、回调鉴权和状态映射。

原型只使用本地模拟供应商与合成 MIME，不读取真实邮件、不包含真实密钥，也不会向外部地址发送邮件。

原型覆盖：

1. 以最终 MIME 字节数计算 `Simlettra` 与供应商限制中的较小值。
2. Cloudflare 普通外部地址 5 MiB 和已验证目标 25 MiB 的条件差异。
3. Resend 24 小时幂等键，以及 Cloudflare、SMTP2GO 的结果未知处理。
4. 每个站外收件人的独立投递状态。
5. Cloudflare Queue、Resend Svix 和 SMTP2GO Basic Auth 的事件入口边界。
6. 事件防重、乱序保护和投诉独立标记。

## 执行

```powershell
pnpm install
pnpm run check
pnpm run validate
```

验证命令会重建 `.data/`、应用 D1 迁移、启动本地 Worker，并写出 `验证结果.json`。

本地结果不能代替当前 Resend 与 SMTP2GO 真实账号的远程契约测试，也不证明实际送达率、套餐配额和费用。
