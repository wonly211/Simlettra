# 需求变更-0004：首发移除 Cloudflare Email Sending

## 状态

已接受，当前生效

- 提议与接受日期：2026-08-11
- 适用基线：[需求基线-0001](../需求基线.md)
- 影响需求：`10.06`
- 取代结论：[需求变更-0001](0001-域外发信服务故障切换与密钥管理.md)中的首发 Provider 范围
- 架构决定：[0028 首发域外发信只支持 Resend 和 SMTP2GO](../../架构决策记录/0028-首发域外发信只支持Resend和SMTP2GO.md)

## 背景

用户明确要求从 Outbound Mail Provider 中去掉 Cloudflare Email Sending，首发不支持该服务。该决定同时消除了严格免费部署与 Cloudflare Email Sending 需要 Workers Paid 之间的直接冲突。

Cloudflare Email Routing 仍用于接收邮件，与 Cloudflare Email Sending 是不同能力。本变更只移除站外发信 Provider，不影响收信入口。

## 当前有效行为

1. 首发 Outbound Mail Provider 只支持 Resend 和 SMTP2GO。
2. 管理页面不显示 Cloudflare Email Sending 选项，不接受其密钥或回调配置。
3. 域名默认与备用发信路线只能引用 Resend 或 SMTP2GO 配置。
4. 首发不实现 Cloudflare Email Sending 提交适配器、大小规则、Queue 投递事件转换或专用健康检查。
5. Resend 继续使用幂等键和 Svix Webhook 验签；SMTP2GO 继续使用专用 HTTPS Basic Auth 回调凭据和结果未知不自动重发规则。
6. 两家服务仍遵守 Simlettra 的 20 MB 总大小上限；若服务当前限制更小，则采用更小值。
7. 默认服务明确未接受且切换能够解决失败时，可以切换到另一家冻结的备用服务；结果未知时不切换。
8. 外部邮箱验证和自动转发复用同一套 Resend/SMTP2GO 域外发信路线，不建立 Cloudflare Email Sending 特例。

## 数据与迁移影响

1. 当前尚无生产数据库或正式迁移历史，迁移草案中的 Provider 类型可以直接收紧为 `resend` 和 `smtp2go`。
2. 验证性旧数据如包含 `cloudflare_email_sending`，只能作为历史测试证据，不得迁入当前 Provider 配置表。
3. 旧系统迁移遇到 Cloudflare Email Sending 配置时跳过该配置并写入迁移报告；用户需要在新系统中配置 Resend 或 SMTP2GO。
4. 删除 Cloudflare Email Sending 不删除任何邮件、发送历史或旧系统证据；历史报告可保留当时使用的 Provider 文字，但不能重新启用该配置。

## 影响与后续工作

1. 本变更不增加或删除需求，当前仍为 161 项有效需求。
2. 第五批数据模型、迁移草案和验证原型需要只允许 Resend 与 SMTP2GO，并验证 Cloudflare Email Sending 类型被拒绝。
3. 原“三种域外发信服务”验证计划与结果保留为历史资料并明确标注已被取代；新的当前验证范围为两家服务。
4. 真实账号验证只需要 Resend 与 SMTP2GO，不再需要 Cloudflare Email Sending 测试账号或 Queue 事件订阅。
5. 未来重新支持 Cloudflare Email Sending 必须建立新的需求变更、架构决策、迁移和验证，不得通过配置开关隐藏恢复。

## 不改变的结论

1. 每个域名仍可配置一个默认 Provider 和零个或多个备用 Provider。
2. 路线版本、冻结快照、逐收件人状态、提交前登记尝试、明确未接受后切换和结果未知不自动重发继续有效。
3. Provider 与通知凭据仍由独立于 `init_key` 的配置加密主密钥保护，并由当前系统管理员完整管理。
4. Cloudflare Queue 仍用于邮件解析、任务唤醒、通知、转发、清理和对账，不因移除 Cloudflare Email Sending 而删除。
