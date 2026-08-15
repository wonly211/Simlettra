# 澄笺 | Simlettra Cloudflare 平台核验

## 文档状态

- 状态：当前技术事实，产品免费额度解释已于 2026-08-11 更新
- 核验日期：2026-08-09
- 资料范围：Cloudflare 官方文档
- 复核要求：进入开发前和每次重要发布前重新核验

## 核验目的

本文档只记录当前平台能力和它们对架构的影响，不把可能变化的套餐数字永久写成产品承诺。

2026-08-11 用户进一步明确：D1、KV 和 R2 的 Cloudflare 免费额度是 Simlettra 的产品资源上限。本文仍保留 Paid 计划信息作为平台事实和冲突分析证据，但 Paid 容量不属于 Simlettra 的产品可用存储。Workers 是否也必须限定为 Free 计划，见[免费资源目标影响评估](免费资源目标影响评估.md)。

## Worker 执行边界

Cloudflare 当前文档显示：

1. Workers Free 的普通 HTTP 请求 CPU 时间为 10 毫秒；Paid 默认 30 秒，普通 Worker 请求当前最大可配置到 5 分钟。
2. 单次 Worker 内存限制为 128 MB。
3. Workers Free 每日请求额度为 100,000 次。
4. Email handler 的 CPU 时间上限列为 30 秒；Queue consumer 默认 30 秒，当前最大可配置到 15 分钟，而且该限制同时适用于 Free 与 Paid 计划。
5. 静态资源请求不计入 Workers 请求额度。

架构影响：D1、KV 和 R2 已确定只使用免费额度，Workers Free 也已确定为首发核心运行基线。20 MB 邮件解析、正文索引、备份和迁移仍必须在真实 Free 环境实测，不能沿用普通 HTTP 请求的 CPU 数据直接下结论；Paid 只能作为可选增强，不能成为隐藏的运行前提。

资料：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

## D1

免费计划当前提供：

| 项目 | 当前限制 |
| --- | ---: |
| 每日读取行数 | 5,000,000 |
| 每日写入行数 | 100,000 |
| 账号总存储 | 5 GB |
| 单数据库大小 | 500 MB |
| 数据库数量 | 10 |
| 单行或单个文本、二进制值 | 2 MB |
| 单次 SQL 语句大小 | 100 KB |

D1 的 `batch()` 会按顺序执行语句，并保证整个批次作为一个事务提交；任一语句失败时整个批次回滚。

D1 支持 SQLite FTS5，但官方导出不会导出虚拟表。搜索索引因此必须被定义为可重建数据，恢复时从权威数据重新生成。

架构影响：

1. D1 保存权威元数据、权限、状态、任务和搜索索引，不保存大正文或附件。
2. 长正文的搜索文本需要分块，避免单行 2 MB 限制。
3. 搜索索引不能是备份恢复的唯一来源。
4. 复杂列表查询必须有针对性索引，避免按总表扫描消耗行读取额度。
5. Free 计划单数据库 500 MB 与账号总存储 5 GB 共同构成产品上限；Simlettra 不使用 Paid 计划扩展 D1 容量。

资料：

