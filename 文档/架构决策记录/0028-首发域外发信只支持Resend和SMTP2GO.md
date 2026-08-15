# 0028 首发域外发信只支持 Resend 和 SMTP2GO

## 状态

已接受

- 提议与接受日期：2026-08-11
- 需求依据：[需求变更-0004：首发移除 Cloudflare Email Sending](../需求/变更记录/0004-首发移除CloudflareEmailSending.md)
- 取代关系：取代 ADR `0010`、`0021` 和 `0026` 中关于 Cloudflare Email Sending 适配器、大小规则、事件入口和三家 Provider 范围的部分结论；这些记录关于逐收件人状态、路线冻结、Resend、SMTP2GO、回调鉴权、安全切换和结果未知的其余结论继续有效

## 背景

此前首发范围包含 Cloudflare Email Sending、Resend 和 SMTP2GO。用户现在明确要求移除 Cloudflare Email Sending，首发只支持 Resend 和 SMTP2GO。

项目仍使用 Cloudflare Email Routing 收信，并继续使用 Cloudflare Queue 唤醒后台任务。移除的是域外发信 Provider，而不是 Cloudflare 的收信和异步基础设施。

## 决定

1. 首发 Provider 类型集合固定为 `resend` 和 `smtp2go`。
2. Outbound Mail Gateway 只建立 Resend 与 SMTP2GO 两个适配器；公共契约继续包含能力描述、完整负载大小检查、提交、错误归类和事件转换。
3. Provider 配置、域名路线、冻结路线快照、提交尝试和 Provider 事件的类型约束只接受 `resend` 与 `smtp2go`。
4. 首发不实现 Cloudflare Email Sending API 调用、普通外部地址 5 MiB 特例、已验证目标特例、Event Subscriptions Queue 事件转换或专用配置健康检查。
5. Resend 的有效邮件大小取 Simlettra 20 MB 与 Resend 当前限制中的较小值；SMTP2GO 同理。限制由适配器能力配置提供，发布前复核。
6. Resend 在有效期内复用稳定幂等键；SMTP2GO 在结果未知时停止自动重发。两者均在能证明尚未接受时允许安全重试。
7. Resend Provider 事件使用原始请求体和 Svix 请求头验签；SMTP2GO 使用专用 HTTPS Basic Auth 强凭据。事件继续按“Provider 类型加事件编号”防重。
8. 每个域名仍拥有版本化的默认和备用路线。默认服务明确未接受且错误可由切换解决时，才尝试另一家冻结 Provider；结果未知不切换。
9. 外部邮箱验证和来信转发复用同一条两家 Provider 路线，不建立新的特殊发送通道。
10. 历史验证资料可以保留 Cloudflare Email Sending 的测试结果，但生产类型、当前迁移草案和新验证不得重新接受该 Provider。

## 备选方案

1. 保留 Cloudflare Email Sending 作为隐藏的可选 Provider：会让首发代码、配置、事件入口和测试继续承担已经明确取消的范围，不采用。
2. 只保留 Resend：实现最少，但失去备用 Provider 和故障切换能力，不采用。
3. 只保留 SMTP2GO：同样失去备用路线，也浪费 Resend 已提供的幂等能力，不采用。
4. 保留三家数据类型但前端隐藏 Cloudflare：数据库和接口仍能启用被取消的功能，不能形成可信边界，不采用。

## 后果

### 正面

1. 首发不再依赖需要 Workers Paid 的 Cloudflare Email Sending。
2. 删除 5 MiB 特例和 Queue 发信事件入口，适配器与验证矩阵更小。
3. Resend 与 SMTP2GO 仍能组成默认与备用路线，保留安全故障切换。
4. Provider 类型从数据库约束开始收紧，不能通过隐藏配置恢复已取消功能。

### 成本与限制

1. 首发域外发信可用性依赖 Resend 或 SMTP2GO 至少配置一家。
2. 两家服务的免费套餐、发送限制和账号审核可能变化，发布前仍需真实账号验证。
3. 旧三家 Provider 验证结果不能直接代表当前两家实现已经完成。
4. 未来恢复 Cloudflare Email Sending 需要新的需求和迁移，不能只增加一个界面选项。

## 验证方式

1. Provider 配置、路线、快照、尝试和事件表拒绝 `cloudflare_email_sending`，只接受 `resend` 与 `smtp2go`。
2. 一个域名可以使用 Resend 作为默认、SMTP2GO 作为备用，也可以反向配置。
3. Resend 明确未接受时可切换 SMTP2GO；Resend 结果未知时不得切换。
4. SMTP2GO 明确未接受时可切换 Resend；SMTP2GO 结果未知时不得切换。
5. Resend 重复提交使用相同幂等键只产生一个 Provider 发送编号。
6. Resend Svix 验签和 SMTP2GO Basic Auth 鉴权失败时，事件不得进入业务事件表。
7. 两家服务分别验证等于有效大小上限和超过一个字节的最终 MIME。
8. 管理页面、初始化、备份、恢复和旧系统迁移均不能创建或重新启用 Cloudflare Email Sending 配置。