- [D1 限制](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 数据库接口与批处理](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 导入与导出](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 FTS5](https://developers.cloudflare.com/d1/sql-api/sql-statements/#create-virtual-table)

## Workers KV

免费计划当前提供：

| 项目 | 当前限制 |
| --- | ---: |
| 每日读取 | 100,000 |
| 每日写入 | 1,000 |
| 每日删除 | 1,000 |
| 每日列举 | 1,000 |
| 总存储 | 1 GB |
| 单个值大小 | 25 MiB |

KV 是最终一致存储；其他地区看到旧值的时间可能达到约 60 秒。

架构影响：

1. KV 只保存以唯一键写入后不再修改的邮件对象，不保存会话、权限、计数器或任务状态。
2. D1 始终决定对象是否对用户可见，因此 KV 的短暂传播延迟不能改变权限和邮件状态。
3. 20 MB 邮件对象必须避免 Base64 膨胀，正文、原始邮件和附件按二进制或独立对象保存。
4. 每日 1,000 次写入使 KV 更适合个人或低写入场景，不应作为推荐的大容量模式。
5. Free 计划 1 GB 存储是产品容量上限；达到后停止新增对象，不自动进入 Paid 用量。

资料：

- [Workers KV 限制](https://developers.cloudflare.com/kv/platform/limits/)
- [Workers KV 一致性模型](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

## R2

当前免费额度包括每月 10 GB 存储、1,000,000 次 A 类操作和 10,000,000 次 B 类操作，直接从 R2 提供对象没有互联网出口流量费。R2 对对象写入、读取和列举提供强一致性。

架构影响：

1. R2 更适合保存原始邮件、正文和附件，应成为推荐部署方式。
2. 强一致性减少了对象刚写入后暂时读取不到的窗口，但仍不能替代 D1 与 R2 之间的跨资源状态机。
3. KV 模式和 R2 模式仍使用同一个对象存储接口，不能分裂成两套业务实现。
4. 标准存储账号级 10 GB-month 免费额度是 Simlettra 的产品容量上限；平台允许的付费扩容不作为产品可用空间。

资料：

- [R2 定价与免费额度](https://developers.cloudflare.com/r2/pricing/)
- [R2 数据一致性](https://developers.cloudflare.com/r2/reference/consistency/)

## Cloudflare Queues

Queues 当前包含每月 1,000,000 次操作的免费额度，按每条消息的写入、读取和确认分别计费；折算后约可处理 333,333 条无重试消息。Free 计划每日还有 10,000 次操作限制。单条消息最大 128 KB，默认保留 24 小时，最长可配置 14 天。

同一个 Worker 脚本可以同时作为队列生产者和消费者，因此增加 Queue 不会违反“单 Worker”部署边界。Queue 是任务传递设施，不是第三种邮件存储模式。

架构影响：

1. Queue 适合唤醒收信解析、外部发信、通知、转发和清理任务。
2. Queue 按至少一次投递理解，消费者必须幂等。
3. D1 中仍要保存任务权威状态；Queue 只负责尽快触发，定时任务负责重新投递遗漏任务。

资料：

- [Queues 限制](https://developers.cloudflare.com/queues/platform/limits/)
- [Queues 定价](https://developers.cloudflare.com/queues/platform/pricing/)
- [同一 Worker 生产和消费](https://developers.cloudflare.com/queues/configuration/configure-queues/)

## 收信与 Cloudflare 发信

1. Email Routing 当前接受的最大邮件大小为 25 MiB，超过时会退回发件方。Simlettra 自身的 20 MB 限制更小，因此保持有效。
2. Email Worker 的 `ForwardableEmailMessage.to` 是单个信封 `RCPT TO`；官方资料没有说明同一 SMTP 邮件含多个本地收件人时的调用数量、顺序或各次原始 MIME 是否逐字节相同。
3. Cloudflare Email Sending 当前处于公开 Beta，只适用于 Workers Paid。
4. 向任意地址发信的常规总邮件大小限制为 5 MiB；发往 Email Routing 已验证目标地址的特殊情形可达到 25 MiB。
5. Cloudflare Email Sending 的投递事件通过 Event Subscriptions 发送到 Cloudflare Queue。

架构影响：

1. 选择 Cloudflare Email Sending 时，网页必须显示实际 5 MiB 限制，不能仍显示 20 MB。
2. 完整接收 Cloudflare 投递状态需要 Queue；Resend 和 SMTP2GO 则通过验证过的 HTTP 回调接入同一事件模型。
3. 用户已于 2026-08-11 决定首发移除 Cloudflare Email Sending。以上限制只作为平台事实和历史决策依据保留，当前产品不提供该 Provider 的配置、发送或事件入口。
4. 多地址收信的事件语义不能仅靠文档关闭，真实验证矩阵见[Cloudflare 多地址收信事件语义核验](../验证/Cloudflare多地址收信事件语义核验.md)。

资料：

- [Email Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Email Routing 规则](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
- [Email Routing 与 Email Sending 限制](https://developers.cloudflare.com/email-service/platform/limits/)
- [Email Sending 限制](https://developers.cloudflare.com/email-service/platform/limits/)
- [Email Sending 定价](https://developers.cloudflare.com/email-service/platform/pricing/)
- [Email Sending 事件订阅](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)

## 其他发信服务

1. Resend 当前允许包含附件后的整封邮件最大 40 MB，并提供幂等键和带签名的 Webhook。
2. SMTP2GO 当前默认最大邮件大小为 50 MB，并提供 Webhook 与事件投递能力。
3. Simlettra 仍使用已确认的 20 MB 自身限制，因此实际限制取 Simlettra 与供应商中的更小值。

资料：

- [Resend 附件限制](https://resend.com/docs/dashboard/emails/attachments)
- [Resend 幂等键](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Resend Webhook 验证](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests)
- [SMTP2GO 邮件大小](https://support.smtp2go.com/hc/en-gb/articles/4406792318873-Maximum-Email-Size-and-Attachment-Limitations)
- [SMTP2GO Webhooks](https://support.smtp2go.com/hc/en-gb/articles/223087627-Webhook-Examples)

## 核验结论

1. `D1 + R2` 应作为默认推荐模式，`D1 + KV` 保留为低写入兼容模式。
2. 单 Worker 内部应同时实现 `fetch`、`email`、`queue` 和 `scheduled` 入口。
3. D1 保存权威状态，KV/R2 保存不可变邮件对象，Queue 只传递任务编号。
4. D1、KV 和 R2 必须限制在免费额度内；首发域外发信只支持 Resend 和 SMTP2GO；Workers Free 是首发核心运行基线，Paid 只能作为可选增强。
5. 中文全文搜索、20 MB 解析和 100,000 封邮件性能的本地验证性原型已经完成；真实 Cloudflare D1 和 Workers Free Queue consumer 仍需验证，其中 20 MB 解析验证是上线门槛。
